/**
 * Light-weight scheduler used by the sidecar. Handles three independent
 * timers: chain poll, wallet poll, and the two automation loops.
 *
 * Why hand-rolled instead of e.g. `node-cron`? We need:
 *   - jittered backoff on failure so a flapping zebrad doesn't get hammered
 *   - immediate first-tick on enable so the user sees feedback
 *   - clean teardown when the user changes intervals or quits
 *
 * Each task tracks its own deadline; the runner ticks every 250ms which is
 * generous for second-resolution scheduling and keeps the CPU cost trivial.
 */
import { performance } from "node:perf_hooks";

export interface Task {
  name: string;
  intervalMs: number;
  /** if true, runs immediately on enable instead of waiting `intervalMs` first */
  runImmediately?: boolean;
  fn: () => Promise<void> | void;
  /** if false, scheduler skips this task without removing it */
  enabled: () => boolean;
  /** seconds of jitter to add on failure (avoids thundering herd) */
  failureBackoffMaxMs?: number;
}

interface TaskState {
  task: Task;
  nextRunMs: number;
  inFlight: boolean;
  failureCount: number;
}

export class Scheduler {
  private tasks = new Map<string, TaskState>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  add(task: Task): void {
    const now = performance.now();
    this.tasks.set(task.name, {
      task,
      nextRunMs: task.runImmediately ? now : now + task.intervalMs,
      inFlight: false,
      failureCount: 0,
    });
  }

  /** Update an existing task's interval without losing its deadline alignment. */
  setInterval(name: string, intervalMs: number): void {
    const s = this.tasks.get(name);
    if (!s) return;
    s.task.intervalMs = intervalMs;
  }

  /** Force the next run to happen on the very next tick. */
  bump(name: string): void {
    const s = this.tasks.get(name);
    if (!s) return;
    s.nextRunMs = performance.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 250);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = performance.now();
    for (const state of this.tasks.values()) {
      if (state.inFlight) continue;
      if (now < state.nextRunMs) continue;
      if (!state.task.enabled()) {
        // Push deadline forward so we don't busy-tick a disabled task.
        state.nextRunMs = now + state.task.intervalMs;
        continue;
      }
      state.inFlight = true;
      void this.run(state).finally(() => {
        state.inFlight = false;
      });
    }
  }

  private async run(state: TaskState): Promise<void> {
    try {
      await state.task.fn();
      state.failureCount = 0;
      state.nextRunMs = performance.now() + state.task.intervalMs;
    } catch (_e) {
      state.failureCount += 1;
      const cap = state.task.failureBackoffMaxMs ?? 5_000;
      const jitter = Math.floor(Math.random() * cap);
      state.nextRunMs =
        performance.now() + state.task.intervalMs + jitter * Math.min(state.failureCount, 4);
    }
  }
}
