/**
 * Renderer state store.
 *
 * Performance pattern: status / events / config are three independent slices.
 * Components subscribe via `useStore(state => state.foo.bar)` so each panel
 * only re-renders when its slice changes.
 *
 * Status updates arrive on a stream from main; the entire snapshot is replaced
 * on each tick. We don't try to diff — Zustand handles equality and React 18
 * batches the resulting commits.
 */
import { create } from "zustand";
import type { Config, LogEvent, Status } from "@shared/contracts";

interface State {
  config: Config | null;
  status: Status | null;
  events: LogEvent[];
  initialized: boolean;

  setConfig(cfg: Config | null): void;
  setStatus(s: Status | null): void;
  setEvents(events: LogEvent[]): void;
  appendEvent(e: LogEvent): void;
  markInitialized(): void;
}

const EVENTS_CAP = 500;

export const useStore = create<State>((set) => ({
  config: null,
  status: null,
  events: [],
  initialized: false,
  setConfig: (config) => set({ config }),
  setStatus: (status) => set({ status }),
  setEvents: (events) => set({ events }),
  appendEvent: (e) =>
    set((s) => ({ events: [e, ...s.events].slice(0, EVENTS_CAP) })),
  markInitialized: () => set({ initialized: true }),
}));
