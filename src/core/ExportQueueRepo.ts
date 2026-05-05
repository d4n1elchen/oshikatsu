import { asc, eq, gt, max } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { exportQueue } from "../db/schema";
import type { ExportQueueEntry, ExportChangeType } from "./types";

type DbInstance = typeof defaultDb;

/**
 * Accepts either the top-level `db` or a transaction handle. Drizzle's tx
 * type is structurally compatible with the db for our `select`/`insert`
 * usage but does not satisfy the `BetterSQLiteDatabase` brand.
 */
type SyncTxLike = Parameters<Parameters<DbInstance["transaction"]>[0]>[0] | DbInstance;

/**
 * Append-only log of consumer-visible mutations to normalized events.
 *
 * Writers: only `EventResolver`, inside the same transaction that mutates
 * `normalized_events`. Readers: `ExportRunner`, advancing per-consumer cursors.
 */
export class ExportQueueRepo {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }

  /**
   * Enqueue a row inside the caller's synchronous transaction. `version` is
   * the next monotonic integer per `normalized_event_id` (1, 2, 3, ...).
   *
   * Synchronous because `EventResolver` performs its canonical writes inside
   * a `db.transaction((tx) => ...)` callback, which is sync by design (the
   * better-sqlite3 driver does not support async callbacks).
   */
  enqueueSync(
    tx: SyncTxLike,
    normalizedEventId: string,
    changeType: ExportChangeType,
    enqueuedAt: Date = new Date()
  ): void {
    const rows = tx
      .select({ v: max(exportQueue.version) })
      .from(exportQueue)
      .where(eq(exportQueue.normalizedEventId, normalizedEventId))
      .all();
    const nextVersion = (rows[0]?.v ?? 0) + 1;
    tx.insert(exportQueue).values({
      normalizedEventId,
      changeType,
      version: nextVersion,
      enqueuedAt,
    }).run();
  }

  /** Current head position; new consumers start here (skipping history). */
  async headPosition(): Promise<number> {
    const rows = await this.db
      .select({ p: max(exportQueue.position) })
      .from(exportQueue);
    return rows[0]?.p ?? 0;
  }

  /**
   * Compacted batch of queue entries past the given cursor.
   *
   * Compaction: if multiple unseen entries exist for the same
   * normalized_event_id, keep only the latest. Earlier entries are skipped
   * (not deleted — another consumer may still need them). Returns entries
   * in ascending position order so the caller can advance the cursor by
   * processing left-to-right.
   */
  async pendingForCursor(cursorPosition: number, limit: number): Promise<ExportQueueEntry[]> {
    const candidates = await this.db
      .select()
      .from(exportQueue)
      .where(gt(exportQueue.position, cursorPosition))
      .orderBy(asc(exportQueue.position))
      .limit(limit);

    if (candidates.length === 0) return candidates;

    // Compact within this slice: keep only the latest entry per event id.
    const latestByEvent = new Map<string, ExportQueueEntry>();
    for (const row of candidates) {
      latestByEvent.set(row.normalizedEventId, row);
    }
    return [...latestByEvent.values()].sort((a, b) => a.position - b.position);
  }

  /**
   * The maximum queue position included in `entries`. The caller advances
   * its cursor to this value once delivery is durable.
   */
  maxPosition(entries: ExportQueueEntry[]): number {
    return entries.reduce((m, e) => (e.position > m ? e.position : m), 0);
  }
}
