import { eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import {
  artists,
  extractedEvents,
  normalizedEventSources,
  normalizedEvents,
  venues,
} from "../db/schema";
import type { Consumer } from "./Consumer";
import { ExportCursorsRepo } from "./ExportCursorsRepo";
import { ExportQueueRepo } from "./ExportQueueRepo";
import { tagged } from "./logger";
import type {
  ExportQueueEntry,
  ExportRecord,
  RunDetails,
} from "./types";

const log = tagged("ExportRunner");

type DbInstance = typeof defaultDb;

type ConsumerSummary = {
  delivered: number;
  rejected: number;
  retried: number;
  skipped: number;
  errorClass?: string;
};

/**
 * Per-tick coordinator: for each registered consumer, read the cursor,
 * pull pending queue entries, compact, project to `ExportRecord`s, hand
 * to `consumer.deliver`, and advance the cursor on success.
 *
 * Consumers are independent — one's failure does not abort the others.
 * Per-consumer outcomes are surfaced via the `details` payload returned
 * to the Scheduler, which the Monitor view already renders.
 */
export class ExportRunner {
  private db: DbInstance;
  private consumers: Consumer[];
  private queue: ExportQueueRepo;
  private cursors: ExportCursorsRepo;
  private batchSize: number;
  private startedConsumers: Set<string> = new Set();

  constructor(
    consumers: Consumer[],
    options: {
      db?: DbInstance;
      queue?: ExportQueueRepo;
      cursors?: ExportCursorsRepo;
      batchSize?: number;
    } = {}
  ) {
    this.db = options.db ?? defaultDb;
    this.consumers = consumers;
    this.queue = options.queue ?? new ExportQueueRepo(this.db);
    this.cursors = options.cursors ?? new ExportCursorsRepo(this.db);
    this.batchSize = options.batchSize ?? 100;
  }

  /** Lifecycle: invoke once before the first tick. */
  async start(): Promise<void> {
    const head = await this.queue.headPosition();
    for (const consumer of this.consumers) {
      // Initialize cursor at the current head — new consumers do not replay
      // history by default. Operators can rewind via reset:export-cursor.
      await this.cursors.initIfMissing(consumer.name, head);
      if (consumer.start) {
        await consumer.start();
      }
      this.startedConsumers.add(consumer.name);
    }
  }

  /** Lifecycle: invoke during graceful shutdown. */
  async stop(): Promise<void> {
    for (const consumer of this.consumers) {
      if (this.startedConsumers.has(consumer.name) && consumer.stop) {
        try {
          await consumer.stop();
        } catch (e) {
          log.error(`${consumer.name} failed to stop:`, e);
        }
      }
    }
  }

  /** One scheduled tick. Result is the `details` payload for `scheduler_runs`. */
  async tick(signal: AbortSignal): Promise<RunDetails> {
    const summaries: Record<string, ConsumerSummary> = {};

    for (const consumer of this.consumers) {
      if (signal.aborted) break;
      summaries[consumer.name] = await this.runConsumer(consumer, signal);
    }

    return { consumers: summaries };
  }

  private async runConsumer(consumer: Consumer, signal: AbortSignal): Promise<ConsumerSummary> {
    const summary: ConsumerSummary = { delivered: 0, rejected: 0, retried: 0, skipped: 0 };

    const cursor = await this.cursors.get(consumer.name);
    if (!cursor) {
      // start() should have created this. Defensive fallback to head.
      const head = await this.queue.headPosition();
      await this.cursors.initIfMissing(consumer.name, head);
      return summary;
    }

    const entries = await this.queue.pendingForCursor(cursor.cursorPosition, this.batchSize);
    if (entries.length === 0) return summary;

    const records = await this.projectToRecords(entries);
    if (records.length === 0) {
      // Events were deleted out from under us; advance past these positions.
      await this.cursors.advance(consumer.name, this.queue.maxPosition(entries));
      summary.skipped = entries.length;
      return summary;
    }

    let result;
    try {
      result = await consumer.deliver(records, signal);
    } catch (e) {
      // Whole-batch failure — retry next tick. Cursor unchanged.
      summary.retried = records.length;
      summary.errorClass = e instanceof Error ? e.name : "Error";
      log.error(`${consumer.name} deliver threw:`, e);
      return summary;
    }

    const delivered = new Set(result.delivered);
    const rejected = new Set((result.rejected ?? []).map((r) => r.id));

    summary.delivered = delivered.size;
    summary.rejected = rejected.size;
    summary.retried = records.length - delivered.size - rejected.size;

    // Advance cursor only past entries the consumer either delivered or
    // explicitly rejected. Implicit-retry entries hold the cursor back.
    const advanceablePositions: number[] = [];
    let blocked = false;
    for (const entry of entries) {
      const recordForEntry = records.find((r) => r.id === entry.normalizedEventId);
      if (!recordForEntry) {
        // Entry was compacted away (dominated by a later entry for same id);
        // advance past it freely.
        advanceablePositions.push(entry.position);
        continue;
      }
      const id = recordForEntry.id;
      if (delivered.has(id) || rejected.has(id)) {
        if (!blocked) advanceablePositions.push(entry.position);
      } else {
        // Hit a retry: do not advance past it or any later entry for any id,
        // since later entries may depend on prior delivery.
        blocked = true;
      }
    }

    if (advanceablePositions.length > 0) {
      const newCursor = Math.max(...advanceablePositions);
      await this.cursors.advance(consumer.name, newCursor);
    }

    return summary;
  }

  /**
   * Project a slice of queue entries into `ExportRecord`s by reading the
   * current state of `normalized_events` (and joining sources/artist/venue).
   * Records are returned in the same order as the input entries.
   */
  private async projectToRecords(entries: ExportQueueEntry[]): Promise<ExportRecord[]> {
    const ids = [...new Set(entries.map((e) => e.normalizedEventId))];

    const events = await this.db
      .select()
      .from(normalizedEvents)
      .where(inArray(normalizedEvents.id, ids));
    const eventById = new Map(events.map((e) => [e.id, e]));

    // Artist lookups
    const artistIds = [...new Set(events.map((e) => e.artistId).filter((x): x is string => x != null))];
    const artistRows = artistIds.length > 0
      ? await this.db.select().from(artists).where(inArray(artists.id, artistIds))
      : [];
    const artistById = new Map(artistRows.map((a) => [a.id, a]));

    // Venue lookups (event already carries venue_name/url; this just adds the
    // canonical name when venue_id is set).
    const venueIds = [...new Set(events.map((e) => e.venueId).filter((x): x is string => x != null))];
    const venueRows = venueIds.length > 0
      ? await this.db.select().from(venues).where(inArray(venues.id, venueIds))
      : [];
    const venueById = new Map(venueRows.map((v) => [v.id, v]));

    // Sources for provenance
    const sourcesRows = ids.length > 0
      ? await this.db
          .select({
            normalizedEventId: normalizedEventSources.normalizedEventId,
            sourceUrl: extractedEvents.sourceUrl,
            publishTime: extractedEvents.publishTime,
            author: extractedEvents.author,
          })
          .from(normalizedEventSources)
          .innerJoin(extractedEvents, eq(normalizedEventSources.extractedEventId, extractedEvents.id))
          .where(inArray(normalizedEventSources.normalizedEventId, ids))
      : [];
    const sourcesByEvent = new Map<string, { sourceUrl: string; publishTime: string; author: string }[]>();
    for (const s of sourcesRows) {
      const list = sourcesByEvent.get(s.normalizedEventId) ?? [];
      list.push({
        sourceUrl: s.sourceUrl,
        publishTime: s.publishTime.toISOString(),
        author: s.author,
      });
      sourcesByEvent.set(s.normalizedEventId, list);
    }

    const now = new Date().toISOString();
    const records: ExportRecord[] = [];
    for (const entry of entries) {
      const ev = eventById.get(entry.normalizedEventId);
      if (!ev) continue; // event deleted; runner will advance past it

      const artist = ev.artistId ? artistById.get(ev.artistId) ?? null : null;
      const canonicalVenue = ev.venueId ? venueById.get(ev.venueId) ?? null : null;

      records.push({
        id: ev.id,
        version: entry.version,
        changeType: entry.changeType,
        parentId: ev.parentEventId,
        artist: artist ? { id: artist.id, name: artist.name } : null,
        title: ev.title,
        description: ev.description,
        startTime: ev.startTime ? ev.startTime.toISOString() : null,
        endTime: ev.endTime ? ev.endTime.toISOString() : null,
        venue: {
          id: ev.venueId,
          name: canonicalVenue?.name ?? ev.venueName,
          url: canonicalVenue?.url ?? ev.venueUrl,
        },
        type: ev.type,
        isCancelled: ev.isCancelled,
        tags: ev.tags,
        sources: sourcesByEvent.get(ev.id) ?? [],
        emittedAt: now,
      });
    }
    return records;
  }
}
