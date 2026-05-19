import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { artists, extractedEvents, extractedEventRelatedLinks, watchTargets } from "../db/schema";
import { getConfig } from "../config";
import { RawStorage } from "./RawStorage";
import { VenueResolver } from "./VenueResolver";
import type { LLMProvider } from "./LLMProvider";
import {
  createDefaultExtractionStrategies,
  ExtractionOutputSchema,
  sanitizeAnnotation,
  type AnnotationResult,
  type EventExtractionResult,
  type ExtractionOutput,
  type ExtractionStrategy,
  type SourceContext,
} from "./ExtractionStrategy";
import { tagged } from "./logger";

const log = tagged("ExtractionEngine");

type DbInstance = typeof defaultDb;

type ProcessBatchResult = {
  processed: number;
  failed: number;
};

export interface ExtractionEngineOptions {
  strategies?: ExtractionStrategy[];
  venueResolver?: VenueResolver;
  rawStorage?: RawStorage;
  db?: DbInstance;
}

export class ExtractionEngine {
  private rawStorage: RawStorage;
  private strategies: ExtractionStrategy[];
  private venueResolver: VenueResolver;
  private db: DbInstance;

  constructor(private llm: LLMProvider, options: ExtractionEngineOptions = {}) {
    this.db = options.db ?? defaultDb;
    this.rawStorage = options.rawStorage ?? new RawStorage(this.db);
    this.strategies = options.strategies ?? createDefaultExtractionStrategies();
    this.venueResolver = options.venueResolver ?? new VenueResolver(this.db);
  }

  /**
   * Process a batch of raw items. If `signal` aborts mid-batch, the loop
   * exits at the next item boundary and returns the counts collected so far.
   */
  async processBatch(limit: number = 20, signal?: AbortSignal): Promise<ProcessBatchResult> {
    const items = await this.rawStorage.getUnprocessed(undefined, limit);
    const result: ProcessBatchResult = { processed: 0, failed: 0 };
    if (items.length === 0) return result;

    for (const item of items) {
      if (signal?.aborted) break;
      if (await this.processItem(item)) {
        result.processed++;
      } else {
        result.failed++;
      }
    }

    return result;
  }

  /**
   * Process a single raw item.
   */
  async processItem(item: any): Promise<boolean> {
    try {
      log.info(`Extracting item ${item.id} from ${item.sourceName}`);
      
      const strategy = this.getStrategy(item.sourceName);
      const context = strategy.buildContext(item);
      if (!context) {
        throw new Error("No usable text context found in raw data");
      }
      context.fallbackTimezone = await this.resolveFallbackTimezone(item);

      if (await this.hasExistingExtraction(item.id)) {
        await this.rawStorage.markProcessed(item.id);
        log.info(`Item ${item.id} already extracted; marked processed`);
        return true;
      }

      const systemPrompt = strategy.buildPrompt(context);

      const result = await this.extractAndSanitize(item, context, strategy, systemPrompt);

      if (result.kind === "not_an_event") {
        await this.rawStorage.markNotAnEvent(item.id, result.category, result.reason);
        log.info(`Item ${item.id} classified as not_an_event (${result.category})`);
        return true;
      }

      if (result.kind === "annotation") {
        await this.saveExtractedAnnotation(item, context, result);
        await this.rawStorage.markProcessed(item.id);
        log.info(`Extracted annotation for item ${item.id} (${result.category})`);
        return true;
      }

      await this.saveExtractedEvents(item, context, result);

      await this.rawStorage.markProcessed(item.id);
      log.info(`Extracted item ${item.id} (${result.events.length} event${result.events.length > 1 ? "s" : ""})`);
      return true;

    } catch (e: any) {
      log.error(`Failed to extract item ${item.id}:`, e);
      const errorClass = e instanceof Error ? e.name : "Error";
      await this.rawStorage.markError(item.id, e.message || "Unknown LLM extraction error", errorClass);
      return false;
    }
  }

  private async hasExistingExtraction(rawItemId: string): Promise<boolean> {
    const eventRows = await this.db.select({ id: extractedEvents.id })
      .from(extractedEvents)
      .where(eq(extractedEvents.rawItemId, rawItemId))
      .limit(1);
    return eventRows.length > 0;
  }

  private getStrategy(sourceName: string): ExtractionStrategy {
    return this.strategies.find((strategy) => strategy.supports(sourceName)) ?? this.strategies[this.strategies.length - 1];
  }

  private async extractAndSanitize(
    item: any,
    context: SourceContext,
    strategy: ExtractionStrategy,
    systemPrompt: string
  ): Promise<ExtractionOutput> {
    try {
      const extracted = await this.llm.extract(context.rawContent, ExtractionOutputSchema, systemPrompt);
      if (extracted.kind === "not_an_event") {
        return extracted;
      }
      if (extracted.kind === "annotation") {
        return sanitizeAnnotation(context, extracted);
      }
      const sanitized: EventExtractionResult = strategy.sanitize(item, context, extracted);
      return sanitized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Preserve the original error.name so the Monitor view can group by class
      // (e.g., "ZodError", "LLMTimeoutError") instead of every failure
      // collapsing under a generic "Error".
      const wrapped = new Error(`LLM extraction or sanitization failed: ${message}`);
      if (error instanceof Error) {
        wrapped.name = error.name;
        (wrapped as Error & { cause?: unknown }).cause = error;
      }
      throw wrapped;
    }
  }

  /**
   * Save the parsed events (one or more, from a single raw item) with inline
   * source provenance. Sanitize has already ordered mains before subs.
   */
  private async saveExtractedEvents(rawItem: any, context: SourceContext, extracted: EventExtractionResult): Promise<void> {
    const artistId = await this.getArtistIdForRawItem(rawItem);

    // Resolve venues outside the transaction (sync drizzle transaction blocks
    // can't await). One pass per emitted event; same venue_name shows up
    // resolved to the same venues row by the alias lookup.
    const prepared = await Promise.all(extracted.events.map(async (event) => {
      const venueResolution = await this.venueResolver.resolve({
        venueName: event.venue_name,
        venueUrl: event.venue_url,
      });
      return { event, venueResolution, id: randomUUID() };
    }));

    this.db.transaction((tx) => {
      for (const { event, venueResolution, id: extractedEventId } of prepared) {
        const startTime = event.start_time ? parsePersistedDate(event.start_time, "start_time") : null;
        const endTime = event.end_time ? parsePersistedDate(event.end_time, "end_time") : null;

        tx.insert(extractedEvents).values({
          id: extractedEventId,
          rawItemId: rawItem.id,
          artistId,
          title: event.title,
          description: event.description,
          startTime,
          endTime,
          venueId: venueResolution?.venue.id || null,
          venueName: event.venue_name || null,
          // Fall back to the resolved venue's curated URL when the LLM didn't
          // surface one (the common case — posts rarely include the venue URL
          // inline). Operator edits to venues.url thus propagate to new events
          // for that venue without re-extraction.
          venueUrl: event.venue_url || venueResolution?.venue.url || null,
          type: event.type,
          recordKind: "event",
          eventScope: event.event_scope,
          parentEventHint: event.parent_event_hint || null,
          seriesName: event.series_name || null,
          isCancelled: false,
          tags: event.tags,
          // Source provenance (formerly source_references)
          publishTime: context.publishTime,
          author: context.author,
          sourceUrl: context.url,
          rawContent: context.rawContent,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).run();

        for (const link of event.related_links) {
          tx.insert(extractedEventRelatedLinks).values({
            id: randomUUID(),
            extractedEventId,
            rawItemId: rawItem.id,
            url: link.url,
            title: link.title || null,
            createdAt: new Date(),
          }).onConflictDoNothing().run();
        }
      }
    });
  }

  /**
   * Save an annotation row into extracted_events. Same provenance + 1:1
   * shape as events; record_kind='annotation' is the discriminator and
   * parent_event_hint carries the linkage to the existing event. Venue
   * resolution and start/end times don't apply to annotations.
   */
  private async saveExtractedAnnotation(rawItem: any, context: SourceContext, extracted: AnnotationResult): Promise<void> {
    const extractedEventId = randomUUID();
    const artistId = await this.getArtistIdForRawItem(rawItem);

    this.db.transaction((tx) => {
      tx.insert(extractedEvents).values({
        id: extractedEventId,
        rawItemId: rawItem.id,
        artistId,
        title: extracted.title,
        description: extracted.description,
        startTime: null,
        endTime: null,
        venueId: null,
        venueName: null,
        venueUrl: null,
        // For annotations, `type` carries the annotation category. The
        // record_kind discriminator tells callers which enum to read it as.
        type: extracted.category,
        recordKind: "annotation",
        eventScope: "unknown",
        parentEventHint: extracted.parent_event_hint,
        isCancelled: false,
        tags: extracted.tags,
        publishTime: context.publishTime,
        author: context.author,
        sourceUrl: context.url,
        rawContent: context.rawContent,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();

      for (const link of extracted.related_links) {
        tx.insert(extractedEventRelatedLinks).values({
          id: randomUUID(),
          extractedEventId,
          rawItemId: rawItem.id,
          url: link.url,
          title: link.title || null,
          createdAt: new Date(),
        }).onConflictDoNothing().run();
      }
    });
  }

  private async getArtistIdForRawItem(rawItem: any): Promise<string | null> {
    if (!rawItem.watchTargetId) return null;

    const rows = await this.db.select({ artistId: watchTargets.artistId })
      .from(watchTargets)
      .where(eq(watchTargets.id, rawItem.watchTargetId))
      .limit(1);

    return rows[0]?.artistId ?? null;
  }

  /**
   * Resolve the IANA timezone applied to offset-less timestamps in this
   * item's extraction. Order: artist.timezone → config.defaultTimezone →
   * null (which makes offset-less timestamps fail extraction).
   */
  private async resolveFallbackTimezone(rawItem: any): Promise<string | null> {
    if (rawItem.watchTargetId) {
      const rows = await this.db
        .select({ tz: artists.timezone })
        .from(watchTargets)
        .innerJoin(artists, eq(watchTargets.artistId, artists.id))
        .where(eq(watchTargets.id, rawItem.watchTargetId))
        .limit(1);
      const artistTz = rows[0]?.tz;
      if (artistTz) return artistTz;
    }
    return getConfig().defaultTimezone;
  }
}

function parsePersistedDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}
