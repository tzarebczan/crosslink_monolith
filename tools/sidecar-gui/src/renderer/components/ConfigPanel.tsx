import { useState } from "react";
import { STAKE_DENOMS_CTAZ, shortHex, type Config } from "@shared/contracts";
import { useStore } from "../store";

export function ConfigPanel(): JSX.Element {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const [draft, setDraft] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wipeNotice, setWipeNotice] = useState<string | null>(null);

  if (!config) return <Card title="Config">…</Card>;

  const view = draft ?? config;
  const dirty = draft !== null;

  const update = <K extends keyof Config>(key: K, value: Config[K]) => {
    setDraft({ ...view, [key]: value });
  };

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await window.sidecar.setConfig(draft);
      if (!res || !res.ok) {
        setError((res as { message?: string } | null)?.message ?? "save failed");
      } else {
        setConfig(res.config);
        setDraft(null);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Config">
      <div className="space-y-3 text-sm">
        <Field label="zebrad RPC URL">
          <input
            className="input"
            value={view.rpcUrl}
            onChange={(e) => update("rpcUrl", e.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label="user address (utest1…)">
          <input
            className="input mono text-xs"
            value={view.userAddress}
            onChange={(e) => update("userAddress", e.target.value.trim())}
            placeholder="utest1…"
            spellCheck={false}
          />
        </Field>

        <Field
          label="finalizer (32-byte hex)"
          hint={view.finalizerHex ? `currently: ${shortHex(view.finalizerHex)}` : "auto-pick from Automation panel →"}
        >
          <input
            className="input mono text-xs"
            value={view.finalizerHex}
            onChange={(e) => update("finalizerHex", e.target.value.trim())}
            placeholder="64-hex-char roster pub_key"
            spellCheck={false}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="faucet interval (s)">
            <input
              type="number"
              min={5}
              className="input"
              value={view.faucetIntervalSec}
              onChange={(e) =>
                update("faucetIntervalSec", Math.max(1, Number(e.target.value) || 0))
              }
            />
          </Field>
          <Field label="stake interval (s)">
            <input
              type="number"
              min={5}
              className="input"
              value={view.stakeIntervalSec}
              onChange={(e) =>
                update("stakeIntervalSec", Math.max(1, Number(e.target.value) || 0))
              }
            />
          </Field>
          <Field label="min denom (cTAZ)">
            <select
              className="input"
              value={view.stakeMinDenomCtaz}
              onChange={(e) => update("stakeMinDenomCtaz", e.target.value)}
            >
              {[...STAKE_DENOMS_CTAZ].reverse().map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="max denom (cTAZ)">
            <select
              className="input"
              value={view.stakeMaxDenomCtaz}
              onChange={(e) => update("stakeMaxDenomCtaz", e.target.value)}
            >
              {STAKE_DENOMS_CTAZ.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && <div className="text-xs text-bad">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => setDraft(null)}
            className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded"
          >
            Reset
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={onSave}
            className="px-3 py-1.5 text-sm bg-accent text-zinc-900 hover:bg-emerald-300 disabled:opacity-40 rounded font-medium"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {/* Maintenance: wipe the wallet snapshot so the next zebrad start
            does a fresh sync. */}
        <div className="mt-3 pt-3 border-t border-zinc-800/80 flex items-center justify-between">
          <div>
            <div className="text-sm">Wallet snapshot</div>
            <div className="text-xs text-zinc-500">
              Drops a marker zebrad reads on next launch and uses to discard
              the saved sync state. Takes effect at the next restart.
            </div>
          </div>
          <button
            type="button"
            disabled={wiping}
            onClick={async () => {
              if (
                !window.confirm(
                  "Drop wallet snapshot? Next zebrad start will resync from genesis.",
                )
              ) {
                return;
              }
              setWiping(true);
              setWipeNotice(null);
              try {
                const r = await window.sidecar.wipeSnapshot();
                setWipeNotice(r?.message ?? "(no response)");
              } finally {
                setWiping(false);
              }
            }}
            className="px-3 py-1.5 text-sm bg-bad/30 text-bad border border-bad/40 hover:bg-bad/50 disabled:opacity-40 rounded"
          >
            {wiping ? "Working…" : "Wipe snapshot"}
          </button>
        </div>
        {wipeNotice && (
          <div className="text-xs text-zinc-500 mono mt-1">{wipeNotice}</div>
        )}
      </div>
      <style>{`
        .input {
          width: 100%;
          background: rgb(24 24 27);
          border: 1px solid rgb(63 63 70);
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 13px;
          color: rgb(244 244 245);
          outline: none;
        }
        .input:focus { border-color: #8be0c4; }
      `}</style>
    </Card>
  );
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs text-zinc-400">{props.label}</span>
        {props.hint && <span className="text-xs text-zinc-600 mono">{props.hint}</span>}
      </div>
      {props.children}
    </label>
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
