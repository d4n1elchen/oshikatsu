import { db } from "../db";
import { rawItems } from "../db/schema";
import type { NewRawItem } from "./types";
import { sql } from "drizzle-orm";

export class RawStorage {
  /**
   * Saves an array of raw items to the database.
   * Handles deduplication by generating a deterministic ID (sourceName_sourceId)
   * and using SQLite's INSERT OR IGNORE behavior.
   */
  async saveItems(sourceEntryId: string, sourceName: string, items: Array<{ sourceId: string; rawData: any }>): Promise<number> {
    if (items.length === 0) return 0;

    const newItems: NewRawItem[] = items.map(item => ({
      id: `${sourceName}_${item.sourceId}`, // Deterministic ID for deduplication
      sourceEntryId,
      sourceName,
      sourceId: item.sourceId,
      rawData: item.rawData,
      fetchedAt: new Date(),
      status: "new",
    }));

    // Perform batch insert with ON CONFLICT DO NOTHING to ignore duplicates
    try {
      const result = await db.insert(rawItems)
        .values(newItems)
        .onConflictDoNothing()
        .returning({ id: rawItems.id });
        
      return result.length; // Number of genuinely new items inserted
    } catch (e) {
      console.error(`Error saving raw items for sourceEntry ${sourceEntryId}:`, e);
      return 0;
    }
  }
}
