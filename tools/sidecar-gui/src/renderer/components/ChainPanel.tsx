import { STAKING_DAY_PERIOD, STAKING_DAY_WINDOW } from "@shared/contracts";
import { useStore } from "../store";

export function ChainPanel(): JSX.Element {
  const height = useStore((s) => s.status?.height ?? null);
  const isStaking = useStore((s) => s.status?.isStakingWindow ?? false);
  const left = useStore((s) => s.status?.blocksLeftInWindow ?? 0);
  const until = useStore((s) => s.status?.blocksUntilWindow ?? 0);

  const pos = height === null ? null : height % STAKING_DAY_PERIOD;
  const pct = pos === null ? 0 : (pos / STAKING_DAY_PERIOD) * 100;
  const windowEndPct = (STAKING_DAY_WINDOW / STAKING_DAY_PERIOD) * 100;

  return (
    <Card title="Chain">
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-zinc-400">block height</span>
          <span className="mono text-lg">
            {height === null ? "—" : height.toLocaleString()}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-zinc-400">in-cycle position</span>
          <span className="mono">
            {pos === null ? "—" : `${pos} / ${STAKING_DAY_PERIOD}`}
          </span>
        </div>

        <div className="relative h-2 bg-zinc-800 rounded overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-ok/40"
            style={{ width: `${windowEndPct}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="text-xs text-zinc-500 flex justify-between">
          <span>
            window: blocks 0–{STAKING_DAY_WINDOW - 1} of every {STAKING_DAY_PERIOD}
          </span>
          <span className={isStaking ? "text-ok" : "text-warn"}>
            {isStaking ? `${left} blocks left in window` : `${until} blocks until window opens`}
          </span>
        </div>
      </div>
    </Card>
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
