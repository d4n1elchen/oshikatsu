import { db } from "../db";
import { rawItems } from "../db/schema";
import type { NewRawItem, RawItem } from "./types";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { randomUUID } from "crypto";

export class RawStorage {
  /**
   * Saves an array of raw items to the database.
   * Handles deduplication via the unique index on (source_name, source_id)
   * and using SQLite's INSERT OR IGNORE behavior.
   */
  async saveItems(watchTargetId: string, sourceName: string, items: Array<{ sourceId: string; rawData: any }>): Promise<number> {
    if (items.length === 0) return 0;

    const newItems: NewRawItem[] = items.map(item => ({
      id: `${sourceName}_${item.sourceId}`, // Deterministic ID for deduplication
      watchTargetId,
      sourceName,
      sourceId: item.sourceId,
      rawData: item.rawData,
      fetchedAt: new Date(),
      status: "new",
    }));

    try {
      const result = await db.insert(rawItems)
        .values(newItems)
        .onConflictDoNothing()
        .returning({ id: rawItems.id });

      return result.length;
    } catch (e) {
      console.error(`Error saving raw items for watchTarget ${watchTargetId}:`, e);
      return 0;
    }
  }

  /** Check if a raw item from this source already exists. */
  async exists(sourceName: string, sourceId: string): Promise<boolean> {
    const result = await db.select({ id: rawItems.id })
      .from(rawItems)
      .where(and(
        eq(rawItems.sourceName, sourceName),
        eq(rawItems.sourceId, sourceId),
      ))
      .limit(1);

    return result.length > 0;
  }

  /** Get unprocessed items, optionally filtered by source, ordered by fetchedAt descending. */
  async getUnprocessed(sourceName?: string, limit: number = 100): Promise<RawItem[]> {
    const conditions = [eq(rawItems.status, "new")];
    if (sourceName) {
      conditions.push(eq(rawItems.sourceName, sourceName));
    }

    return db.select()
      .from(rawItems)
      .where(and(...conditions))
      .orderBy(desc(rawItems.fetchedAt))
      .limit(limit);
  }

  /** Mark an item as successfully processed. */
  async markProcessed(itemId: string): Promise<void> {
    await db.update(rawItems)
      .set({ status: "processed" })
      .where(eq(rawItems.id, itemId));
  }

  /** Mark an item as errored with details. */
  async markError(itemId: string, errorMessage: string): Promise<void> {
    await db.update(rawItems)
      .set({ status: "error", errorMessage })
      .where(eq(rawItems.id, itemId));
  }

  /** Return storage statistics, optionally filtered by source. */
  async getStats(sourceName?: string): Promise<{ total: number; new: number; processed: number; error: number }> {
    const conditions = sourceName ? [eq(rawItems.sourceName, sourceName)] : [];

    const rows = await db.select({
      status: rawItems.status,
      count: count(),
    })
      .from(rawItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(rawItems.status);

    const stats = { total: 0, new: 0, processed: 0, error: 0 };
    for (const row of rows) {
      const s = row.status as "new" | "processed" | "error";
      stats[s] = row.count;
      stats.total += row.count;
    }
    return stats;
  }
}
