import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { normalizedEvents } from "../db/schema";
import { ExportQueueRepo } from "./ExportQueueRepo";
import { tagged } from "./logger";

const log = tagged("NormalizedEventsRepo");

type DbInstance = typeof defaultDb;

export type UpdateNormalizedEventFields = {
  title?: string;
  description?: string;
  startTime?: Date | null;
  endTime?: Date | null;
  isCancelled?: boolean;
  tags?: string[];
  parentEventId?: string | null;
  venueId?: string | null;
  venueName?: string | null;
  venueUrl?: string | null;
  type?: string;
};

const ALLOWED_FIELDS: Array<keyof UpdateNormalizedEventFields> = [
  "title",
  "description",
  "startTime",
  "endTime",
  "isCancelled",
  "tags",
  "parentEventId",
  "venueId",
  "venueName",
  "venueUrl",
  "type",
];

export class NormalizedEventsRepo {
  private db: DbInstance;
  private exportQueue: ExportQueueRepo | null;

  constructor(db: DbInstance = defaultDb, exportQueue: ExportQueueRepo | null = null) {
    this.db = db;
    this.exportQueue = exportQueue;
  }

  /**
   * Operator-driven edit: write the supplied fields, set `operatorOwned`
   * so the resolver leaves the row alone on its next pass, and enqueue an
   * "updated" (or "cancelled" when the cancel flag flipped on) export
   * change so downstream consumers see the edit.
   */
  async updateNormalizedEvent(id: string, fields: UpdateNormalizedEventFields): Promise<void> {
    const sanitized: Partial<UpdateNormalizedEventFields> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in fields) {
        (sanitized as any)[key] = (fields as any)[key];
      }
    }

    this.db.transaction((tx) => {
      const existing = tx
        .select({ isCancelled: normalizedEvents.isCancelled })
        .from(normalizedEvents)
        .where(eq(normalizedEvents.id, id))
        .all();
      if (existing.length === 0) {
        throw new Error(`normalized_event ${id} not found`);
      }

      const wasCancelled = existing[0]!.isCancelled;
      const now = new Date();

      tx.update(normalizedEvents)
        .set({
          ...sanitized,
          operatorOwned: true,
          operatorEditedAt: now,
          updatedAt: now,
        })
        .where(eq(normalizedEvents.id, id))
        .run();

      const cancellationFlippedOn =
        sanitized.isCancelled === true && !wasCancelled;
      this.exportQueue?.enqueueSync(tx, id, cancellationFlippedOn ? "cancelled" : "updated", now);
    });

    log.info(`Operator-edited normalized event ${id}`);
  }

  /**
   * Hand a frozen row back to the resolver. Clears `operatorOwned` and
   * `operatorEditedAt`; does not touch any field values.
   */
  async releaseFromOperator(id: string): Promise<void> {
    await this.db
      .update(normalizedEvents)
      .set({
        operatorOwned: false,
        operatorEditedAt: null,
      })
      .where(eq(normalizedEvents.id, id));
    log.info(`Released normalized event ${id} back to resolver`);
  }
}
