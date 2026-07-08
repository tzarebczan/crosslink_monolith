/**
 * Shared contracts between main, preload, and renderer.
 *
 * Pattern stolen from t3code's `packages/contracts`: every IPC payload is a
 * Zod schema first, derived TS type second. This guarantees runtime validation
 * at the boundary (renderer can't lie to main, main can't accidentally drift
 * from what renderer expects) and gives us inference for free in TS.
 *
 * Don't import anything Electron- or Node- or DOM-specific from this file.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants — must match zebra-consensus/src/transaction.rs
// ---------------------------------------------------------------------------

export const STAKING_DAY_PERIOD = 150 as const;
export const STAKING_DAY_WINDOW = 70 as const;

/** zats per 1 cTAZ */
export const CTAZ = 100_000_000 as const;

/** Allowed stake denominations (largest first), matching the viz buttons. */
export const STAKE_DENOMS_CTAZ = [
  "10000",
  "1000",
  "100",
  "10",
  "1",
  "0.1",
  "0.01",
] as const;

// ---------------------------------------------------------------------------
// Config (persisted to electron-store)
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  rpcUrl: z.string().url().default("http://127.0.0.1:8232"),
  userAddress: z.string().default(""),
  finalizerHex: z.string().default(""),
  autoFaucet: z.boolean().default(false),
  autoStake: z.boolean().default(false),
  faucetIntervalSec: z.number().int().positive().default(30),
  stakeIntervalSec: z.number().int().positive().default(20),
  stakeMaxDenomCtaz: z.string().default("1"),
  stakeMinDenomCtaz: z.string().default("0.01"),
  rpcTimeoutMs: z.number().int().positive().default(30_000),
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Wallet snapshot (return value of `staking_command info`)
// ---------------------------------------------------------------------------

/**
 * The Rust closure in `wallet/src/lib.rs` returns a JSON string with these
 * fields. Schema is permissive so backend-side renames don't crash the GUI.
 */
export const WalletSnapshotSchema = z
  .object({
    user_balance_zats: z.number().int().nonnegative(),
    user_shielded_spendable: z.number().int().nonnegative(),
    user_shielded_pending: z.number().int().nonnegative(),
    user_unshielded: z.number().int().nonnegative(),
    user_address: z.string(),
    miner_balance_zats: z.number().int().nonnegative().optional(),
    miner_shielded_spendable: z.number().int().nonnegative().optional(),
    miner_shielded_pending: z.number().int().nonnegative().optional(),
    miner_unshielded: z.number().int().nonnegative().optional(),
    staked_zats: z.number().int().nonnegative(),
    withdrawable_zats: z.number().int().nonnegative(),
    waiting_for_faucet: z.boolean(),
    waiting_for_stake: z.boolean(),
    waiting_for_send: z.boolean().optional(),
    wallet_sync_h: z.number().int().nonnegative().optional(),
    wallet_tip_h: z.number().int().nonnegative().optional(),
    actions_in_flight: z.number().int().nonnegative().optional(),
    stake_positions_bonded: z.number().int().nonnegative().optional(),
    stake_positions_unbonded: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type WalletSnapshot = z.infer<typeof WalletSnapshotSchema>;

// ---------------------------------------------------------------------------
// Roster member (return value of `get_tfl_roster_zats`)
// ---------------------------------------------------------------------------

export const RosterMemberSchema = z
  .object({
    pub_key: z.string(),
    voting_power: z.number().int().nonnegative(),
  })
  .passthrough();
export type RosterMember = z.infer<typeof RosterMemberSchema>;

// ---------------------------------------------------------------------------
// Live status broadcast from main -> renderer
// ---------------------------------------------------------------------------

export const EventKindSchema = z.enum(["info", "ok", "warn", "err"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const LogEventSchema = z.object({
  ts: z.number(), // epoch ms
  kind: EventKindSchema,
  msg: z.string(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

export const StatusSchema = z.object({
  height: z.number().int().nonnegative().nullable(),
  isStakingWindow: z.boolean(),
  blocksLeftInWindow: z.number().int().nonnegative(),
  blocksUntilWindow: z.number().int().nonnegative(),
  wallet: WalletSnapshotSchema.nullable(),
  rpcReachable: z.boolean(),
  // counters
  faucetOk: z.number().int().nonnegative(),
  faucetErr: z.number().int().nonnegative(),
  stakeOk: z.number().int().nonnegative(),
  stakeErr: z.number().int().nonnegative(),
  // last attempt timestamps (epoch ms; 0 if never)
  lastFaucetAttemptMs: z.number().int().nonnegative(),
  lastStakeAttemptMs: z.number().int().nonnegative(),
});
export type Status = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// IPC channel registry — single source of truth for both sides
// ---------------------------------------------------------------------------

export const IPC = {
  // renderer -> main (request/response)
  GetConfig: "config:get",
  SetConfig: "config:set",
  GetStatus: "status:get",
  GetEvents: "events:get",
  ToggleAutoFaucet: "action:toggle-auto-faucet",
  ToggleAutoStake: "action:toggle-auto-stake",
  TriggerFaucet: "action:trigger-faucet",
  TriggerStake: "action:trigger-stake",
  PickFinalizer: "action:pick-finalizer",
  WipeSnapshot: "action:wipe-snapshot",
  RefreshNow: "action:refresh",

  // main -> renderer (broadcast)
  StatusUpdate: "status:update",
  EventAppended: "events:appended",
} as const;
export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exact cTAZ -> zats. Strings are preferred for sub-cTAZ amounts because
 * `0.01 * 1e8` is not exact in IEEE-754 (yields 999999.999...).
 */
export function ctazToZats(val: string | number): bigint {
  const s = String(val).trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole, fracRaw = ""] = body.split(".");
  const frac = (fracRaw + "00000000").slice(0, 8);
  const z = BigInt(whole || "0") * BigInt(CTAZ) + BigInt(frac || "0");
  return neg ? -z : z;
}

export function fmtCtaz(zats: number | bigint): string {
  const z = typeof zats === "bigint" ? zats : BigInt(Math.trunc(zats));
  const neg = z < 0n;
  const abs = neg ? -z : z;
  const whole = abs / BigInt(CTAZ);
  const frac = abs % BigInt(CTAZ);
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(8, "0")}`;
}

export function isInStakingWindow(height: number): boolean {
  return height % STAKING_DAY_PERIOD < STAKING_DAY_WINDOW;
}

export function blocksLeftInWindow(height: number): number {
  const pos = height % STAKING_DAY_PERIOD;
  return pos < STAKING_DAY_WINDOW ? STAKING_DAY_WINDOW - pos : 0;
}

export function blocksUntilWindow(height: number): number {
  const pos = height % STAKING_DAY_PERIOD;
  return pos < STAKING_DAY_WINDOW ? 0 : STAKING_DAY_PERIOD - pos;
}

export function shortHex(h: string): string {
  if (!h) return "(unset)";
  return h.length >= 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}
