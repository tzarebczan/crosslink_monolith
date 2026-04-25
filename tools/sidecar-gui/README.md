# Crosslink Sidecar (GUI)

Electron desktop app version of the Crosslink Season 1 auto-faucet + auto-stake
sidecar. Same backend contract as the Python TUI in `../sidecar/` — talks to a
patched zebrad over JSON-RPC, queues stakes via the new `staking_command` RPC,
and reads balances via `staking_command info`.

## Why this exists

The Python TUI works fine but isn't a great experience for a workshop attendee
who just wants a button to mash. This is the same logic in a proper GUI:

- **One window, four panels** — chain status, wallet balances, automation
  toggles, config — and a live event log along the bottom.
- **Real-time updates** broadcast from the main process. The renderer never
  polls anything; status arrives on each tick from main and React diffing keeps
  re-renders surgical.
- **Hardened** — JSON-RPC failures don't crash the UI; the scheduler backs off
  on errors and resumes when zebrad recovers.
- **Wipe wallet snapshot** — destructive maintenance button at the bottom of
  the Config panel that drops the wipe marker zebrad reads on next start. Use
  this if the wallet ever shows stale balances after a deep reorg or you want
  to force a clean rescan.

## Architecture

Layout cribbed from [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
(thin desktop shell, server logic in main, typed contracts shared with the
renderer).

```
src/
├── shared/contracts.ts     ── Zod schemas + IPC channel registry
├── main/
│   ├── index.ts            ── Electron entry, IPC routing
│   ├── sidecar.ts          ── Polling + automation engine
│   ├── scheduler.ts        ── Hand-rolled task scheduler with backoff
│   ├── rpc.ts              ── JSON-RPC client (fetch + AbortSignal.timeout)
│   └── store.ts            ── Persisted config (electron-store + Zod heal)
├── preload/index.ts        ── contextBridge → window.sidecar (typed API)
└── renderer/
    ├── App.tsx
    ├── store.ts            ── Zustand slices (status / events / config)
    └── components/         ── ChainPanel, WalletPanel, TogglesPanel, …
```

The contract layer (Zod schemas under `src/shared/contracts.ts`) is the single
source of truth. Main process validates everything coming over IPC before
acting on it; renderer gets type inference for free.

## Prerequisites

- A zebrad built from this branch with the sidecar backend patch (the
  `staking_command stake / info` handler — already in the same branch).
- Node 18+ and npm. Bun works too (`bun install && bun run dev`).

## Running

```bash
cd tools/sidecar-gui
npm install
npm run dev
```

The dev script uses `electron-vite` which gives you HMR for the renderer plus
auto-reload for main / preload changes. The first launch shows the config
panel — paste your `utest1…` UA, hit **Auto-pick** in the Automation panel to
fill the finalizer from chain, then flip the toggles.

## Building

```bash
npm run build         # produces unpacked binaries under out/
npm run dist          # produces installers under release/ via electron-builder
```

## Notes

- The auto-stake denomination ladder (`0.01 / 0.1 / 1 / 10 / 100 / 1000 / 10000`
  cTAZ) matches the viz-button progression. Configurable min/max in the Config
  panel; the engine picks the largest denom that fits both the cap and your
  spendable balance.
- The Python TUI in `../sidecar/` and this GUI can run simultaneously and
  poke the same zebrad — they don't share state, but the backend de-duplicates
  in-flight stakes so you won't get double-charged.
- `electron-builder` packaging targets are stubbed in `package.json`. If you
  want signed installers you'll need to fill in code-signing config.
