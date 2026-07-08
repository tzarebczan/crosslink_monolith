import { useStore } from "../store";

/**
 * Top status bar — collapses the most-load-bearing facts into a single
 * always-visible strip: rpc reachability, chain height, and staking-window state.
 */
export function Header(): JSX.Element {
  const rpcUrl = useStore((s) => s.config?.rpcUrl ?? "");
  const reachable = useStore((s) => s.status?.rpcReachable ?? false);
  const height = useStore((s) => s.status?.height ?? null);
  const isStaking = useStore((s) => s.status?.isStakingWindow ?? false);
  const left = useStore((s) => s.status?.blocksLeftInWindow ?? 0);
  const until = useStore((s) => s.status?.blocksUntilWindow ?? 0);

  const dotColor = reachable ? "bg-ok" : "bg-bad";
  const stakingColor = isStaking ? "text-ok" : "text-bad";

  return (
    <header className="border-b border-zinc-800 px-4 py-3 flex items-center gap-4 bg-zinc-900/40">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dotColor}`} />
        <span className="font-semibold text-sm">Crosslink Sidecar</span>
        <span className="text-xs text-zinc-500 mono">{rpcUrl}</span>
      </div>
      <div className="flex-1" />
      <div className="text-sm">
        height:{" "}
        <span className="mono font-semibold">
          {height === null ? "—" : height.toLocaleString()}
        </span>
      </div>
      <div className={`text-sm font-semibold ${stakingColor}`}>
        {isStaking ? "STAKING" : "no stake"}
      </div>
      <div className="text-xs text-zinc-500 mono">
        {isStaking ? `${left} left` : `+${until} blocks`}
      </div>
    </header>
  );
}
