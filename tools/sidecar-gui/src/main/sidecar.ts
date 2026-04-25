/**
 * Core sidecar engine — the brains of the operation. Owns:
 *   - the scheduler tasks (chain poll, wallet poll, auto-faucet, auto-stake)
 *   - the live status snapshot
 *   - the rolling event log (capped, oldest first dropped)
 *   - emitting status / event broadcasts on a callback so main/index.ts can
 *     forward to the renderer without coupling Electron concerns into here.
 *
 * Designed to be unit-testable: no Electron / DOM / IPC imports.
 */
import {
  CTAZ,
  STAKE_DENOMS_CTAZ,
  WalletSnapshotSchema,
  RosterMemberSchema,
  blocksLeftInWindow,
  blocksUntilWindow,
  ctazToZats,
  isInStakingWindow,
  type Config,
  type LogEvent,
  type RosterMember,
  type Status,
  type WalletSnapshot,
} from "@shared/contracts";
import { RpcClient, RpcError } from "./rpc";
import { Scheduler } from "./scheduler";

const EVENTS_CAP = 500;
const TASK_CHAIN = "poll-chain";
const TASK_WALLET = "poll-wallet";
const TASK_FAUCET = "auto-faucet";
const TASK_STAKE = "auto-stake";

export interface SidecarHooks {
  onStatus(status: Status): void;
  onEvent(event: LogEvent): void;
}

export class Sidecar {
  private rpc: RpcClient;
  private scheduler = new Scheduler();
  private events: LogEvent[] = [];
  private height: number | null = null;
  private wallet: WalletSnapshot | null = null;
  private rpcReachable = false;
  private faucetOk = 0;
  private faucetErr = 0;
  private stakeOk = 0;
  private stakeErr = 0;
  private lastFaucetAttemptMs = 0;
  private lastStakeAttemptMs = 0;

  constructor(
    private cfg: Config,
    private hooks: SidecarHooks,
  ) {
    this.rpc = new RpcClient(cfg.rpcUrl, cfg.rpcTimeoutMs);
    this.installTasks();
    this.scheduler.start();
    this.log("info", `sidecar started (rpc=${cfg.rpcUrl})`);
  }

  // ---- public API used by IPC handlers ----

  getStatus(): Status {
    const h = this.height;
    return {
      height: h,
      isStakingWindow: h !== null && isInStakingWindow(h),
      blocksLeftInWindow: h !== null ? blocksLeftInWindow(h) : 0,
      blocksUntilWindow: h !== null ? blocksUntilWindow(h) : 0,
      wallet: this.wallet,
      rpcReachable: this.rpcReachable,
      faucetOk: this.faucetOk,
      faucetErr: this.faucetErr,
      stakeOk: this.stakeOk,
      stakeErr: this.stakeErr,
      lastFaucetAttemptMs: this.lastFaucetAttemptMs,
      lastStakeAttemptMs: this.lastStakeAttemptMs,
    };
  }

  getEvents(): LogEvent[] {
    return [...this.events];
  }

  getConfig(): Config {
    return { ...this.cfg };
  }

  applyConfig(next: Config): Config {
    const intervalsChanged =
      next.faucetIntervalSec !== this.cfg.faucetIntervalSec ||
      next.stakeIntervalSec !== this.cfg.stakeIntervalSec;
    const rpcChanged =
      next.rpcUrl !== this.cfg.rpcUrl || next.rpcTimeoutMs !== this.cfg.rpcTimeoutMs;
    this.cfg = next;
    if (rpcChanged) {
      this.rpc = new RpcClient(next.rpcUrl, next.rpcTimeoutMs);
      this.log("info", `rpc target -> ${next.rpcUrl}`);
    }
    if (intervalsChanged) {
      this.scheduler.setInterval(TASK_FAUCET, next.faucetIntervalSec * 1000);
      this.scheduler.setInterval(TASK_STAKE, next.stakeIntervalSec * 1000);
    }
    this.broadcastStatus();
    return next;
  }

  toggleAutoFaucet(): Config {
    return this.applyConfig({ ...this.cfg, autoFaucet: !this.cfg.autoFaucet });
  }

  toggleAutoStake(): Config {
    return this.applyConfig({ ...this.cfg, autoStake: !this.cfg.autoStake });
  }

  /** One-shot faucet call requested from the GUI. */
  async triggerFaucet(): Promise<{ ok: boolean; message: string }> {
    return this.callFaucetOnce();
  }

  /** One-shot stake call requested from the GUI. */
  async triggerStake(): Promise<{ ok: boolean; message: string }> {
    if (this.height === null) {
      return { ok: false, message: "chain height unknown" };
    }
    if (!isInStakingWindow(this.height)) {
      return { ok: false, message: "outside staking window" };
    }
    const amt = this.pickStakeAmount();
    if (amt <= 0n) return { ok: false, message: "no stakeable amount" };
    if (!this.cfg.finalizerHex)
      return { ok: false, message: "finalizer not set" };
    return this.callStakeOnce(amt, this.cfg.finalizerHex);
  }

  /**
   * Ask zebrad to drop the wallet snapshot wipe marker. Takes effect at the
   * NEXT zebrad restart -- the running wallet is not affected, by design.
   */
  async wipeSnapshot(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await this.rpc.call<unknown>("staking_command", ["wipe-snapshot"]);
      const msg = typeof res === "string" ? res : "ok";
      this.log("ok", `wipe-snapshot: ${msg}`);
      return { ok: true, message: msg };
    } catch (e) {
      const msg = describe(e);
      this.log("err", `wipe-snapshot failed: ${msg}`);
      return { ok: false, message: msg };
    }
  }

  /** Read the BFT roster from chain and pick the highest-voting-power member. */
  async pickRosterFinalizer(): Promise<Config> {
    let raw: unknown;
    try {
      raw = await this.rpc.call("get_tfl_roster_zats");
    } catch (e) {
      this.log("err", `roster fetch failed: ${describe(e)}`);
      return this.cfg;
    }
    const arr = Array.isArray(raw) ? raw : [];
    const parsed: RosterMember[] = [];
    for (const m of arr) {
      const r = RosterMemberSchema.safeParse(m);
      if (r.success) parsed.push(r.data);
    }
    parsed.sort((a, b) => b.voting_power - a.voting_power);
    const chosen = parsed[0];
    if (!chosen) {
      this.log("warn", "roster empty / unparseable");
      return this.cfg;
    }
    this.log(
      "ok",
      `picked finalizer ${shortHex(chosen.pub_key)} (vp=${chosen.voting_power})`,
    );
    return this.applyConfig({ ...this.cfg, finalizerHex: chosen.pub_key });
  }

  refreshNow(): void {
    this.scheduler.bump(TASK_CHAIN);
    this.scheduler.bump(TASK_WALLET);
  }

  shutdown(): void {
    this.scheduler.stop();
  }

  // ---- internals ----

  private installTasks(): void {
    this.scheduler.add({
      name: TASK_CHAIN,
      intervalMs: 5_000,
      runImmediately: true,
      enabled: () => true,
      fn: () => this.pollChain(),
    });
    this.scheduler.add({
      name: TASK_WALLET,
      intervalMs: 5_000,
      runImmediately: true,
      enabled: () => true,
      fn: () => this.pollWallet(),
    });
    this.scheduler.add({
      name: TASK_FAUCET,
      intervalMs: this.cfg.faucetIntervalSec * 1_000,
      runImmediately: false,
      enabled: () => this.cfg.autoFaucet && !(this.wallet?.waiting_for_faucet ?? false),
      fn: async () => {
        await this.callFaucetOnce();
      },
    });
    this.scheduler.add({
      name: TASK_STAKE,
      intervalMs: this.cfg.stakeIntervalSec * 1_000,
      runImmediately: false,
      enabled: () =>
        this.cfg.autoStake &&
        this.height !== null &&
        isInStakingWindow(this.height) &&
        !(this.wallet?.waiting_for_stake ?? false),
      fn: async () => {
        const amt = this.pickStakeAmount();
        if (amt <= 0n || !this.cfg.finalizerHex) return;
        await this.callStakeOnce(amt, this.cfg.finalizerHex);
      },
    });
  }

  private async pollChain(): Promise<void> {
    try {
      const h = await this.rpc.call<number>("getblockcount");
      this.height = typeof h === "number" ? h : Number(h);
      this.rpcReachable = true;
      this.broadcastStatus();
    } catch (e) {
      this.rpcReachable = false;
      this.log("err", `chain poll: ${describe(e)}`);
      this.broadcastStatus();
      throw e; // let scheduler back off
    }
  }

  private async pollWallet(): Promise<void> {
    try {
      const j = await this.rpc.call<string>("staking_command", ["info"]);
      if (typeof j !== "string") return;
      const parsed = WalletSnapshotSchema.safeParse(JSON.parse(j));
      if (parsed.success) {
        this.wallet = parsed.data;
        this.rpcReachable = true;
        this.broadcastStatus();
      }
    } catch (e) {
      // backend may not have the patch / may be busy — silent unless first time
      if (this.rpcReachable && this.wallet === null) {
        this.log("warn", `wallet info unavailable: ${describe(e)}`);
      }
    }
  }

  private async callFaucetOnce(): Promise<{ ok: boolean; message: string }> {
    this.lastFaucetAttemptMs = Date.now();
    if (!this.cfg.userAddress) {
      this.faucetErr += 1;
      this.log("err", "no user_address configured");
      this.broadcastStatus();
      return { ok: false, message: "no user_address" };
    }
    try {
      const res = await this.rpc.call<{ amount?: number } | null>(
        "requestfaucetdonation",
        [{ address: this.cfg.userAddress }],
      );
      const amt = (res && typeof res.amount === "number" ? res.amount : 0) / CTAZ;
      this.faucetOk += 1;
      this.log("ok", `faucet OK (+${amt.toFixed(2)} cTAZ in-flight)`);
      this.broadcastStatus();
      return { ok: true, message: `+${amt.toFixed(2)} cTAZ` };
    } catch (e) {
      this.faucetErr += 1;
      this.log("err", `faucet err: ${describe(e)}`);
      this.broadcastStatus();
      return { ok: false, message: describe(e) };
    }
  }

  private async callStakeOnce(
    amountZats: bigint,
    finalizerHex: string,
  ): Promise<{ ok: boolean; message: string }> {
    this.lastStakeAttemptMs = Date.now();
    const cmd = `stake ${amountZats.toString()} ${finalizerHex}`;
    try {
      await this.rpc.call("staking_command", [cmd]);
      this.stakeOk += 1;
      this.log(
        "ok",
        `stake queued: ${(Number(amountZats) / CTAZ).toFixed(5)} cTAZ -> ${shortHex(finalizerHex)}`,
      );
      this.broadcastStatus();
      return { ok: true, message: "queued" };
    } catch (e) {
      this.stakeErr += 1;
      this.log("err", `stake err: ${describe(e)}`);
      this.broadcastStatus();
      return { ok: false, message: describe(e) };
    }
  }

  private pickStakeAmount(): bigint {
    const max = ctazToZats(this.cfg.stakeMaxDenomCtaz);
    const min = ctazToZats(this.cfg.stakeMinDenomCtaz);
    const spendableZ =
      typeof this.wallet?.user_shielded_spendable === "number"
        ? BigInt(this.wallet.user_shielded_spendable)
        : null;
    // Without a wallet snapshot, fall back to the configured min — backend will
    // silently reject if the funds aren't actually there.
    const budget = spendableZ ?? min;
    for (const denom of STAKE_DENOMS_CTAZ) {
      const z = ctazToZats(denom);
      if (z > max) continue;
      if (z < min) break;
      if (z <= budget) return z;
    }
    return 0n;
  }

  private log(kind: LogEvent["kind"], msg: string): void {
    const ev: LogEvent = { ts: Date.now(), kind, msg };
    this.events.unshift(ev);
    if (this.events.length > EVENTS_CAP) this.events.length = EVENTS_CAP;
    this.hooks.onEvent(ev);
  }

  private broadcastStatus(): void {
    this.hooks.onStatus(this.getStatus());
  }
}

function describe(e: unknown): string {
  if (e instanceof RpcError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function shortHex(h: string): string {
  return h.length >= 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h;
}
