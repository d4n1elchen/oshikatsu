import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { exportCursors } from "../db/schema";
import type { ExportCursor } from "./types";

type DbInstance = typeof defaultDb;

/**
 * Persistence for per-consumer delivery position. The cursor is the largest
 * `export_queue.position` the consumer has durably accepted. Each consumer
 * is identified by its stable `name`; renaming a consumer is a migration.
 */
export class ExportCursorsRepo {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }

  async get(consumerName: string): Promise<ExportCursor | null> {
    const rows = await this.db
      .select()
      .from(exportCursors)
      .where(eq(exportCursors.consumerName, consumerName))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Initialize a brand-new consumer at `headPosition` so it does not replay
   * history. Idempotent — a no-op if the cursor already exists.
   */
  async initIfMissing(consumerName: string, headPosition: number): Promise<void> {
    await this.db
      .insert(exportCursors)
      .values({
        consumerName,
        cursorPosition: headPosition,
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  async advance(consumerName: string, position: number): Promise<void> {
    await this.db
      .update(exportCursors)
      .set({ cursorPosition: position, updatedAt: new Date() })
      .where(eq(exportCursors.consumerName, consumerName));
  }

  /** For the operator-facing reset:export-cursor script. */
  async reset(consumerName: string, position: number): Promise<void> {
    await this.db
      .insert(exportCursors)
      .values({
        consumerName,
        cursorPosition: position,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: exportCursors.consumerName,
        set: { cursorPosition: position, updatedAt: new Date() },
      });
  }
}
