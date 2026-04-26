import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
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

type ProcessBatchResult = {
  processed: number;
  failed: number;
};

export class ExtractionEngine {
  private rawStorage: RawStorage;
  private strategies: ExtractionStrategy[];
  private venueResolver: VenueResolver;

  constructor(
    private llm: LLMProvider,
    strategies: ExtractionStrategy[] = createDefaultExtractionStrategies(),
    venueResolver: VenueResolver = new VenueResolver()
  ) {
    this.rawStorage = new RawStorage();
    this.strategies = strategies;
    this.venueResolver = venueResolver;
  }

  /**
   * Process a batch of raw items.
   */
  async processBatch(limit: number = 20): Promise<ProcessBatchResult> {
    const items = await this.rawStorage.getUnprocessed(undefined, limit);
    const result: ProcessBatchResult = { processed: 0, failed: 0 };
    if (items.length === 0) return result;

    log.info(`Processing batch of ${items.length} item(s)`);

    for (const item of items) {
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
      await this.rawStorage.markError(item.id, e.message || "Unknown LLM extraction error");
      return false;
    }
  }

  private async hasExistingExtraction(rawItemId: string): Promise<boolean> {
    const eventRows = await db.select({ id: extractedEvents.id })
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
      throw new Error(`LLM extraction or sanitization failed: ${message}`);
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

    db.transaction((tx) => {
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

    const rows = await db.select({ artistId: watchTargets.artistId })
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
