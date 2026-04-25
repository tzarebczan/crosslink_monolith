import { useStore } from "../store";

const COLORS: Record<string, string> = {
  ok: "text-ok",
  err: "text-bad",
  warn: "text-warn",
  info: "text-zinc-400",
};

export function EventsLog(): JSX.Element {
  const events = useStore((s) => s.events);

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-300 px-4 pt-3 pb-2 uppercase">
        Recent events
      </h2>
      <div className="max-h-72 overflow-y-auto scroll-thin px-4 pb-3 mono text-xs space-y-1">
        {events.length === 0 ? (
          <div className="text-zinc-600 italic">no events yet…</div>
        ) : (
          events.slice(0, 200).map((e, i) => (
            <div key={`${e.ts}-${i}`} className="flex gap-3">
              <span className="text-zinc-600 shrink-0">{tsFmt(e.ts)}</span>
              <span className={`shrink-0 ${COLORS[e.kind] ?? "text-zinc-300"}`}>
                [{e.kind.toUpperCase().padEnd(4)}]
              </span>
              <span className="text-zinc-200 break-all">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function tsFmt(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
