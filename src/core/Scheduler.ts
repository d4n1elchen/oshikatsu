import { tagged } from "./logger";
import { SchedulerRunsRepo } from "./SchedulerRunsRepo";
import type { RunDetails } from "./types";

const log = tagged("Scheduler");

export interface ScheduledTask {
  /** Display name used in logs (e.g. "Ingestion", "Extraction"). */
  name: string;
  /** Interval between runs, in minutes. */
  intervalMinutes: number;
  /**
   * The work to do on each tick. Errors are caught and logged; the loop
   * continues. The signal is aborted when `stop()` is called — cooperative
   * code should observe it at natural boundaries (between targets, between
   * items, around long awaits) and bail out cleanly.
   *
   * Returning a `RunDetails` payload (or nothing) is allowed; the payload is
   * persisted to `scheduler_runs.details` for the Monitor view.
   */
  run: (signal: AbortSignal) => Promise<RunDetails | void>;
  /** When true, run once immediately on start instead of waiting one interval. Default true. */
  runImmediately?: boolean;
}

type TaskState = {
  task: ScheduledTask;
  running: boolean;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  controller: AbortController | null;
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
 * Stop is graceful: it aborts the in-flight task's signal so cooperative code
 * can bail at the next checkpoint, then awaits any in-flight runs before
 * returning.
 *
 * Every tick records a row in `scheduler_runs` so the Monitor view can answer
 * "is this task healthy?" without log archaeology.
 */
export class Scheduler {
  private states: TaskState[] = [];
  private isStarted = false;
  private runs: SchedulerRunsRepo;

  constructor(runs: SchedulerRunsRepo = new SchedulerRunsRepo()) {
    this.runs = runs;
  }

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
      controller: null,
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
   * Stop all loops gracefully. Aborts in-flight signals, cancels pending
   * timers, and waits for any in-flight runs to drain.
   */
  async stop(): Promise<void> {
    for (const state of this.states) {
      state.running = false;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.controller?.abort();
    }
    await Promise.all(this.states.map((s) => s.inFlight).filter((p): p is Promise<void> => p !== null));
    log.info("Stopped");
  }

  private async tick(state: TaskState, runNow: boolean): Promise<void> {
    if (!state.running) return;

    if (runNow) {
      state.controller = new AbortController();
      state.inFlight = this.runOnce(state, state.controller.signal);
      await state.inFlight;
      state.inFlight = null;
      state.controller = null;
    }

    if (!state.running) return;

    const intervalMs = state.task.intervalMinutes * 60 * 1000;
    state.timer = setTimeout(() => {
      void this.tick(state, true);
    }, intervalMs);
  }

  private async runOnce(state: TaskState, signal: AbortSignal): Promise<void> {
    const startedAt = new Date();
    let runId: string;
    try {
      runId = await this.runs.start(state.task.name, startedAt);
    } catch (e) {
      // Persistence failure for the start row shouldn't kill the task. Log
      // and proceed without recording — the run will appear absent from the
      // Monitor view but the work still happens.
      log.error(`${state.task.name} failed to record run start:`, e);
      // Run anyway, without persistence wiring.
      try {
        await state.task.run(signal);
      } catch (taskErr) {
        if (!isAbortError(taskErr)) log.error(`${state.task.name} run error:`, taskErr);
      }
      return;
    }

    try {
      const details = (await state.task.run(signal)) ?? null;
      const durationMs = Date.now() - startedAt.getTime();
      logSummary(state.task.name, "completed", durationMs, details, null);
      await this.runs.finish(runId, "completed", { details });
    } catch (e) {
      const durationMs = Date.now() - startedAt.getTime();
      if (isAbortError(e)) {
        logSummary(state.task.name, "aborted", durationMs, null, null);
        await this.runs.finish(runId, "aborted");
        return;
      }
      logSummary(state.task.name, "failed", durationMs, null, e);
      log.error(`${state.task.name} run error:`, e);
      await this.runs.finish(runId, "failed", { error: e });
    }
  }
}

function logSummary(
  name: string,
  status: "completed" | "failed" | "aborted",
  durationMs: number,
  details: RunDetails | null,
  error: unknown
): void {
  const dur = formatDuration(durationMs);
  const detailStr = details ? formatDetails(details) : "";
  if (status === "completed") {
    log.info(`${name} run completed in ${dur}${detailStr ? `; ${detailStr}` : ""}`);
  } else if (status === "aborted") {
    log.info(`${name} run aborted after ${dur}`);
  } else {
    const errStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error(`${name} run failed after ${dur}: ${errStr}`);
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function formatDetails(details: RunDetails): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(", ");
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || (e as { code?: unknown }).code === "ABORT_ERR")
  );
}
