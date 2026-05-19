import { db as defaultDb } from "../db";
import { rawItems } from "../db/schema";
import type { NewRawItem, RawItem } from "./types";
import { eq, and, desc, count, inArray, sql } from "drizzle-orm";

type DbInstance = typeof defaultDb;

export class RawStorage {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }
  /**
   * Saves an array of raw items to the database.
   * Handles deduplication via the unique index on (source_name, source_id)
   * and using SQLite's INSERT OR IGNORE behavior.
   *
   * Errors propagate to the caller. The scheduler's per-target catch
   * then logs the failure as such rather than letting fetched data
   * silently disappear (the previous behavior swallowed the error and
   * returned 0, indistinguishable from "no new items").
   */
  async saveItems(
    watchTargetId: string,
    sourceName: string,
    items: Array<{ sourceId: string; sourceUrl?: string | null; rawData: any; postedAt?: Date | null }>
  ): Promise<number> {
    if (items.length === 0) return 0;

    const newItems: NewRawItem[] = items.map(item => ({
      id: `${sourceName}_${item.sourceId}`, // Deterministic ID for deduplication
      watchTargetId,
      sourceName,
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl ?? null,
      rawData: item.rawData,
      postedAt: item.postedAt ?? null,
      fetchedAt: new Date(),
      status: "new",
    }));

    const result = await this.db.insert(rawItems)
      .values(newItems)
      .onConflictDoNothing()
      .returning({ id: rawItems.id });

    return result.length;
  }

  /** Check if a raw item from this source already exists. */
  async exists(sourceName: string, sourceId: string): Promise<boolean> {
    const result = await this.db.select({ id: rawItems.id })
      .from(rawItems)
      .where(and(
        eq(rawItems.sourceName, sourceName),
        eq(rawItems.sourceId, sourceId),
      ))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Get unprocessed items, optionally filtered by source. Ordered oldest →
   * newest by the source post time (falling back to fetchedAt when the
   * connector didn't surface a posted_at).
   *
   * Chronological order matters because the resolver treats the first-seen
   * row as canonical for an event: the original announcement should become
   * the primary normalized row, with later mentions merging in as additional
   * sources rather than overwriting it. Annotations and reminder reposts
   * naturally land after their parent events too.
   */
  async getUnprocessed(sourceName?: string, limit: number = 100): Promise<RawItem[]> {
    const conditions = [eq(rawItems.status, "new")];
    if (sourceName) {
      conditions.push(eq(rawItems.sourceName, sourceName));
    }

    return this.db.select()
      .from(rawItems)
      .where(and(...conditions))
      .orderBy(sql`COALESCE(${rawItems.postedAt}, ${rawItems.fetchedAt}) ASC`)
      .limit(limit);
  }

  /**
   * Get items from the extraction queue plus any in error state, so the
   * Monitor view can surface failures that need manual retry. Ordered by
   * fetchedAt descending.
   */
  async getQueueAndErrors(sourceName?: string, limit: number = 100): Promise<RawItem[]> {
    const conditions = [inArray(rawItems.status, ["new", "error"])];
    if (sourceName) {
      conditions.push(eq(rawItems.sourceName, sourceName));
    }

    return this.db.select()
      .from(rawItems)
      .where(and(...conditions))
      .orderBy(desc(rawItems.fetchedAt))
      .limit(limit);
  }

  /** Mark an item as successfully processed. */
  async markProcessed(itemId: string): Promise<void> {
    await this.db.update(rawItems)
      .set({ status: "processed" })
      .where(eq(rawItems.id, itemId));
  }

  /** Mark an item as errored with details. */
  async markError(itemId: string, errorMessage: string, errorClass?: string | null): Promise<void> {
    await this.db.update(rawItems)
      .set({ status: "error", errorMessage, errorClass: errorClass ?? null })
      .where(eq(rawItems.id, itemId));
  }

  /**
   * Mark an item as an orphan post (mood, fan_engagement, other) that
   * is neither an event nor an annotation of one. Annotations of an
   * existing event flow through `extracted_events` instead, with
   * `record_kind='annotation'`. `error_message` carries the human
   * reason; `not_an_event_category` carries the structured bucket
   * the admin orphan-inspection surface groups on.
   */
  async markNotAnEvent(itemId: string, category: string, reason: string): Promise<void> {
    await this.db.update(rawItems)
      .set({
        status: "not_an_event",
        errorMessage: reason,
        errorClass: null,
        notAnEventCategory: category as "mood" | "fan_engagement" | "other",
      })
      .where(eq(rawItems.id, itemId));
  }

  /** Put an item back on the extraction queue. */
  async markNew(itemId: string): Promise<void> {
    await this.db.update(rawItems)
      .set({
        status: "new",
        errorMessage: null,
        errorClass: null,
        // Clear any prior not_an_event_category so a requeued orphan that
        // re-extracts as a real event doesn't carry a stale category label.
        notAnEventCategory: null,
      })
      .where(eq(rawItems.id, itemId));
  }

  /** Return storage statistics, optionally filtered by source. */
  async getStats(sourceName?: string): Promise<{ total: number; new: number; processed: number; error: number; notAnEvent: number }> {
    const conditions = sourceName ? [eq(rawItems.sourceName, sourceName)] : [];

    const rows = await this.db.select({
      status: rawItems.status,
      count: count(),
    })
      .from(rawItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(rawItems.status);

    const stats = { total: 0, new: 0, processed: 0, error: 0, notAnEvent: 0 };
    for (const row of rows) {
      const s = row.status as "new" | "processed" | "error" | "not_an_event";
      if (s === "not_an_event") {
        stats.notAnEvent = row.count;
      } else {
        stats[s] = row.count;
      }
      stats.total += row.count;
    }
    return stats;
  }
}
