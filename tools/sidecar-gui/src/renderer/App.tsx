import { useEffect } from "react";
import { useStore } from "./store";
import { ChainPanel } from "./components/ChainPanel";
import { WalletPanel } from "./components/WalletPanel";
import { TogglesPanel } from "./components/TogglesPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { EventsLog } from "./components/EventsLog";
import { Header } from "./components/Header";

/**
 * Mount-time bootstrap: hydrate config, status and events from main, then
 * subscribe to live broadcasts. The unsubscribe handlers from preload must
 * fire on unmount, otherwise we'd leak listeners across StrictMode double-runs.
 */
export default function App(): JSX.Element {
  const setConfig = useStore((s) => s.setConfig);
  const setStatus = useStore((s) => s.setStatus);
  const setEvents = useStore((s) => s.setEvents);
  const appendEvent = useStore((s) => s.appendEvent);
  const markInitialized = useStore((s) => s.markInitialized);
  const initialized = useStore((s) => s.initialized);

  useEffect(() => {
    let unsubStatus = () => {};
    let unsubEvent = () => {};
    let cancelled = false;

    void (async () => {
      const [cfg, status, events] = await Promise.all([
        window.sidecar.getConfig(),
        window.sidecar.getStatus(),
        window.sidecar.getEvents(),
      ]);
      if (cancelled) return;
      setConfig(cfg);
      setStatus(status);
      setEvents(events);
      markInitialized();

      unsubStatus = window.sidecar.onStatus((s) => setStatus(s));
      unsubEvent = window.sidecar.onEvent((e) => appendEvent(e));
    })();

    return () => {
      cancelled = true;
      unsubStatus();
      unsubEvent();
    };
  }, [appendEvent, markInitialized, setConfig, setEvents, setStatus]);

  if (!initialized) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto scroll-thin">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          <ChainPanel />
          <WalletPanel />
          <TogglesPanel />
          <ConfigPanel />
        </div>
        <div className="px-4 pb-4">
          <EventsLog />
        </div>
      </main>
    </div>
  );
}
