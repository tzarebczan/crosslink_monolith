#!/usr/bin/env python3
"""
Crosslink Season 1 auto-faucet + auto-stake sidecar.

Runs alongside a zebrad-viz node on Season 1. Talks to zebrad's JSON-RPC to:

  * Call ``requestfaucetdonation`` every N seconds when auto-faucet is ON.
  * Call ``staking_command`` with ``stake <amount_zats> <finalizer_hex>``
    during each Staking Day window when auto-stake is ON.
  * Poll ``getblockcount`` and ``staking_command info`` for a live status TUI.

Backend requirements
--------------------

This relies on the ``staking_command`` RPC being wired through to the wallet.
The patch that lives alongside this script in the same branch adds:

  * ``wallet::STAKE_REQUEST`` closure + ``STAKE_Q`` drained by ``wallet_main``
  * ``wallet::WALLET_INFO`` closure returning a JSON snapshot
  * a ``TFLServiceRequest::StakingCmd`` handler that accepts::

        stake <amount_zats> <finalizer_hex>
        info
        help

Usage
-----

::

    python auto_crosslink.py                 # interactive TUI
    python auto_crosslink.py --config my.json
    python auto_crosslink.py --once-faucet   # fire one faucet call and exit
    python auto_crosslink.py --once-stake    # fire one stake (if in window)
    python auto_crosslink.py --info          # dump wallet snapshot JSON

TUI keybindings
---------------

  f       toggle auto-faucet
  s       toggle auto-stake
  c       call faucet once (one-shot)
  k       stake once (one-shot)
  r       refresh wallet info / chain height
  a       auto-pick a finalizer from the on-chain roster
  +/-     step the configured max stake denomination up/down
  q       quit

No third-party dependencies; Python 3.7+ stdlib only.
"""

import argparse
import ctypes
import json
import os
import platform
import sys
import time
from collections import deque
from datetime import datetime
from urllib import error as urlerr
from urllib import request as urlreq

VERSION = "0.1.0"

# --- Must match zebra-consensus/src/transaction.rs -------------------------
STAKING_DAY_PERIOD = 150
STAKING_DAY_WINDOW = 70

CTAZ = 100_000_000  # zats per 1 cTAZ

# Denominations, in cTAZ, largest first. Mirrors the viz stake buttons.
STAKE_DENOMS_CTAZ = [10000, 1000, 100, 10, 1, "0.1", "0.01"]


def ctaz_to_zats(val):
    """Exact cTAZ -> zats (8 fractional digits), accepts int/float/str."""
    s = str(val).strip()
    neg = False
    if s.startswith("-"):
        neg = True
        s = s[1:]
    if "." in s:
        whole, frac = s.split(".", 1)
    else:
        whole, frac = s, ""
    frac = (frac + "00000000")[:8]
    z = (int(whole or "0") * CTAZ) + int(frac or "0")
    return -z if neg else z


STAKE_DENOMS_ZATS = [ctaz_to_zats(d) for d in STAKE_DENOMS_CTAZ]

DEFAULT_CONFIG = {
    "rpc_url": "http://127.0.0.1:8232",
    "user_address": "",            # UA where faucet payments land (copy from viz)
    "finalizer_hex": "",           # 32-byte target finalizer, 64 hex chars (roster pub_key)
    "auto_faucet": False,
    "auto_stake": False,
    "faucet_interval_s": 30,
    "stake_interval_s": 20,
    "stake_max_denom_ctaz": "1",   # cap on auto-pick denomination
    "stake_min_denom_ctaz": "0.01",
}


# --- ANSI helpers ----------------------------------------------------------


class A:
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"
    RED = "\x1b[31m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    BLUE = "\x1b[34m"
    MAGENTA = "\x1b[35m"
    CYAN = "\x1b[36m"
    GRAY = "\x1b[90m"
    CLEAR = "\x1b[2J\x1b[H"
    HOME = "\x1b[H"
    CLEAR_BELOW = "\x1b[J"
    HIDE = "\x1b[?25l"
    SHOW = "\x1b[?25h"


def enable_vt_mode_windows():
    """Enable ANSI escape handling on Windows 10+ consoles."""
    if platform.system() != "Windows":
        return
    try:
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass


# --- Non-blocking single-keystroke input ----------------------------------


if platform.system() == "Windows":
    import msvcrt

    def get_keypress():
        if msvcrt.kbhit():
            ch = msvcrt.getch()
            # Arrow keys / function keys arrive as two bytes; swallow the 2nd.
            if ch in (b"\x00", b"\xe0"):
                try:
                    msvcrt.getch()
                except Exception:
                    pass
                return None
            try:
                return ch.decode("utf-8", errors="ignore")
            except Exception:
                return None
        return None

    def kb_setup():
        pass

    def kb_restore():
        pass

else:
    import select
    import termios
    import tty

    _orig_attr = [None]

    def kb_setup():
        _orig_attr[0] = termios.tcgetattr(sys.stdin.fileno())
        tty.setcbreak(sys.stdin.fileno())

    def kb_restore():
        if _orig_attr[0] is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _orig_attr[0])

    def get_keypress():
        r, _, _ = select.select([sys.stdin], [], [], 0)
        if r:
            return sys.stdin.read(1)
        return None


# --- JSON-RPC client -------------------------------------------------------


class RPCError(Exception):
    pass


def rpc(url, method, params=None, timeout=30):
    payload = {"jsonrpc": "2.0", "method": method, "params": params or [], "id": 1}
    body = json.dumps(payload).encode("utf-8")
    req = urlreq.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    raw = None
    try:
        with urlreq.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urlerr.HTTPError as e:
        # zebrad returns 500 with JSON body on RPC errors
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            raise RPCError(f"{method}: http {e.code}") from e
    except urlerr.URLError as e:
        # Timeouts can appear here wrapped in URLError on some Python versions.
        reason = getattr(e, "reason", e)
        raise RPCError(f"{method}: network: {reason}") from e
    except TimeoutError as e:
        # In Python 3.10+ socket.timeout is TimeoutError and may be raised
        # directly by urlopen rather than wrapped in URLError.
        raise RPCError(f"{method}: timed out after {timeout}s") from e
    except (ConnectionError, OSError) as e:
        raise RPCError(f"{method}: i/o: {e}") from e
    except Exception as e:
        # Anything else -- don't let the RPC layer take down the app.
        raise RPCError(f"{method}: unexpected {type(e).__name__}: {e}") from e

    if raw is None:
        raise RPCError(f"{method}: no response body")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RPCError(f"{method}: non-json response: {raw[:120]!r}") from e

    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        raise RPCError(f"{method}: {msg}")
    return data.get("result") if isinstance(data, dict) else None


# --- Staking-day math ------------------------------------------------------


def is_in_staking_window(height):
    return (height % STAKING_DAY_PERIOD) < STAKING_DAY_WINDOW


def blocks_left_in_window(height):
    pos = height % STAKING_DAY_PERIOD
    return max(0, STAKING_DAY_WINDOW - pos) if pos < STAKING_DAY_WINDOW else 0


def blocks_until_window(height):
    pos = height % STAKING_DAY_PERIOD
    if pos < STAKING_DAY_WINDOW:
        return 0
    return STAKING_DAY_PERIOD - pos


def fmt_ctaz(zats):
    sign = "-" if zats < 0 else ""
    z = abs(int(zats))
    whole = z // CTAZ
    frac = z % CTAZ
    return f"{sign}{whole}.{frac:08d}"


def short_hex(h):
    if not h:
        return "(unset)"
    return f"{h[:8]}…{h[-8:]}" if len(h) >= 16 else h


# --- Config persistence ----------------------------------------------------


def load_config(path):
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(path, "r", encoding="utf-8") as f:
            user_cfg = json.load(f)
        for k, v in user_cfg.items():
            if k in DEFAULT_CONFIG:
                cfg[k] = v
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"warning: bad config at {path}: {e}", file=sys.stderr)
    cfg["_config_path"] = os.path.abspath(path)
    return cfg


def save_config(cfg):
    path = cfg.get("_config_path")
    if not path:
        return
    try:
        out = {k: cfg[k] for k in DEFAULT_CONFIG.keys()}
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        print(f"warning: save config failed: {e}", file=sys.stderr)


# --- Main sidecar ----------------------------------------------------------


class Sidecar:
    def __init__(self, cfg):
        self.cfg = cfg
        self.auto_faucet = bool(cfg["auto_faucet"])
        self.auto_stake = bool(cfg["auto_stake"])
        self.last_faucet_tick = 0.0
        self.last_stake_tick = 0.0
        self.last_chain_poll = 0.0
        self.last_wallet_poll = 0.0
        self.height = None
        self.wallet = None  # dict from `staking_command info`
        self.events = deque(maxlen=200)
        self.stopped = False
        self.n_faucet_ok = 0
        self.n_faucet_err = 0
        self.n_stake_ok = 0
        self.n_stake_err = 0
        # Wipe-snapshot is destructive (full resync on next zebrad restart),
        # so require two presses of `W` within WIPE_CONFIRM_S of each other.
        self.wipe_armed_until = 0.0

    # ---- helpers ----

    def log(self, msg, kind="info"):
        ts = datetime.now().strftime("%H:%M:%S")
        self.events.appendleft((ts, kind, msg))

    def _rpc(self, method, params=None):
        return rpc(self.cfg["rpc_url"], method, params)

    # ---- actions ----

    def call_faucet(self):
        addr = self.cfg.get("user_address", "").strip()
        if not addr:
            self.n_faucet_err += 1
            self.log("no user_address configured", "err")
            return False
        try:
            res = self._rpc("requestfaucetdonation", [{"address": addr}])
            amt = res.get("amount", 0) if isinstance(res, dict) else 0
            self.n_faucet_ok += 1
            self.log(f"faucet OK (+{fmt_ctaz(amt)} cTAZ in-flight)", "ok")
            return True
        except RPCError as e:
            self.n_faucet_err += 1
            self.log(f"faucet err: {e}", "err")
            return False

    def pick_stake_amount(self):
        """Largest denomination that fits within configured bounds + spendable."""
        max_denom = ctaz_to_zats(self.cfg["stake_max_denom_ctaz"])
        min_denom = ctaz_to_zats(self.cfg["stake_min_denom_ctaz"])
        spendable = int((self.wallet or {}).get("user_shielded_spendable", 0))
        # If we don't have a snapshot yet, fall back to min_denom and let the
        # backend silently dedupe/refuse if funds aren't there.
        budget = spendable if self.wallet else min_denom
        for d in STAKE_DENOMS_ZATS:
            if d > max_denom:
                continue
            if d < min_denom:
                break
            if d <= budget:
                return d
        return 0

    def call_stake(self, amount_zats, finalizer_hex):
        if not finalizer_hex:
            self.n_stake_err += 1
            self.log("no finalizer configured (press 'a' to auto-pick)", "err")
            return False
        if amount_zats <= 0:
            return False
        cmd = f"stake {amount_zats} {finalizer_hex}"
        try:
            self._rpc("staking_command", [cmd])
            self.n_stake_ok += 1
            self.log(
                f"stake queued: {fmt_ctaz(amount_zats)} cTAZ -> {short_hex(finalizer_hex)}",
                "ok",
            )
            return True
        except RPCError as e:
            self.n_stake_err += 1
            self.log(f"stake err: {e}", "err")
            return False

    # ---- polling ----

    def poll_chain(self):
        try:
            self.height = int(self._rpc("getblockcount"))
        except RPCError as e:
            self.log(f"chain poll err: {e}", "err")
        except (TypeError, ValueError) as e:
            self.log(f"chain poll parse err: {e}", "err")

    def poll_wallet(self):
        try:
            j = self._rpc("staking_command", ["info"])
        except RPCError as e:
            # Backend or wallet not ready yet; stay silent.
            return
        try:
            self.wallet = json.loads(j) if isinstance(j, str) else j
        except json.JSONDecodeError:
            pass

    def pick_roster_finalizer(self):
        try:
            r = self._rpc("get_tfl_roster_zats")
        except RPCError as e:
            self.log(f"roster err: {e}", "err")
            return
        if not r:
            self.log("roster empty", "warn")
            return
        r_sorted = sorted(r, key=lambda m: m.get("voting_power", 0), reverse=True)
        chosen = r_sorted[0].get("pub_key", "")
        if not chosen:
            self.log("roster member missing pub_key", "err")
            return
        self.cfg["finalizer_hex"] = chosen
        save_config(self.cfg)
        self.log(
            f"picked finalizer {short_hex(chosen)} "
            f"(voting_power={r_sorted[0].get('voting_power', 0)})",
            "ok",
        )

    # ---- tick / key handling ----

    def tick(self):
        now = time.monotonic()
        if now - self.last_chain_poll >= 5.0:
            self.poll_chain()
            self.last_chain_poll = now
        if now - self.last_wallet_poll >= 3.0:
            self.poll_wallet()
            self.last_wallet_poll = now

        wf = (self.wallet or {}).get("waiting_for_faucet", False)
        ws = (self.wallet or {}).get("waiting_for_stake", False)

        if self.auto_faucet and not wf:
            if now - self.last_faucet_tick >= self.cfg["faucet_interval_s"]:
                self.call_faucet()
                self.last_faucet_tick = now

        if (
            self.auto_stake
            and self.height is not None
            and is_in_staking_window(self.height)
            and not ws
        ):
            if now - self.last_stake_tick >= self.cfg["stake_interval_s"]:
                amt = self.pick_stake_amount()
                if amt > 0 and self.cfg.get("finalizer_hex"):
                    self.call_stake(amt, self.cfg["finalizer_hex"])
                # always advance the tick so we don't thrash on errors
                self.last_stake_tick = now

    def _step_max_denom(self, direction):
        cur = ctaz_to_zats(self.cfg["stake_max_denom_ctaz"])
        try:
            i = next(i for i, z in enumerate(STAKE_DENOMS_ZATS) if z == cur)
        except StopIteration:
            # snap to the closest denom at or below current
            i = 0
            for j, z in enumerate(STAKE_DENOMS_ZATS):
                if z <= cur:
                    i = j
                    break
        # list is largest->smallest. '+' increases amount (lower index).
        if direction > 0 and i > 0:
            i -= 1
        elif direction < 0 and i < len(STAKE_DENOMS_ZATS) - 1:
            i += 1
        new = STAKE_DENOMS_CTAZ[i]
        self.cfg["stake_max_denom_ctaz"] = str(new)
        save_config(self.cfg)
        self.log(f"max stake denom -> {new} cTAZ", "info")

    def handle_key(self, k):
        if not k:
            return
        k = k.lower()
        if k == "q":
            self.stopped = True
        elif k == "f":
            self.auto_faucet = not self.auto_faucet
            self.cfg["auto_faucet"] = self.auto_faucet
            save_config(self.cfg)
            self.log(f"auto-faucet: {'ON' if self.auto_faucet else 'OFF'}", "info")
        elif k == "s":
            self.auto_stake = not self.auto_stake
            self.cfg["auto_stake"] = self.auto_stake
            save_config(self.cfg)
            self.log(f"auto-stake: {'ON' if self.auto_stake else 'OFF'}", "info")
        elif k == "c":
            self.call_faucet()
        elif k == "k":
            if self.height is None:
                self.log("chain height unknown yet", "warn")
            elif not is_in_staking_window(self.height):
                self.log(
                    f"outside staking window (pos {self.height % STAKING_DAY_PERIOD}/"
                    f"{STAKING_DAY_WINDOW})",
                    "warn",
                )
            else:
                amt = self.pick_stake_amount()
                if amt <= 0:
                    self.log("no stakeable amount (balance < min denom)", "warn")
                else:
                    self.call_stake(amt, self.cfg.get("finalizer_hex", ""))
        elif k == "r":
            self.poll_chain()
            self.poll_wallet()
            self.log("refreshed", "info")
        elif k == "a":
            self.pick_roster_finalizer()
        elif k == "+" or k == "=":
            self._step_max_denom(+1)
        elif k == "-" or k == "_":
            self._step_max_denom(-1)
        elif k == "w":
            self.wipe_snapshot_keypress()

    # Wipe is two-stage: first press arms it (logs a confirm-needed message
    # and starts a 5s window); second press inside the window actually fires.
    WIPE_CONFIRM_S = 5.0

    def wipe_snapshot_keypress(self):
        now = time.monotonic()
        if now < self.wipe_armed_until:
            self.wipe_armed_until = 0.0
            try:
                res = self._rpc("staking_command", ["wipe-snapshot"])
                msg = res if isinstance(res, str) else json.dumps(res)
                self.log(f"wipe-snapshot OK: {msg}", "ok")
            except RPCError as e:
                self.log(f"wipe-snapshot failed: {e}", "err")
        else:
            self.wipe_armed_until = now + self.WIPE_CONFIRM_S
            self.log(
                f"press 'w' again within {int(self.WIPE_CONFIRM_S)}s to confirm wipe (effective on next restart)",
                "warn",
            )


# --- Rendering -------------------------------------------------------------


def render(s):
    cfg = s.cfg
    w = s.wallet or {}
    h = s.height
    buf = [A.CLEAR]

    def line(*parts):
        buf.append("".join(parts) + A.RESET + "\n")

    line(A.BOLD, A.CYAN, "╔══ Crosslink Season 1  ·  auto-faucet + auto-stake sidecar  v", VERSION, " ══╗")
    line(A.DIM, "  rpc: ", A.RESET, cfg["rpc_url"], A.DIM, "    config: ", A.RESET, cfg.get("_config_path", "(none)"))
    line()

    staking_on = h is not None and is_in_staking_window(h)
    line(
        A.BOLD, "Chain: ", A.RESET,
        f"height={h if h is not None else '?'}   ",
        (A.GREEN + "staking window OPEN " if staking_on else A.RED + "staking window CLOSED"),
        A.RESET,
        f"   pos={h % STAKING_DAY_PERIOD}/{STAKING_DAY_PERIOD}" if h is not None else "",
    )
    if h is not None:
        if staking_on:
            line(A.DIM, f"  {blocks_left_in_window(h)} block(s) left in this window")
        else:
            line(A.DIM, f"  next window opens in {blocks_until_window(h)} block(s)")
    line()

    line(A.BOLD, "Wallet:")
    if w:
        def row(label, z, color=""):
            line("  ", f"{label:<28}", color, f"{fmt_ctaz(z):>18} cTAZ")
        row("user shielded spendable", w.get("user_shielded_spendable", 0), A.GREEN)
        row("user shielded pending",   w.get("user_shielded_pending", 0),   A.YELLOW)
        row("user unshielded",         w.get("user_unshielded", 0))
        row("user total",              w.get("user_balance_zats", 0),       A.BOLD)
        row("staked",                  w.get("staked_zats", 0),             A.CYAN)
        row("withdrawable",            w.get("withdrawable_zats", 0),       A.CYAN)
        line(
            A.DIM,
            f"  actions in-flight: {w.get('actions_in_flight', 0)}  ·  "
            f"bonded: {w.get('stake_positions_bonded', 0)}  ·  "
            f"unbonded: {w.get('stake_positions_unbonded', 0)}  ·  "
            f"waiting: faucet={w.get('waiting_for_faucet', False)} "
            f"stake={w.get('waiting_for_stake', False)}",
        )
    else:
        line(A.DIM, "  (waiting for `staking_command info` — backend may still be warming up)")
    line()

    line(A.BOLD, "Config:")
    ua = cfg.get("user_address", "")
    ua_short = (ua[:16] + "…" + ua[-10:]) if len(ua) > 30 else ua
    line("  user_address: ", A.YELLOW if not ua else "", ua_short or "(not set — faucet disabled)")
    fin = cfg.get("finalizer_hex", "") or ""
    line(
        "  finalizer:    ",
        A.YELLOW if not fin else "",
        short_hex(fin) if fin else "(not set — press 'a' to auto-pick from roster)",
    )
    line(
        f"  stake denom:  {cfg['stake_min_denom_ctaz']} … {cfg['stake_max_denom_ctaz']} cTAZ "
        f"(+/- to adjust max)"
    )
    line(f"  intervals:    faucet={cfg['faucet_interval_s']}s   stake={cfg['stake_interval_s']}s")
    line()

    def tog(on):
        return (A.GREEN + "ON " + A.RESET) if on else (A.RED + "OFF" + A.RESET)

    line(
        A.BOLD, "Toggles:  ",
        "auto-faucet[", tog(s.auto_faucet), "]   ",
        "auto-stake[", tog(s.auto_stake), "]",
    )
    line(
        A.DIM,
        f"  faucet: {s.n_faucet_ok} ok / {s.n_faucet_err} err   "
        f"stake: {s.n_stake_ok} ok / {s.n_stake_err} err",
    )
    line()

    line(A.BOLD, "Recent events (most recent first):")
    colors = {"ok": A.GREEN, "err": A.RED, "warn": A.YELLOW, "info": A.DIM}
    events = list(s.events)[:18]
    if not events:
        line(A.DIM, "  (none yet)")
    for ts, kind, msg in events:
        line(A.DIM, f"  {ts}  ", colors.get(kind, A.DIM), f"[{kind:4}] ", A.RESET, msg)
    for _ in range(max(0, 18 - len(events))):
        line(" ")
    line()
    line(
        A.DIM,
        "Keys:  (f) auto-faucet   (s) auto-stake   (c) faucet now   (k) stake now   "
        "(r) refresh   (a) pick finalizer   (+/-) max denom   (w) wipe snapshot (×2)   (q) quit",
    )

    sys.stdout.write("".join(buf))
    sys.stdout.flush()


# --- Entry point -----------------------------------------------------------


def main():
    p = argparse.ArgumentParser(
        description="Crosslink Season 1 auto-faucet + auto-stake sidecar",
    )
    p.add_argument("--config", default="sidecar.json", help="path to JSON config file")
    p.add_argument("--once-faucet", action="store_true", help="call faucet once and exit")
    p.add_argument("--once-stake", action="store_true", help="call stake once (if in window) and exit")
    p.add_argument("--info", action="store_true", help="print wallet info JSON and exit")
    p.add_argument(
        "--wipe-snapshot",
        action="store_true",
        help="drop the wallet-snapshot wipe marker (takes effect on next zebrad start)",
    )
    p.add_argument("--version", action="version", version=VERSION)
    args = p.parse_args()

    cfg = load_config(args.config)
    s = Sidecar(cfg)

    # Simple non-interactive modes --------------------------------------
    if args.info:
        try:
            j = rpc(cfg["rpc_url"], "staking_command", ["info"])
            try:
                # Pretty-print if it parses.
                print(json.dumps(json.loads(j), indent=2))
            except Exception:
                print(j)
        except RPCError as e:
            print(f"error: {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.wipe_snapshot:
        try:
            res = rpc(cfg["rpc_url"], "staking_command", ["wipe-snapshot"])
            print(res if isinstance(res, str) else json.dumps(res))
        except RPCError as e:
            print(f"error: {e}", file=sys.stderr)
            sys.exit(1)
        return

    if args.once_faucet:
        sys.exit(0 if s.call_faucet() else 1)

    if args.once_stake:
        s.poll_chain()
        s.poll_wallet()
        if s.height is None or not is_in_staking_window(s.height):
            print("error: not in staking window", file=sys.stderr)
            sys.exit(1)
        amt = s.pick_stake_amount()
        if amt <= 0 or not cfg.get("finalizer_hex"):
            print("error: nothing to stake (check balance + finalizer)", file=sys.stderr)
            sys.exit(1)
        sys.exit(0 if s.call_stake(amt, cfg["finalizer_hex"]) else 1)

    # Interactive TUI mode ----------------------------------------------
    enable_vt_mode_windows()
    kb_setup()
    sys.stdout.write(A.HIDE)
    try:
        s.log(f"sidecar started  (rpc={cfg['rpc_url']})", "info")
        while not s.stopped:
            try:
                k = get_keypress()
                if k is not None:
                    s.handle_key(k)
                s.tick()
                render(s)
            except RPCError as e:
                s.log(f"rpc err: {e}", "err")
            except Exception as e:
                # Last-resort: never let a bug in poll/render kill the app.
                s.log(f"loop err: {type(e).__name__}: {e}", "err")
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(A.SHOW)
        sys.stdout.write(A.RESET)
        sys.stdout.flush()
        kb_restore()
        save_config(cfg)
        print("bye.")


if __name__ == "__main__":
    main()
