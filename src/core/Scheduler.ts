import { tagged } from "./logger";

const log = tagged("Scheduler");

export interface ScheduledTask {
  /** Display name used in logs (e.g. "Ingestion", "Extraction"). */
  name: string;
  /** Interval between runs, in minutes. */
  intervalMinutes: number;
  /** The work to do on each tick. Errors are caught and logged; the loop continues. */
  run: () => Promise<void>;
  /** When true, run once immediately on start instead of waiting one interval. Default true. */
  runImmediately?: boolean;
}

type TaskState = {
  task: ScheduledTask;
  running: boolean;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
};

/**
 * Generic background-task scheduler.
 *
 * Each registered task gets its own self-paced loop. The next tick is scheduled
 * via setTimeout *after* the current run completes (not setInterval), so a slow
 * run can never overlap the next one. Tasks are independent of each other and
 * may execute concurrently — callers must ensure each task is internally
 * idempotent if it shares state with others.
 *
 * Stop is graceful: it cancels pending timers and awaits any in-flight runs
 * before returning.
 */
export class Scheduler {
  private states: TaskState[] = [];
  private isStarted = false;

  /**
   * Register a task. Must be called before `start()`. Returns `this` for
   * chaining: `new Scheduler().add(...).add(...).start()`.
   */
  add(task: ScheduledTask): this {
    if (this.isStarted) {
      throw new Error("Cannot add tasks after start(); register them first.");
    }
    this.states.push({
      task,
      running: false,
      timer: null,
      inFlight: null,
    });
    return this;
  }

  /** Kick off all registered tasks. */
  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;

    for (const state of this.states) {
      state.running = true;
      log.info(`Started ${state.task.name}; interval ${state.task.intervalMinutes}m`);
      void this.tick(state, state.task.runImmediately !== false);
    }
  }

  /**
   * Stop all loops gracefully. Cancels pending timers and waits for any
   * in-flight runs to finish.
   */
  async stop(): Promise<void> {
    for (const state of this.states) {
      state.running = false;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    await Promise.all(this.states.map((s) => s.inFlight).filter((p): p is Promise<void> => p !== null));
    log.info("Stopped");
  }

  private async tick(state: TaskState, runNow: boolean): Promise<void> {
    if (!state.running) return;

    if (runNow) {
      state.inFlight = state.task.run().catch((e) => {
        log.error(`${state.task.name} run error:`, e);
      });
      await state.inFlight;
      state.inFlight = null;
    }

    if (!state.running) return;

    const intervalMs = state.task.intervalMinutes * 60 * 1000;
    state.timer = setTimeout(() => {
      void this.tick(state, true);
    }, intervalMs);
  }
}
