//! Wallet snapshot persistence.
//!
//! This module is the on-disk format for the in-process wallet state so the
//! sync doesn't have to start from genesis on every restart. The intent is a
//! *speed* optimisation; correctness still depends on the saved state being
//! consistent with the chain we resume against.
//!
//! ## What's saved
//!
//! - [`Header`]: magic + schema version + network identifier + genesis hash.
//!   Refusing to load with a mismatch keeps a Mainnet snapshot from being
//!   read into a Testnet boot, etc.
//! - The two [`ManualWallet`] instances (miner + user). Owns:
//!   - per-account orchard notes (recv/unspent/spent), transparent txos,
//!     fully-detected/decoded heights, ufvk (encoded as a string)
//!   - per-stream sync heights and addresses
//!   - flat tx list
//! - The orchard [`OrchardShardTree`] -- shards + checkpoints + cap, using
//!   [`zcash_client_backend::serialization::shardtree::{read_shard,
//!   write_shard}`] for the internal pruned tree pieces.
//! - [`PoWCache`]: rolling block hashes used by the wallet for reorg
//!   detection.
//! - An [`AnchorHistory`] (Phase 2): the last few `(height, hash)` pairs at
//!   orchard checkpoint boundaries so on load we can detect a reorg below
//!   the snapshot tip and roll back to the deepest checkpoint that's still
//!   on chain.
//!
//! ## What's deliberately not saved
//!
//! - `WalletTx::staking_action`: complex enum with cryptographic signatures,
//!   only used by the GUI for display labels. Restored as `None`; the
//!   information is rebuilt from chain on next sync.
//! - `ManualAccount::balance_changes`: derivable from notes; we keep just
//!   the genesis-zero entry on load and let the sync rebuild history.
//! - `RosterMember`: re-fetched from chain at startup anyway.
//!
//! ## Atomicity
//!
//! [`save`] writes to `<path>.tmp`, fsyncs, and renames over the destination
//! so a crash mid-write leaves either the previous snapshot or the new one
//! -- never a torn file. [`load`] verifies the header before allocating
//! anything; a stale or corrupted file is reported via [`PersistError`] and
//! the caller is expected to fall back to a full sync.
//!
//! ## Wipe-on-next-start
//!
//! [`wipe_marker_path`] returns the marker file the sidecar's
//! `wipe-snapshot` RPC writes. On startup, the wallet checks for it and if
//! present deletes the snapshot + marker before loading.

use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use byteorder::{LittleEndian as LE, ReadBytesExt, WriteBytesExt};
use incrementalmerkletree::{Address as TreeAddress, Level, Position};
use orchard::tree::MerkleHashOrchard;
use shardtree::{
    LocatedPrunableTree, ShardTree,
    store::{Checkpoint, ShardStore, TreeState, memory::MemoryShardStore},
};
use zcash_client_backend::serialization::shardtree::{read_shard, write_shard};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::merkle_tree::HashSer;
use zcash_primitives::transaction::{StakingAction, StakingActionKind, TxId};
use zcash_protocol::consensus::{Network, NetworkType};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::TransparentAddress;
use zcash_transparent::bundle::OutPoint;

// Re-import the wallet's own types from the parent module.
use super::{
    BlockHeight, ManualAccount, ManualStream, ManualWallet, OrchardNote, PoWCache, Txo, WalletTx,
    WalletTxPart,
};

// ---------------------------------------------------------------------------
// Public layout / errors
// ---------------------------------------------------------------------------

/// 8-byte magic marking a Crosslink wallet snapshot.
const MAGIC: [u8; 8] = *b"CRSLNKW\x01";

/// Bump this whenever the on-disk layout changes incompatibly. A snapshot
/// with a mismatched version is rejected (loader returns
/// [`PersistError::SchemaMismatch`]) and the caller falls back to a fresh
/// sync.
///
/// v1 (initial): everything except `WalletTx::staking_action` was persisted.
///   The wallet's `kind()` method depends on `staking_action` to label stake
///   transactions correctly, so a snapshot from v1 lost the "Stake" label
///   on reload (it showed up as "Returning…" / SelfSend instead). The
///   `Staked` balance line was also wrong because `stake_positions_bonded`
///   walks `wallet.txs` looking for CreateNewDelegationBond actions.
///
/// v2: persist `staking_action` as a fixed-layout struct.
pub const SCHEMA_VERSION: u32 = 2;

/// Maximum past anchors retained for reorg walkback.
const ANCHOR_HISTORY_CAP: usize = 32;

/// File names placed inside the wallet snapshot directory.
const SNAPSHOT_FILE: &str = "wallet_snapshot.bin";
const WIPE_MARKER_FILE: &str = "wallet_snapshot.wipe-on-next-start";

/// Where the snapshot lives (a sibling of the zebra-state cache).
pub fn snapshot_path(base: &Path) -> PathBuf {
    base.join(SNAPSHOT_FILE)
}

/// Marker the sidecar/CLI drops to ask the wallet to discard its snapshot
/// on the next launch.
pub fn wipe_marker_path(base: &Path) -> PathBuf {
    base.join(WIPE_MARKER_FILE)
}

#[derive(Debug)]
pub enum PersistError {
    Io(std::io::Error),
    BadMagic,
    SchemaMismatch { found: u32, expected: u32 },
    NetworkMismatch { found: String, expected: String },
    GenesisMismatch { found: [u8; 32], expected: [u8; 32] },
    Truncated,
    InvalidValue(&'static str),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "io: {e}"),
            Self::BadMagic => write!(f, "bad magic header (not a wallet snapshot)"),
            Self::SchemaMismatch { found, expected } => {
                write!(f, "schema version mismatch (found {found}, expected {expected})")
            }
            Self::NetworkMismatch { found, expected } => {
                write!(f, "network mismatch (found {found:?}, expected {expected:?})")
            }
            Self::GenesisMismatch { .. } => write!(f, "genesis hash mismatch"),
            Self::Truncated => write!(f, "snapshot file truncated"),
            Self::InvalidValue(msg) => write!(f, "invalid value: {msg}"),
        }
    }
}

impl std::error::Error for PersistError {}

impl From<std::io::Error> for PersistError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            PersistError::Truncated
        } else {
            PersistError::Io(e)
        }
    }
}

type Result<T> = std::result::Result<T, PersistError>;

/// Anchor: a confirmed `(height, block_hash)` pair we can fall back to on
/// reorg detection. `sync_h_per_stream` is parallel to
/// `WalletState.{miner,user}_wallet.strms` -- one entry per stream in the
/// order they're appended. Stored alongside the snapshot so the loader can
/// truncate the orchard tree to the deepest still-valid checkpoint without
/// having to re-derive the per-stream heights.
#[derive(Debug, Clone)]
pub struct Anchor {
    pub height: u32,
    pub hash: [u8; 32],
    /// `[miner_streams_n_count, miner_strm_0_h, miner_strm_1_h, ..., user_streams_n_count, user_strm_0_h, ...]`
    /// Two leading u8 counts then the heights themselves; flat for serialization.
    pub stream_heights: Vec<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct AnchorHistory {
    pub anchors: VecDeque<Anchor>,
}

impl AnchorHistory {
    pub fn push(&mut self, a: Anchor) {
        self.anchors.push_back(a);
        while self.anchors.len() > ANCHOR_HISTORY_CAP {
            self.anchors.pop_front();
        }
    }
}

/// Top-level snapshot bundle. Everything we save and load lives here.
pub struct Snapshot<'a> {
    pub network_type: NetworkType,
    pub genesis_hash: [u8; 32],
    pub miner_wallet: &'a ManualWallet,
    pub user_wallet: &'a ManualWallet,
    pub orchard_tree_blob: Vec<u8>,
    pub pow_cache: &'a PoWCache,
    pub anchors: &'a AnchorHistory,
}

/// Parsed snapshot returned from [`load`]. Owns its data so the caller can
/// drop the file handle.
pub struct LoadedSnapshot {
    pub network_type: NetworkType,
    pub genesis_hash: [u8; 32],
    pub miner_wallet: ManualWallet,
    pub user_wallet: ManualWallet,
    pub orchard_tree: super::OrchardShardTree,
    pub pow_cache: PoWCache,
    pub anchors: AnchorHistory,
}

// ---------------------------------------------------------------------------
// Top-level save / load / wipe
// ---------------------------------------------------------------------------

/// Atomically write the snapshot to `<path>` via a `.tmp` rename.
pub fn save(path: &Path, snap: &Snapshot<'_>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(PersistError::Io)?;
    }
    let tmp = with_extension(path, "tmp");
    {
        let f = std::fs::File::create(&tmp)?;
        let mut w = BufWriter::new(f);
        write_header(&mut w, snap.network_type, &snap.genesis_hash)?;
        write_manual_wallet(&mut w, snap.miner_wallet, snap.network_type)?;
        write_manual_wallet(&mut w, snap.user_wallet, snap.network_type)?;
        write_pow_cache(&mut w, snap.pow_cache)?;
        write_anchors(&mut w, snap.anchors)?;
        write_blob(&mut w, &snap.orchard_tree_blob)?;
        w.flush()?;
        w.into_inner()
            .map_err(|e| PersistError::Io(e.into_error()))?
            .sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Read and verify a snapshot. Returns [`PersistError::Truncated`] /
/// [`PersistError::SchemaMismatch`] / etc. on incompatibility -- the caller
/// is expected to wipe and full-resync in those cases.
pub fn load(
    path: &Path,
    expected_network: NetworkType,
    expected_genesis: &[u8; 32],
) -> Result<LoadedSnapshot> {
    let f = std::fs::File::open(path)?;
    let mut r = BufReader::new(f);
    let (net, gen) = read_header(&mut r)?;
    if net != expected_network {
        return Err(PersistError::NetworkMismatch {
            found: format!("{net:?}"),
            expected: format!("{expected_network:?}"),
        });
    }
    if &gen != expected_genesis {
        return Err(PersistError::GenesisMismatch {
            found: gen,
            expected: *expected_genesis,
        });
    }
    let miner_wallet = read_manual_wallet(&mut r, net, "miner_wallet")?;
    let user_wallet = read_manual_wallet(&mut r, net, "user_wallet")?;
    let pow_cache = read_pow_cache(&mut r)?;
    let anchors = read_anchors(&mut r)?;
    let blob = read_blob(&mut r)?;
    let orchard_tree = read_orchard_tree(&blob[..])?;
    Ok(LoadedSnapshot {
        network_type: net,
        genesis_hash: gen,
        miner_wallet,
        user_wallet,
        orchard_tree,
        pow_cache,
        anchors,
    })
}

/// Serialize an [`super::OrchardShardTree`] to a `Vec<u8>` so that callers
/// can save it independently (e.g. during a periodic mid-sync save when
/// they don't want to hold the rest of the wallet locked while we copy).
pub fn serialize_orchard_tree(tree: &mut super::OrchardShardTree) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(64 * 1024);
    write_orchard_tree(&mut buf, tree)?;
    Ok(buf)
}

/// If the wipe marker exists, remove it AND any existing snapshot file.
/// Returns `Ok(true)` if a wipe was performed.
pub fn process_wipe_marker(base: &Path) -> std::io::Result<bool> {
    let marker = wipe_marker_path(base);
    if !marker.exists() {
        return Ok(false);
    }
    let snap = snapshot_path(base);
    let _ = std::fs::remove_file(&snap); // best-effort
    let _ = std::fs::remove_file(with_extension(&snap, "tmp"));
    std::fs::remove_file(&marker)?;
    Ok(true)
}

/// Drop a wipe marker so the next wallet startup discards its snapshot.
pub fn drop_wipe_marker(base: &Path) -> std::io::Result<()> {
    if let Some(parent) = base.parent() {
        std::fs::create_dir_all(parent)?;
    } else {
        std::fs::create_dir_all(base)?;
    }
    let marker = wipe_marker_path(base);
    let mut f = std::fs::File::create(&marker)?;
    f.write_all(b"wipe")?;
    f.sync_all()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

fn write_header<W: Write>(w: &mut W, net: NetworkType, genesis: &[u8; 32]) -> Result<()> {
    w.write_all(&MAGIC)?;
    w.write_u32::<LE>(SCHEMA_VERSION)?;
    write_network(w, net)?;
    w.write_all(genesis)?;
    Ok(())
}

fn read_header<R: Read>(r: &mut R) -> Result<(NetworkType, [u8; 32])> {
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(PersistError::BadMagic);
    }
    let version = r.read_u32::<LE>()?;
    if version != SCHEMA_VERSION {
        return Err(PersistError::SchemaMismatch {
            found: version,
            expected: SCHEMA_VERSION,
        });
    }
    let net = read_network(r)?;
    let mut genesis = [0u8; 32];
    r.read_exact(&mut genesis)?;
    Ok((net, genesis))
}

fn write_network<W: Write>(w: &mut W, net: NetworkType) -> Result<()> {
    let tag = match net {
        NetworkType::Main => 0u8,
        NetworkType::Test => 1u8,
        NetworkType::Regtest => 2u8,
    };
    w.write_u8(tag)?;
    Ok(())
}

fn read_network<R: Read>(r: &mut R) -> Result<NetworkType> {
    Ok(match r.read_u8()? {
        0 => NetworkType::Main,
        1 => NetworkType::Test,
        2 => NetworkType::Regtest,
        n => return Err(PersistError::InvalidValue(network_tag_msg(n))),
    })
}

fn network_tag_msg(_n: u8) -> &'static str {
    "unknown network type"
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

fn write_blob<W: Write>(w: &mut W, b: &[u8]) -> Result<()> {
    w.write_u64::<LE>(b.len() as u64)?;
    w.write_all(b)?;
    Ok(())
}

fn read_blob<R: Read>(r: &mut R) -> Result<Vec<u8>> {
    let n = r.read_u64::<LE>()? as usize;
    const MAX_BLOB_SIZE: usize = 256 * 1024 * 1024; // 256 MiB sanity cap
    if n > MAX_BLOB_SIZE {
        return Err(PersistError::InvalidValue("blob too large"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_string<W: Write>(w: &mut W, s: &str) -> Result<()> {
    write_blob(w, s.as_bytes())
}

fn read_string<R: Read>(r: &mut R) -> Result<String> {
    let buf = read_blob(r)?;
    String::from_utf8(buf).map_err(|_| PersistError::InvalidValue("non-utf8 string"))
}

fn write_block_height<W: Write>(w: &mut W, h: BlockHeight) -> Result<()> {
    w.write_u32::<LE>(h.0)?;
    Ok(())
}

fn read_block_height<R: Read>(r: &mut R) -> Result<BlockHeight> {
    Ok(BlockHeight(r.read_u32::<LE>()?))
}

fn write_opt_block_height<W: Write>(w: &mut W, h: Option<BlockHeight>) -> Result<()> {
    match h {
        Some(h) => {
            w.write_u8(1)?;
            write_block_height(w, h)
        }
        None => Ok(w.write_u8(0)?),
    }
}

fn read_opt_block_height<R: Read>(r: &mut R) -> Result<Option<BlockHeight>> {
    Ok(match r.read_u8()? {
        0 => None,
        1 => Some(read_block_height(r)?),
        _ => return Err(PersistError::InvalidValue("bad option tag")),
    })
}

fn write_zats<W: Write>(w: &mut W, z: Zatoshis) -> Result<()> {
    w.write_u64::<LE>(z.into_u64())?;
    Ok(())
}

fn read_zats<R: Read>(r: &mut R) -> Result<Zatoshis> {
    let v = r.read_u64::<LE>()?;
    Zatoshis::from_u64(v).map_err(|_| PersistError::InvalidValue("bad zatoshis"))
}

fn write_txid<W: Write>(w: &mut W, txid: &TxId) -> Result<()> {
    w.write_all(txid.as_ref())?;
    Ok(())
}

fn read_txid<R: Read>(r: &mut R) -> Result<TxId> {
    let mut buf = [0u8; 32];
    r.read_exact(&mut buf)?;
    Ok(TxId::from_bytes(buf))
}

fn write_b32<W: Write>(w: &mut W, b: &[u8; 32]) -> Result<()> {
    w.write_all(b)?;
    Ok(())
}

fn read_b32<R: Read>(r: &mut R) -> Result<[u8; 32]> {
    let mut buf = [0u8; 32];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_b20<W: Write>(w: &mut W, b: &[u8; 20]) -> Result<()> {
    w.write_all(b)?;
    Ok(())
}

fn read_b20<R: Read>(r: &mut R) -> Result<[u8; 20]> {
    let mut buf = [0u8; 20];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_position<W: Write>(w: &mut W, p: Position) -> Result<()> {
    w.write_u64::<LE>(u64::from(p))?;
    Ok(())
}

fn read_position<R: Read>(r: &mut R) -> Result<Position> {
    Ok(Position::from(r.read_u64::<LE>()?))
}

// ---------------------------------------------------------------------------
// Transparent + UFVK
// ---------------------------------------------------------------------------

fn write_transparent_address<W: Write>(w: &mut W, addr: &TransparentAddress) -> Result<()> {
    match addr {
        TransparentAddress::PublicKeyHash(h) => {
            w.write_u8(0)?;
            write_b20(w, h)
        }
        TransparentAddress::ScriptHash(h) => {
            w.write_u8(1)?;
            write_b20(w, h)
        }
    }
}

fn read_transparent_address<R: Read>(r: &mut R) -> Result<TransparentAddress> {
    Ok(match r.read_u8()? {
        0 => TransparentAddress::PublicKeyHash(read_b20(r)?),
        1 => TransparentAddress::ScriptHash(read_b20(r)?),
        _ => return Err(PersistError::InvalidValue("bad transparent address tag")),
    })
}

fn write_ufvk<W: Write>(w: &mut W, ufvk: &UnifiedFullViewingKey, net: NetworkType) -> Result<()> {
    let params = network_for(net);
    write_string(w, &ufvk.encode(&params))
}

fn read_ufvk<R: Read>(r: &mut R, net: NetworkType) -> Result<UnifiedFullViewingKey> {
    let params = network_for(net);
    let s = read_string(r)?;
    UnifiedFullViewingKey::decode(&params, &s)
        .map_err(|_| PersistError::InvalidValue("bad ufvk"))
}

fn network_for(net: NetworkType) -> Network {
    match net {
        NetworkType::Main => Network::MainNetwork,
        NetworkType::Test => Network::TestNetwork,
        NetworkType::Regtest => Network::TestNetwork, // closest match
    }
}

// ---------------------------------------------------------------------------
// Txo
// ---------------------------------------------------------------------------

fn write_txo<W: Write>(w: &mut W, t: &Txo) -> Result<()> {
    write_block_height(w, t.recv_h)?;
    write_block_height(w, t.spent_h)?;
    let txid_bytes: [u8; 32] = t.id.txid().as_ref().clone();
    write_b32(w, &txid_bytes)?;
    w.write_u32::<LE>(t.id.n())?;
    write_zats(w, t.value)?;
    write_transparent_address(w, &t.t_addr)
}

fn read_txo<R: Read>(r: &mut R) -> Result<Txo> {
    let recv_h = read_block_height(r)?;
    let spent_h = read_block_height(r)?;
    let txid_bytes = read_b32(r)?;
    let n = r.read_u32::<LE>()?;
    let value = read_zats(r)?;
    let t_addr = read_transparent_address(r)?;
    Ok(Txo {
        recv_h,
        spent_h,
        id: OutPoint::new(txid_bytes, n),
        value,
        t_addr,
    })
}

// ---------------------------------------------------------------------------
// OrchardNote
// ---------------------------------------------------------------------------

fn write_orchard_note<W: Write>(w: &mut W, n: &OrchardNote) -> Result<()> {
    write_block_height(w, n.recv_h)?;
    write_block_height(w, n.spent_h)?;
    write_b32(w, &n.nf.to_bytes())?;
    write_txid(w, &n.txid)?;
    let recipient = n.note.recipient().to_raw_address_bytes(); // [u8; 43]
    w.write_all(&recipient)?;
    w.write_u64::<LE>(n.note.value().inner())?;
    w.write_all(&n.note.rho().to_bytes())?; // [u8; 32]
    w.write_all(n.note.rseed().as_bytes())?; // [u8; 32]
    write_position(w, n.position)?;
    Ok(())
}

fn read_orchard_note<R: Read>(r: &mut R) -> Result<OrchardNote> {
    let recv_h = read_block_height(r)?;
    let spent_h = read_block_height(r)?;
    let nf_bytes = read_b32(r)?;
    let nf = Option::from(orchard::note::Nullifier::from_bytes(&nf_bytes))
        .ok_or(PersistError::InvalidValue("bad orchard nullifier"))?;
    let txid = read_txid(r)?;

    let mut recipient_bytes = [0u8; 43];
    r.read_exact(&mut recipient_bytes)?;
    let recipient = Option::from(orchard::Address::from_raw_address_bytes(&recipient_bytes))
        .ok_or(PersistError::InvalidValue("bad orchard recipient"))?;

    let value_raw = r.read_u64::<LE>()?;
    let value = orchard::value::NoteValue::from_raw(value_raw);

    let rho_bytes = read_b32(r)?;
    let rho = Option::from(orchard::note::Rho::from_bytes(&rho_bytes))
        .ok_or(PersistError::InvalidValue("bad orchard rho"))?;

    let rseed_bytes = read_b32(r)?;
    let rseed = Option::from(orchard::note::RandomSeed::from_bytes(rseed_bytes, &rho))
        .ok_or(PersistError::InvalidValue("bad orchard rseed"))?;

    let note = Option::from(orchard::note::Note::from_parts(recipient, value, rho, rseed))
        .ok_or(PersistError::InvalidValue("invalid orchard note components"))?;

    let position = read_position(r)?;
    Ok(OrchardNote {
        recv_h,
        spent_h,
        nf,
        txid,
        note,
        position,
    })
}

// ---------------------------------------------------------------------------
// WalletTx
// ---------------------------------------------------------------------------

fn write_wallet_tx_part<W: Write>(w: &mut W, p: &WalletTxPart) -> Result<()> {
    w.write_u64::<LE>(p.spent_note_count as u64)?;
    write_zats(w, p.spent_zats)?;
    w.write_u64::<LE>(p.sent_note_count as u64)?;
    write_zats(w, p.sent_zats)?;
    w.write_u64::<LE>(p.recv_note_count as u64)?;
    write_zats(w, p.recv_zats)?;
    Ok(())
}

fn read_wallet_tx_part<R: Read>(r: &mut R) -> Result<WalletTxPart> {
    Ok(WalletTxPart {
        spent_note_count: r.read_u64::<LE>()? as usize,
        spent_zats: read_zats(r)?,
        sent_note_count: r.read_u64::<LE>()? as usize,
        sent_zats: read_zats(r)?,
        recv_note_count: r.read_u64::<LE>()? as usize,
        recv_zats: read_zats(r)?,
    })
}

fn write_wallet_tx<W: Write>(w: &mut W, t: &WalletTx) -> Result<()> {
    w.write_u64::<LE>(t.account_id as u64)?;
    write_txid(w, &t.txid)?;
    write_opt_block_height(w, t.expiry_h)?;
    write_block_height(w, t.h)?;
    w.write_u8(t.is_coinbase as u8)?;
    w.write_u8(t.part_flags)?;
    for p in &t.parts {
        write_wallet_tx_part(w, p)?;
    }
    w.write_u64::<LE>(t.memo_count as u64)?;
    w.write_all(&t.memo)?;
    write_tx_status(w, &t.status)?;
    write_opt_staking_action(w, &t.staking_action)?;
    Ok(())
}

fn read_wallet_tx<R: Read>(r: &mut R) -> Result<WalletTx> {
    let account_id = r.read_u64::<LE>()? as usize;
    let txid = read_txid(r)?;
    let expiry_h = read_opt_block_height(r)?;
    let h = read_block_height(r)?;
    let is_coinbase = r.read_u8()? != 0;
    let part_flags = r.read_u8()?;
    let parts = [read_wallet_tx_part(r)?, read_wallet_tx_part(r)?];
    let memo_count = r.read_u64::<LE>()? as usize;
    let mut memo = [0u8; 512];
    r.read_exact(&mut memo)?;
    let status = read_tx_status(r)?;
    let staking_action = read_opt_staking_action(r)?;
    Ok(WalletTx {
        account_id,
        txid,
        expiry_h,
        h,
        is_coinbase,
        part_flags,
        parts,
        memo_count,
        memo,
        status,
        staking_action,
    })
}

// --- StakingAction -------------------------------------------------------
//
// `StakingAction` is a single fixed-layout struct (see
// `librustzcash::zcash_primitives::transaction::StakingAction`):
//
//     kind: StakingActionKind   (u8 via Into<u8>/TryFrom<u8>)
//     amount_zats: u64
//     arg32_0..arg32_3: [u8; 32]    (4 of them)
//     arg64_0, arg64_1: [u8; 64]    (signatures / extra-large fields)
//
// We dump it byte-for-byte; no variant union to worry about.

fn write_staking_action<W: Write>(w: &mut W, sa: &StakingAction) -> Result<()> {
    w.write_u8(u8::from(sa.kind))?;
    w.write_u64::<LE>(sa.amount_zats)?;
    w.write_all(&sa.arg32_0)?;
    w.write_all(&sa.arg32_1)?;
    w.write_all(&sa.arg32_2)?;
    w.write_all(&sa.arg32_3)?;
    w.write_all(&sa.arg64_0)?;
    w.write_all(&sa.arg64_1)?;
    Ok(())
}

fn read_staking_action<R: Read>(r: &mut R) -> Result<StakingAction> {
    let kind_byte = r.read_u8()?;
    let kind = StakingActionKind::try_from(kind_byte)
        .map_err(|_| PersistError::InvalidValue("bad staking action kind"))?;
    let amount_zats = r.read_u64::<LE>()?;
    let mut arg32_0 = [0u8; 32];
    r.read_exact(&mut arg32_0)?;
    let mut arg32_1 = [0u8; 32];
    r.read_exact(&mut arg32_1)?;
    let mut arg32_2 = [0u8; 32];
    r.read_exact(&mut arg32_2)?;
    let mut arg32_3 = [0u8; 32];
    r.read_exact(&mut arg32_3)?;
    let mut arg64_0 = [0u8; 64];
    r.read_exact(&mut arg64_0)?;
    let mut arg64_1 = [0u8; 64];
    r.read_exact(&mut arg64_1)?;
    Ok(StakingAction {
        kind,
        amount_zats,
        arg32_0,
        arg32_1,
        arg32_2,
        arg32_3,
        arg64_0,
        arg64_1,
    })
}

fn write_opt_staking_action<W: Write>(w: &mut W, sa: &Option<StakingAction>) -> Result<()> {
    match sa {
        Some(a) => {
            w.write_u8(1)?;
            write_staking_action(w, a)
        }
        None => Ok(w.write_u8(0)?),
    }
}

fn read_opt_staking_action<R: Read>(r: &mut R) -> Result<Option<StakingAction>> {
    Ok(match r.read_u8()? {
        0 => None,
        1 => Some(read_staking_action(r)?),
        _ => return Err(PersistError::InvalidValue("bad option tag (staking_action)")),
    })
}

fn write_tx_status<W: Write>(w: &mut W, s: &super::TxStatus) -> Result<()> {
    use super::TxStatus;
    match s {
        TxStatus::OnBc => {
            w.write_u8(0)?;
        }
        TxStatus::SoftFail(h) => {
            w.write_u8(1)?;
            write_block_height(w, *h)?;
        }
        TxStatus::HardFail(h, errbuf) => {
            w.write_u8(2)?;
            write_block_height(w, *h)?;
            w.write_all(&errbuf.0)?;
        }
    }
    Ok(())
}

fn read_tx_status<R: Read>(r: &mut R) -> Result<super::TxStatus> {
    use super::TxStatus;
    Ok(match r.read_u8()? {
        0 => TxStatus::OnBc,
        1 => TxStatus::SoftFail(read_block_height(r)?),
        2 => {
            let h = read_block_height(r)?;
            let mut buf = [0u8; 128];
            r.read_exact(&mut buf)?;
            TxStatus::HardFail(h, super::ErrBuf(buf))
        }
        _ => return Err(PersistError::InvalidValue("bad tx_status tag")),
    })
}

// ---------------------------------------------------------------------------
// ManualAccount / ManualStream / ManualWallet
// ---------------------------------------------------------------------------

fn write_manual_stream<W: Write>(w: &mut W, s: &ManualStream) -> Result<()> {
    w.write_u64::<LE>(s.account_id as u64)?;
    write_block_height(w, s.sync_h)?;
    write_transparent_address(w, &s.t_addr)
}

fn read_manual_stream<R: Read>(r: &mut R) -> Result<ManualStream> {
    Ok(ManualStream {
        account_id: r.read_u64::<LE>()? as usize,
        sync_h: read_block_height(r)?,
        t_addr: read_transparent_address(r)?,
    })
}

fn write_manual_account<W: Write>(
    w: &mut W,
    a: &ManualAccount,
    net: NetworkType,
) -> Result<()> {
    write_block_height(w, a.fully_detected_h)?;
    write_block_height(w, a.fully_decoded_h)?;
    write_ufvk(w, &a.ufvk, net)?;
    write_block_height(w, a.birthday)?;
    // balance_changes intentionally not persisted (recomputed from notes).
    write_vec(w, &a.recv_txos, write_txo)?;
    write_vec(w, &a.utxos, write_txo)?;
    write_vec(w, &a.stxos, write_txo)?;
    write_vec(w, &a.recv_orchard_notes, write_orchard_note)?;
    write_vec(w, &a.unspent_orchard_notes, write_orchard_note)?;
    write_vec(w, &a.spent_orchard_notes, write_orchard_note)?;
    Ok(())
}

fn read_manual_account<R: Read>(r: &mut R, net: NetworkType) -> Result<ManualAccount> {
    use zcash_client_backend::data_api::AccountBalance;
    let fully_detected_h = read_block_height(r)?;
    let fully_decoded_h = read_block_height(r)?;
    let ufvk = read_ufvk(r, net)?;
    let birthday = read_block_height(r)?;
    let recv_txos = read_vec(r, read_txo)?;
    let utxos = read_vec(r, read_txo)?;
    let stxos = read_vec(r, read_txo)?;
    let recv_orchard_notes = read_vec(r, read_orchard_note)?;
    let unspent_orchard_notes = read_vec(r, read_orchard_note)?;
    let spent_orchard_notes = read_vec(r, read_orchard_note)?;
    Ok(ManualAccount {
        fully_detected_h,
        fully_decoded_h,
        ufvk,
        birthday,
        balance_changes: vec![(BlockHeight(0), AccountBalance::ZERO)],
        recv_txos,
        utxos,
        stxos,
        recv_orchard_notes,
        unspent_orchard_notes,
        spent_orchard_notes,
    })
}

fn write_manual_wallet<W: Write>(
    w: &mut W,
    mw: &ManualWallet,
    net: NetworkType,
) -> Result<()> {
    write_string(w, mw.name)?;
    write_block_height(w, mw.chain_tip_h)?;
    write_vec(w, &mw.accounts, |w, a| write_manual_account(w, a, net))?;
    write_vec(w, &mw.strms, write_manual_stream)?;
    write_vec(w, &mw.txs, write_wallet_tx)?;
    // tx_h_map is rebuilt from txs.
    write_hashmap_b32_u64(w, &mw.seen_bond_values)?;
    write_vec(w, &mw.care_about_bonds, write_b32)?;
    Ok(())
}

fn read_manual_wallet<R: Read>(
    r: &mut R,
    net: NetworkType,
    static_name: &'static str,
) -> Result<ManualWallet> {
    let _name = read_string(r)?;
    let chain_tip_h = read_block_height(r)?;
    let accounts = read_vec(r, |r| read_manual_account(r, net))?;
    let strms = read_vec(r, read_manual_stream)?;
    let txs = read_vec(r, read_wallet_tx)?;
    let mut tx_h_map = HashMap::with_capacity(txs.len());
    for t in &txs {
        tx_h_map.insert(t.txid, t.h);
    }
    let seen_bond_values = read_hashmap_b32_u64(r)?;
    let care_about_bonds = read_vec(r, read_b32)?;
    Ok(ManualWallet {
        name: static_name,
        accounts,
        strms,
        chain_tip_h,
        txs,
        tx_h_map,
        seen_bond_values,
        care_about_bonds,
    })
}

// ---------------------------------------------------------------------------
// Vec / HashMap helpers
// ---------------------------------------------------------------------------

fn write_vec<W: Write, T, F>(w: &mut W, v: &[T], mut writer: F) -> Result<()>
where
    F: FnMut(&mut W, &T) -> Result<()>,
{
    w.write_u64::<LE>(v.len() as u64)?;
    for item in v {
        writer(w, item)?;
    }
    Ok(())
}

fn read_vec<R: Read, T, F>(r: &mut R, mut reader: F) -> Result<Vec<T>>
where
    F: FnMut(&mut R) -> Result<T>,
{
    let n = r.read_u64::<LE>()? as usize;
    let mut v = Vec::with_capacity(n.min(1024 * 1024));
    for _ in 0..n {
        v.push(reader(r)?);
    }
    Ok(v)
}

fn write_hashmap_b32_u64<W: Write>(w: &mut W, m: &HashMap<[u8; 32], u64>) -> Result<()> {
    w.write_u64::<LE>(m.len() as u64)?;
    for (k, v) in m {
        write_b32(w, k)?;
        w.write_u64::<LE>(*v)?;
    }
    Ok(())
}

fn read_hashmap_b32_u64<R: Read>(r: &mut R) -> Result<HashMap<[u8; 32], u64>> {
    let n = r.read_u64::<LE>()? as usize;
    let mut m = HashMap::with_capacity(n.min(1024 * 1024));
    for _ in 0..n {
        let k = read_b32(r)?;
        let v = r.read_u64::<LE>()?;
        m.insert(k, v);
    }
    Ok(m)
}

// ---------------------------------------------------------------------------
// PoWCache
// ---------------------------------------------------------------------------

fn write_pow_cache<W: Write>(w: &mut W, c: &PoWCache) -> Result<()> {
    w.write_u64::<LE>(c.next_tip_h)?;
    write_vec(w, &c.hashes, |w, h| write_b32(w, h))?;
    Ok(())
}

fn read_pow_cache<R: Read>(r: &mut R) -> Result<PoWCache> {
    let next_tip_h = r.read_u64::<LE>()?;
    let hashes = read_vec(r, read_b32)?;
    Ok(PoWCache { hashes, next_tip_h })
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

fn write_anchor<W: Write>(w: &mut W, a: &Anchor) -> Result<()> {
    w.write_u32::<LE>(a.height)?;
    write_b32(w, &a.hash)?;
    w.write_u64::<LE>(a.stream_heights.len() as u64)?;
    for h in &a.stream_heights {
        w.write_u32::<LE>(*h)?;
    }
    Ok(())
}

fn read_anchor<R: Read>(r: &mut R) -> Result<Anchor> {
    let height = r.read_u32::<LE>()?;
    let hash = read_b32(r)?;
    let n = r.read_u64::<LE>()? as usize;
    let mut stream_heights = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        stream_heights.push(r.read_u32::<LE>()?);
    }
    Ok(Anchor {
        height,
        hash,
        stream_heights,
    })
}

fn write_anchors<W: Write>(w: &mut W, h: &AnchorHistory) -> Result<()> {
    w.write_u64::<LE>(h.anchors.len() as u64)?;
    for a in &h.anchors {
        write_anchor(w, a)?;
    }
    Ok(())
}

fn read_anchors<R: Read>(r: &mut R) -> Result<AnchorHistory> {
    let n = r.read_u64::<LE>()? as usize;
    let mut anchors = VecDeque::with_capacity(n.min(ANCHOR_HISTORY_CAP * 4));
    for _ in 0..n {
        anchors.push_back(read_anchor(r)?);
    }
    Ok(AnchorHistory { anchors })
}

// ---------------------------------------------------------------------------
// OrchardShardTree
// ---------------------------------------------------------------------------

/// Specialised on the wallet's exact `OrchardShardTree` so we don't have to
/// drag generic constraints around. Layout mirrors the pepper-sync /
/// zcash_client_backend serialization conventions.
fn write_orchard_tree<W: Write>(
    w: &mut W,
    shardtree: &mut super::OrchardShardTree,
) -> std::io::Result<()> {
    // Move the existing store out so we can read from it in two passes;
    // restore it (or an empty one on error) at the end. This is the same
    // pattern pepper-sync uses.
    let mut store = std::mem::replace(
        shardtree,
        ShardTree::new(MemoryShardStore::empty(), 0),
    )
    .into_store();

    let outcome = (|| -> std::io::Result<()> {
        // shards
        let roots = store.get_shard_roots().expect("infallible");
        w.write_u64::<LE>(roots.len() as u64)?;
        for root in &roots {
            w.write_u8(u8::from(root.level()))?;
            w.write_u64::<LE>(root.index())?;
            let shard = store
                .get_shard(*root)
                .expect("infallible")
                .expect("missing shard for advertised root");
            write_shard(w, shard.root())?;
        }

        // checkpoints
        let mut checkpoints: Vec<(BlockHeight, Checkpoint)> = Vec::new();
        store
            .with_checkpoints(usize::MAX, |id, c| {
                checkpoints.push((*id, c.clone()));
                Ok(())
            })
            .expect("infallible");
        w.write_u64::<LE>(checkpoints.len() as u64)?;
        for (cid, cp) in &checkpoints {
            w.write_u32::<LE>(cid.0)?;
            match cp.tree_state() {
                TreeState::Empty => w.write_u8(0)?,
                TreeState::AtPosition(p) => {
                    w.write_u8(1)?;
                    w.write_u64::<LE>(u64::from(p))?;
                }
            }
            let marks: Vec<&Position> = cp.marks_removed().iter().collect();
            w.write_u64::<LE>(marks.len() as u64)?;
            for m in marks {
                w.write_u64::<LE>(u64::from(*m))?;
            }
        }

        // cap
        let cap = store.get_cap().expect("infallible");
        write_shard(w, &cap)?;
        Ok(())
    })();

    *shardtree = ShardTree::new(store, super::ORCHARD_REORG_DEPTH);
    outcome
}

fn read_orchard_tree(buf: &[u8]) -> Result<super::OrchardShardTree> {
    let mut r = std::io::Cursor::new(buf);
    let mut store: MemoryShardStore<MerkleHashOrchard, BlockHeight> = MemoryShardStore::empty();

    let n_shards = r.read_u64::<LE>()? as usize;
    for _ in 0..n_shards {
        let level = Level::from(r.read_u8()?);
        let index = r.read_u64::<LE>()?;
        let root_addr = TreeAddress::from_parts(level, index);
        let shard = read_shard(&mut r)
            .map_err(|_| PersistError::InvalidValue("bad shard data"))?;
        let located = LocatedPrunableTree::from_parts(root_addr, shard)
            .map_err(|_| PersistError::InvalidValue("shard root level / address mismatch"))?;
        store
            .put_shard(located)
            .map_err(|_| PersistError::InvalidValue("put_shard failed"))?;
    }

    let n_cps = r.read_u64::<LE>()? as usize;
    for _ in 0..n_cps {
        let cid = BlockHeight(r.read_u32::<LE>()?);
        let tree_state = match r.read_u8()? {
            0 => TreeState::Empty,
            1 => TreeState::AtPosition(Position::from(r.read_u64::<LE>()?)),
            _ => return Err(PersistError::InvalidValue("bad treestate tag")),
        };
        let n_marks = r.read_u64::<LE>()? as usize;
        let mut marks = std::collections::BTreeSet::new();
        for _ in 0..n_marks {
            marks.insert(Position::from(r.read_u64::<LE>()?));
        }
        store
            .add_checkpoint(cid, Checkpoint::from_parts(tree_state, marks))
            .map_err(|_| PersistError::InvalidValue("add_checkpoint failed"))?;
    }

    let cap = read_shard(&mut r)
        .map_err(|_| PersistError::InvalidValue("bad cap data"))?;
    store
        .put_cap(cap)
        .map_err(|_| PersistError::InvalidValue("put_cap failed"))?;

    Ok(ShardTree::new(store, super::ORCHARD_REORG_DEPTH))
}

// Helper: cross-platform "with extension" that doesn't strip the existing
// extension (e.g. wallet_snapshot.bin -> wallet_snapshot.bin.tmp).
fn with_extension(p: &Path, ext: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// Reorg walkback helpers (Phase 2)
// ---------------------------------------------------------------------------
//
// On a snapshot load, the caller queries the chain for the saved tip's hash
// and walks the AnchorHistory newest-first when there's a mismatch. When a
// matching anchor is found, it calls into these helpers to roll all of the
// loaded state back to that anchor's height. After truncation the wallet
// resumes its forward sync from `target_h + 1` and re-derives the discarded
// notes / tx history.
//
// All helpers are pure: they mutate the borrowed state and never touch
// disk. The caller writes a fresh snapshot post-truncation.

/// Drop anchors whose height is strictly above `target_h`. Useful both for
/// trimming on load and for capping growth during normal operation.
pub fn anchors_truncate_above(history: &mut AnchorHistory, target_h: u32) {
    while history
        .anchors
        .back()
        .is_some_and(|a| a.height > target_h)
    {
        history.anchors.pop_back();
    }
}

/// Truncate the orchard ShardTree to the checkpoint at `target_h`. Returns
/// true if a truncation happened, false if the checkpoint wasn't found
/// (which should never happen for an anchor we just verified, but we don't
/// panic).
pub fn truncate_orchard_tree_to(
    tree: &mut super::OrchardShardTree,
    target_h: BlockHeight,
) -> bool {
    tree.truncate_to_checkpoint(&target_h).unwrap_or(false)
}

/// Truncate `pow_cache.hashes` so that the highest-indexed entry is the
/// hash at `target_h`, and reset `next_tip_h` to `target_h + 1`. Idempotent
/// when already at the requested height.
pub fn truncate_pow_cache_to(c: &mut PoWCache, target_h: u32) {
    let new_len = (target_h as usize + 1).min(c.hashes.len());
    c.hashes.truncate(new_len);
    c.next_tip_h = target_h as u64 + 1;
}

/// Roll back a single wallet to `target_h`:
///
/// - drop transparent + orchard receives whose `recv_h > target_h`
/// - any spend whose `spent_h > target_h` is undone (the note moves back
///   to unspent), provided its `recv_h <= target_h`
/// - filter out txs above `target_h` (mempool / proposed sentinels are
///   preserved -- those are local in-flight state)
/// - rebuild `tx_h_map` from the surviving txs
/// - clamp per-account `fully_decoded_h` / `fully_detected_h` to `target_h`
/// - set `chain_tip_h = target_h`
pub fn truncate_wallet_to(w: &mut super::ManualWallet, target_h: BlockHeight) {
    let h0 = target_h.0;
    w.chain_tip_h = target_h;

    for acc in &mut w.accounts {
        if acc.fully_detected_h.0 > h0 {
            acc.fully_detected_h = target_h;
        }
        if acc.fully_decoded_h.0 > h0 {
            acc.fully_decoded_h = target_h;
        }

        // Orchard notes -----
        acc.recv_orchard_notes
            .retain(|n| n.recv_h.0 <= h0);
        acc.unspent_orchard_notes
            .retain(|n| n.recv_h.0 <= h0);

        // Spent notes whose spend reorged out come back to unspent.
        let mut still_spent: Vec<super::OrchardNote> = Vec::new();
        for n in std::mem::take(&mut acc.spent_orchard_notes) {
            if n.recv_h.0 > h0 {
                continue; // didn't even exist before target -- drop
            }
            if n.spent_h.0 > h0 {
                let mut restored = n;
                restored.spent_h = BlockHeight::INVALID;
                acc.unspent_orchard_notes.push(restored);
            } else {
                still_spent.push(n);
            }
        }
        acc.spent_orchard_notes = still_spent;
        acc.unspent_orchard_notes
            .sort_by_key(|n| (n.recv_h.0, u64::from(n.position)));

        // Transparent txos -----
        acc.recv_txos.retain(|t| t.recv_h.0 <= h0);
        acc.utxos.retain(|t| t.recv_h.0 <= h0);

        let mut still_stxos: Vec<super::Txo> = Vec::new();
        for t in std::mem::take(&mut acc.stxos) {
            if t.recv_h.0 > h0 {
                continue;
            }
            if t.spent_h.0 > h0 {
                let mut restored = t;
                restored.spent_h = BlockHeight::INVALID;
                acc.utxos.push(restored);
            } else {
                still_stxos.push(t);
            }
        }
        acc.stxos = still_stxos;
        acc.utxos.sort_by_key(|t| t.recv_h.0);
    }

    // Tx history. Anything past target_h that's actually mined goes; we
    // leave the volatile mempool/proposed/sent/built sentinels alone since
    // those are local state, not chain-derived.
    w.txs.retain(|t| t.h.0 <= h0 || t.h.0 >= BlockHeight::MEMPOOL.0);
    w.tx_h_map.clear();
    for t in &w.txs {
        w.tx_h_map.insert(t.txid, t.h);
    }
}

/// Apply per-stream sync heights captured in an [`Anchor`] back onto the
/// supplied wallets. The `stream_heights` layout mirrors how `wallet_main`
/// pushes anchors: `miner_wallet.strms` first, then `user_wallet.strms`.
pub fn restore_stream_heights(
    miner_wallet: &mut super::ManualWallet,
    user_wallet: &mut super::ManualWallet,
    stream_heights: &[u32],
    cap_h: u32,
) {
    let mut idx = 0usize;
    for s in &mut miner_wallet.strms {
        if let Some(&h) = stream_heights.get(idx) {
            s.sync_h = BlockHeight(h.min(cap_h));
        }
        idx += 1;
    }
    for s in &mut user_wallet.strms {
        if let Some(&h) = stream_heights.get(idx) {
            s.sync_h = BlockHeight(h.min(cap_h));
        }
        idx += 1;
    }
}
