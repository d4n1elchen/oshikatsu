import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { extractedEvents, extractedEventRelatedLinks, watchTargets } from "../db/schema";
import { RawStorage } from "./RawStorage";
import { VenueResolver } from "./VenueResolver";
import type { LLMProvider } from "./LLMProvider";
import {
  createDefaultExtractionStrategies,
  EventExtractionSchema,
  type EventExtractionResult,
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

      if (await this.hasExistingExtraction(item.id)) {
        await this.rawStorage.markProcessed(item.id);
        log.info(`Item ${item.id} already extracted; marked processed`);
        return true;
      }

      const systemPrompt = strategy.buildPrompt(context);

      const extracted = await this.extractAndSanitize(item, context, strategy, systemPrompt);

      await this.saveExtractedEvent(item, context, extracted);

      await this.rawStorage.markProcessed(item.id);
      log.info(`Extracted item ${item.id}`);
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
  ): Promise<EventExtractionResult> {
    try {
      const extracted = await this.llm.extract(context.rawContent, EventExtractionSchema, systemPrompt);
      return strategy.sanitize(item, context, extracted);
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
   * Save the parsed event with inline source provenance.
   */
  private async saveExtractedEvent(rawItem: any, context: SourceContext, extracted: EventExtractionResult): Promise<void> {
    const extractedEventId = randomUUID();
    const artistId = await this.getArtistIdForRawItem(rawItem);
    const startTime = extracted.start_time ? parsePersistedDate(extracted.start_time, "start_time") : null;
    const endTime = extracted.end_time ? parsePersistedDate(extracted.end_time, "end_time") : null;
    const venueResolution = await this.venueResolver.resolve({
      venueName: extracted.venue_name,
      venueUrl: extracted.venue_url,
    });

    this.db.transaction((tx) => {
      tx.insert(extractedEvents).values({
        id: extractedEventId,
        rawItemId: rawItem.id,
        artistId,
        title: extracted.title,
        description: extracted.description,
        startTime,
        endTime,
        venueId: venueResolution?.venue.id || null,
        venueName: extracted.venue_name || null,
        venueUrl: extracted.venue_url || null,
        type: extracted.type,
        eventScope: extracted.event_scope,
        parentEventHint: extracted.parent_event_hint || null,
        isCancelled: false,
        tags: extracted.tags,
        // Source provenance (formerly source_references)
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
}

function parsePersistedDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }
  return parsed;
}
