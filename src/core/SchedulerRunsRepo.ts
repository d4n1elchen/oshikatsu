import { randomUUID } from "crypto";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { schedulerRuns } from "../db/schema";
import type { RunDetails, SchedulerRun, SchedulerRunStatus } from "./types";

type DbInstance = typeof defaultDb;

const ERROR_MESSAGE_MAX_LEN = 1000;

/**
 * Persistence layer for scheduler_runs. The Scheduler creates a row when a
 * task tick begins and updates it when the tick completes. The Monitor TUI
 * reads recent runs back through `recent()`.
 */
export class SchedulerRunsRepo {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }

  /** Insert a 'running' row at the start of a tick. Returns the run id. */
  async start(taskName: string, startedAt: Date = new Date()): Promise<string> {
    const id = randomUUID();
    await this.db.insert(schedulerRuns).values({
      id,
      taskName,
      startedAt,
      finishedAt: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      details: null,
    });
    return id;
  }

  /** Update a row to a terminal status. */
  async finish(
    id: string,
    status: Exclude<SchedulerRunStatus, "running">,
    options: { details?: RunDetails | null; error?: unknown } = {}
  ): Promise<void> {
    const { details = null, error } = options;
    const errorClass = error instanceof Error ? error.name : error ? "Error" : null;
    const errorMessage = error instanceof Error
      ? truncate(error.message, ERROR_MESSAGE_MAX_LEN)
      : error
        ? truncate(String(error), ERROR_MESSAGE_MAX_LEN)
        : null;

    await this.db
      .update(schedulerRuns)
      .set({
        finishedAt: new Date(),
        status,
        errorClass,
        errorMessage,
        details,
      })
      .where(eq(schedulerRuns.id, id));
  }

  /** Recent runs across all tasks, newest first. */
  async recent(limit: number = 50): Promise<SchedulerRun[]> {
    return this.db
      .select()
      .from(schedulerRuns)
      .orderBy(desc(schedulerRuns.startedAt))
      .limit(limit);
  }

  /** Recent runs for a single task, newest first. */
  async recentForTask(taskName: string, limit: number = 20): Promise<SchedulerRun[]> {
    return this.db
      .select()
      .from(schedulerRuns)
      .where(eq(schedulerRuns.taskName, taskName))
      .orderBy(desc(schedulerRuns.startedAt))
      .limit(limit);
  }

  /** Most recent terminal run for a task with the given status. */
  async latestWithStatus(taskName: string, status: SchedulerRunStatus): Promise<SchedulerRun | null> {
    const rows = await this.db
      .select()
      .from(schedulerRuns)
      .where(and(eq(schedulerRuns.taskName, taskName), eq(schedulerRuns.status, status)))
      .orderBy(desc(schedulerRuns.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Counts of runs since a cutoff, grouped by task and status. Used by the Monitor "in last hour" badges. */
  async countsSince(since: Date): Promise<Array<{ taskName: string; status: SchedulerRunStatus; count: number }>> {
    const rows = await this.db
      .select()
      .from(schedulerRuns)
      .where(gte(schedulerRuns.startedAt, since));

    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.taskName}:${r.status}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => {
      const [taskName, status] = key.split(":") as [string, SchedulerRunStatus];
      return { taskName, status, count };
    });
  }

  /** Delete runs older than `before`. Returns the number deleted. */
  async deleteOlderThan(before: Date): Promise<number> {
    const result = await this.db
      .delete(schedulerRuns)
      .where(lt(schedulerRuns.startedAt, before))
      .returning({ id: schedulerRuns.id });
    return result.length;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
