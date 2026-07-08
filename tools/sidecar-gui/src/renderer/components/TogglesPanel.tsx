import { useState } from "react";
import { useStore } from "../store";

export function TogglesPanel(): JSX.Element {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const status = useStore((s) => s.status);
  const [busy, setBusy] = useState<"faucet" | "stake" | "finalizer" | null>(null);

  if (!config) return <Card title="Toggles">…</Card>;

  const onToggle = async (which: "faucet" | "stake") => {
    setBusy(which);
    try {
      const next =
        which === "faucet"
          ? await window.sidecar.toggleAutoFaucet()
          : await window.sidecar.toggleAutoStake();
      if (next) setConfig(next);
    } finally {
      setBusy(null);
    }
  };

  const onTriggerFaucet = async () => {
    setBusy("faucet");
    try {
      await window.sidecar.triggerFaucet();
    } finally {
      setBusy(null);
    }
  };

  const onTriggerStake = async () => {
    setBusy("stake");
    try {
      await window.sidecar.triggerStake();
    } finally {
      setBusy(null);
    }
  };

  const onPickFinalizer = async () => {
    setBusy("finalizer");
    try {
      const next = await window.sidecar.pickFinalizer();
      if (next) setConfig(next);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Automation">
      <div className="space-y-3">
        <Row
          label="Auto-faucet"
          sub={`every ${config.faucetIntervalSec}s`}
          on={config.autoFaucet}
          counterOk={status?.faucetOk ?? 0}
          counterErr={status?.faucetErr ?? 0}
          onToggle={() => onToggle("faucet")}
          onTrigger={onTriggerFaucet}
          busy={busy === "faucet"}
          triggerDisabled={!config.userAddress}
        />
        <Row
          label="Auto-stake"
          sub={`every ${config.stakeIntervalSec}s, only in window`}
          on={config.autoStake}
          counterOk={status?.stakeOk ?? 0}
          counterErr={status?.stakeErr ?? 0}
          onToggle={() => onToggle("stake")}
          onTrigger={onTriggerStake}
          busy={busy === "stake"}
          triggerDisabled={
            !config.finalizerHex ||
            !(status?.isStakingWindow ?? false)
          }
        />
        <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between">
          <div>
            <div className="text-sm">Pick finalizer from roster</div>
            <div className="text-xs text-zinc-500">
              uses{" "}
              <code className="mono">get_tfl_roster_zats</code> — picks highest VP
            </div>
          </div>
          <button
            type="button"
            disabled={busy === "finalizer"}
            onClick={onPickFinalizer}
            className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
          >
            {busy === "finalizer" ? "…" : "Auto-pick"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function Row(props: {
  label: string;
  sub: string;
  on: boolean;
  counterOk: number;
  counterErr: number;
  onToggle(): void;
  onTrigger(): void;
  busy: boolean;
  triggerDisabled: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={props.onToggle}
        disabled={props.busy}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          props.on ? "bg-ok" : "bg-zinc-700"
        }`}
        aria-pressed={props.on}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            props.on ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <div className="flex-1">
        <div className="text-sm font-medium">{props.label}</div>
        <div className="text-xs text-zinc-500">{props.sub}</div>
      </div>
      <div className="text-xs text-zinc-500 mono">
        <span className="text-ok">{props.counterOk}</span>
        <span className="text-zinc-600 mx-0.5">/</span>
        <span className="text-bad">{props.counterErr}</span>
      </div>
      <button
        type="button"
        onClick={props.onTrigger}
        disabled={props.busy || props.triggerDisabled}
        className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded"
      >
        Run now
      </button>
    </div>
  );
}

function Card(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-300 mb-3 uppercase">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}
