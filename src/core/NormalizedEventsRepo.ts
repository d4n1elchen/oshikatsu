import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  eventResolutionDecisions,
  normalizedEventSources,
  normalizedEvents,
} from "../db/schema";
import { ExportQueueRepo } from "./ExportQueueRepo";
import { EmbeddingsRepo } from "./EmbeddingsRepo";
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
  private embeddings: EmbeddingsRepo | null;

  constructor(
    db: DbInstance = defaultDb,
    exportQueue: ExportQueueRepo | null = null,
    embeddings: EmbeddingsRepo | null = null
  ) {
    this.db = db;
    this.exportQueue = exportQueue;
    this.embeddings = embeddings;
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

    // Refresh the cached embedding when text-bearing fields could have changed.
    // We re-read the canonical row instead of relying on `fields` because the
    // operator may have changed only one of title/venueName and we want the
    // current canonical state to be embedded.
    if (this.embeddings && ("title" in fields || "venueName" in fields)) {
      const row = await this.db
        .select({ title: normalizedEvents.title, venueName: normalizedEvents.venueName })
        .from(normalizedEvents)
        .where(eq(normalizedEvents.id, id))
        .limit(1);
      if (row[0]) {
        await this.embeddings.embedAndStore({
          normalizedEventId: id,
          title: row[0].title,
          venueName: row[0].venueName,
        });
      }
    }

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

  /**
   * Operator-driven merge: fold `loserId` into `winnerId`. Moves every
   * normalized_event_sources row from loser to winner (dropping rows that
   * would conflict with the winner's existing sources), re-parents any
   * sub-events, writes a new `decision='merged'` row per affected
   * extracted event with `signals.manual_override=true` (superseding the
   * prior auto/manual decisions in-place), enqueues a cancelled change
   * for loser and an updated change for winner, then deletes loser.
   *
   * The training signal — the prior auto-decision's score and signals —
   * stays in event_resolution_decisions, marked superseded.
   */
  async mergeNormalizedEvents(loserId: string, winnerId: string, note?: string | null): Promise<void> {
    if (loserId === winnerId) throw new Error("loserId and winnerId must differ");

    this.db.transaction((tx) => {
      const both = tx
        .select({ id: normalizedEvents.id })
        .from(normalizedEvents)
        .where(sql`${normalizedEvents.id} IN (${loserId}, ${winnerId})`)
        .all();
      if (both.length !== 2) {
        throw new Error(`mergeNormalizedEvents: one or both events not found (loser=${loserId}, winner=${winnerId})`);
      }

      const loserSources = tx
        .select({ extractedEventId: normalizedEventSources.extractedEventId })
        .from(normalizedEventSources)
        .where(eq(normalizedEventSources.normalizedEventId, loserId))
        .all();

      const now = new Date();

      // For each extracted_event linked to the loser, write a new manual
      // merged-decision row pointing at the winner, superseding any
      // currently-valid prior decision for that extracted event.
      for (const src of loserSources) {
        const newDecisionId = randomUUID();
        tx.update(eventResolutionDecisions)
          .set({ supersededAt: now, supersededById: newDecisionId })
          .where(and(
            eq(eventResolutionDecisions.candidateExtractedEventId, src.extractedEventId),
            sql`${eventResolutionDecisions.supersededAt} IS NULL`
          ))
          .run();
        tx.insert(eventResolutionDecisions).values({
          id: newDecisionId,
          candidateExtractedEventId: src.extractedEventId,
          matchedNormalizedEventId: winnerId,
          decision: "merged",
          score: 1,
          signals: { manual_override: true, manual_action: "merge_normalized_events", loser_normalized_event_id: loserId },
          reason: `Operator merged normalized event ${loserId} into ${winnerId}.`,
          createdAt: now,
          note: note ?? null,
        }).run();
      }

      // Move source links. The unique index (normalized_event_id,
      // extracted_event_id) means a loser-side row pointing at an
      // extracted event already on the winner side would collide on
      // UPDATE — delete those first, then update the rest.
      const winnerExisting = tx
        .select({ extractedEventId: normalizedEventSources.extractedEventId })
        .from(normalizedEventSources)
        .where(eq(normalizedEventSources.normalizedEventId, winnerId))
        .all();
      const winnerHas = new Set(winnerExisting.map((r) => r.extractedEventId));
      for (const src of loserSources) {
        if (winnerHas.has(src.extractedEventId)) {
          tx.delete(normalizedEventSources)
            .where(and(
              eq(normalizedEventSources.normalizedEventId, loserId),
              eq(normalizedEventSources.extractedEventId, src.extractedEventId)
            ))
            .run();
        }
      }
      tx.update(normalizedEventSources)
        .set({ normalizedEventId: winnerId, role: "merged" })
        .where(eq(normalizedEventSources.normalizedEventId, loserId))
        .run();

      // Re-parent any sub-events of the loser to the winner.
      tx.update(normalizedEvents)
        .set({ parentEventId: winnerId, updatedAt: now })
        .where(eq(normalizedEvents.parentEventId, loserId))
        .run();

      // Bump winner's updated_at so consumers see a fresh version.
      tx.update(normalizedEvents)
        .set({ updatedAt: now })
        .where(eq(normalizedEvents.id, winnerId))
        .run();

      this.exportQueue?.enqueueSync(tx, loserId, "cancelled", now);
      this.exportQueue?.enqueueSync(tx, winnerId, "updated", now);

      // Delete the loser. FK ON DELETE CASCADE / SET NULL on
      // event_resolution_decisions.matched_normalized_event_id and
      // normalized_events.parent_event_id is handled by the schema.
      tx.delete(normalizedEvents).where(eq(normalizedEvents.id, loserId)).run();
    });

    log.info(`Operator merged normalized event ${loserId} into ${winnerId}`);
  }

  /**
   * Operator-driven re-parent: attach `eventId` as a sub-event of
   * `parentId`. Sets `parent_event_id`, writes a new manual
   * `decision='linked_as_sub'` per extracted_event linked to `eventId`
   * (superseding prior decisions), and enqueues an updated change so
   * downstream consumers see the new hierarchy.
   *
   * Rejects if `parentId` is itself parented (no nested sub-events) or
   * if `parentId === eventId`. Both events must exist.
   */
  async reparentNormalizedEvent(eventId: string, parentId: string, note?: string | null): Promise<void> {
    if (eventId === parentId) throw new Error("eventId and parentId must differ");

    this.db.transaction((tx) => {
      const rows = tx
        .select({ id: normalizedEvents.id, parentEventId: normalizedEvents.parentEventId })
        .from(normalizedEvents)
        .where(sql`${normalizedEvents.id} IN (${eventId}, ${parentId})`)
        .all();
      if (rows.length !== 2) {
        throw new Error(`reparentNormalizedEvent: one or both events not found (event=${eventId}, parent=${parentId})`);
      }
      const parentRow = rows.find((r) => r.id === parentId)!;
      if (parentRow.parentEventId) {
        throw new Error(`Target parent ${parentId} is itself a sub-event; only top-level events can be parents.`);
      }

      const sources = tx
        .select({ extractedEventId: normalizedEventSources.extractedEventId })
        .from(normalizedEventSources)
        .where(eq(normalizedEventSources.normalizedEventId, eventId))
        .all();

      const now = new Date();

      for (const src of sources) {
        const newDecisionId = randomUUID();
        tx.update(eventResolutionDecisions)
          .set({ supersededAt: now, supersededById: newDecisionId })
          .where(and(
            eq(eventResolutionDecisions.candidateExtractedEventId, src.extractedEventId),
            sql`${eventResolutionDecisions.supersededAt} IS NULL`
          ))
          .run();
        tx.insert(eventResolutionDecisions).values({
          id: newDecisionId,
          candidateExtractedEventId: src.extractedEventId,
          matchedNormalizedEventId: parentId,
          decision: "linked_as_sub",
          score: 1,
          signals: { manual_override: true, manual_action: "reparent_normalized_event", normalized_event_id: eventId },
          reason: `Operator attached normalized event ${eventId} as sub-event of ${parentId}.`,
          createdAt: now,
          note: note ?? null,
        }).run();
      }

      tx.update(normalizedEvents)
        .set({ parentEventId: parentId, updatedAt: now })
        .where(eq(normalizedEvents.id, eventId))
        .run();

      this.exportQueue?.enqueueSync(tx, eventId, "updated", now);
    });

    log.info(`Operator attached normalized event ${eventId} as sub-event of ${parentId}`);
  }
}
