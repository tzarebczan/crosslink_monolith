# Crosslink Season 1 auto-faucet + auto-stake sidecar

A tiny Python TUI that rides alongside a `zebrad-viz` node and automates the
two buttons you'd otherwise be pounding by hand on Season 1:

- **Auto-faucet**: every 30 s (configurable), fire `requestfaucetdonation`
  against your UA so cTAZ keeps landing in your wallet.
- **Auto-stake**: while the chain is in a Staking Day window
  (`block_height % 150 < 70`), queue a stake for the largest allowed
  denomination that fits your spendable balance. Follows the viz-button
  progression: `0.01 · 0.1 · 1 · 10 · 100 · 1000 · 10000` cTAZ.

## Requirements

- A zebrad built from this branch. The sidecar relies on a small backend
  patch (also in this repo) that wires `staking_command` through to the
  wallet. Without it, the RPC returns `NotImplemented`.
- Python 3.7+. Stdlib only — no pip install needed.

## Quick start

```bash
# 1. Make sure zebrad is running (viz or headless, either works)
# 2. Copy the example config, then edit it
cp tools/sidecar/sidecar.example.json tools/sidecar/sidecar.json

# Paste your UA from the viz wallet tab into user_address
#   "user_address": "utest1q...",

# Leave finalizer_hex empty and hit 'a' once the sidecar is running — it will
# pick the highest-voting-power roster member and persist it.

# 3. Launch the TUI
python tools/sidecar/auto_crosslink.py --config tools/sidecar/sidecar.json
```

## TUI keybindings

| Key   | Action                                                         |
|-------|----------------------------------------------------------------|
| `f`   | Toggle auto-faucet                                             |
| `s`   | Toggle auto-stake                                              |
| `c`   | Call faucet once (one-shot)                                    |
| `k`   | Stake once (one-shot; only during an open staking window)      |
| `r`   | Force-refresh chain height + wallet snapshot                   |
| `a`   | Auto-pick finalizer from `get_tfl_roster_zats` (highest VP)    |
| `+/-` | Step the max stake denomination up/down through the ladder     |
| `w`   | Wipe wallet snapshot (press twice within 5s to confirm; takes effect on next zebrad restart) |
| `q`   | Quit                                                           |

Toggles persist to the config file immediately.

## Non-interactive modes

```bash
python tools/sidecar/auto_crosslink.py --info             # print wallet JSON
python tools/sidecar/auto_crosslink.py --once-faucet      # one faucet call
python tools/sidecar/auto_crosslink.py --once-stake       # one stake (if in window)
python tools/sidecar/auto_crosslink.py --wipe-snapshot    # drop the wallet-snapshot wipe marker
```

Exit status is `0` on success, non-zero on failure — useful for scripting
over e.g. Task Scheduler or cron.

## Config file

| Key                      | Default                   | Meaning                                                   |
|--------------------------|---------------------------|-----------------------------------------------------------|
| `rpc_url`                | `http://127.0.0.1:8232`   | zebrad JSON-RPC endpoint                                  |
| `user_address`           | *(empty)*                 | UA where faucet payments land (copy from viz)             |
| `finalizer_hex`          | *(empty)*                 | 64-char hex of roster `pub_key`; press `a` to auto-pick   |
| `auto_faucet`            | `false`                   | start with auto-faucet on                                 |
| `auto_stake`             | `false`                   | start with auto-stake on                                  |
| `faucet_interval_s`      | `30`                      | minimum seconds between faucet calls                      |
| `stake_interval_s`       | `20`                      | minimum seconds between stake calls in a window           |
| `stake_max_denom_ctaz`   | `"1"`                     | cap on auto-picked denomination (e.g. `"10"`, `"0.1"`)    |
| `stake_min_denom_ctaz`   | `"0.01"`                  | floor — below this we don't stake                         |

Amounts can be strings (`"0.01"`) or numbers (`0.01`); strings are safer for
the small denominations since they avoid IEEE-754 drift.

## Backend patch

The sidecar wouldn't be possible without a small backend patch, also landed
in this branch:

- `wallet/src/lib.rs` — adds a `STAKE_REQUEST` closure + `STAKE_Q` drain
  (paralleling the existing faucet pattern) and a `WALLET_INFO` closure that
  serialises `wallet_state` to JSON.
- `zebra-state/src/crosslink.rs` — `TFLServiceResponse::StakingCmd` now
  carries a `String` so we can return wallet snapshots.
- `zebra-crosslink/src/lib.rs` — adds a `StakingCmd` handler accepting:
    - `stake <amount_zats> <finalizer_hex>`  → queues a
      `WalletAction::StakeToFinalizer`
    - `info`                                  → returns JSON snapshot
    - `help`                                  → usage string
- `zebra-rpc/src/methods.rs` — updates the `staking_command` RPC handler to
  read the new response variant.

Finalizer hex is decoded in natural (big-endian) byte order to match the
`pub_key` field returned by `get_tfl_roster_zats`. If you prefer to paste
from the viz GUI (which uses the reverse byte order), either pre-reverse the
bytes yourself or let the sidecar pick via `a`.

## Notes / gotchas

- The backend de-duplicates a stake while one is already in-flight, so the
  sidecar won't queue a second stake until the first lands. You'll see
  `waiting_for_stake: true` in the Wallet panel during that time.
- The faucet pays `0.5 cTAZ` per call and holds up to 16 pending requests.
  If you hammer it faster than the miner wallet can ship them, the RPC
  returns "faucet too busy".
- `user_shielded_spendable` reflects what's *currently* spendable. If you
  just called the faucet, the new notes are in `user_shielded_pending` until
  they settle — you may need to wait a couple blocks before auto-stake can
  pick up the larger denomination.
