import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { extractedEvents, extractedEventRelatedLinks, sourceReferences, watchTargets } from "../db/schema";
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

    console.log(`[ExtractionEngine] Processing batch of ${items.length} items...`);

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
      console.log(`[ExtractionEngine] Extracting item ${item.id} from ${item.sourceName}...`);
      
      const strategy = this.getStrategy(item.sourceName);
      const context = strategy.buildContext(item);
      if (!context) {
        throw new Error("No usable text context found in raw data");
      }

      if (await this.hasSourceReference(item.id)) {
        await this.rawStorage.markProcessed(item.id);
        console.log(`[ExtractionEngine] Item ${item.id} already has an extracted source reference; marked processed.`);
        return true;
      }

      const systemPrompt = strategy.buildPrompt(context);

      const extracted = await this.extractAndSanitize(item, context, strategy, systemPrompt);

      await this.saveExtractedEvent(item, context, extracted);

      await this.rawStorage.markProcessed(item.id);
      console.log(`[ExtractionEngine] Successfully extracted item ${item.id}`);
      return true;

    } catch (e: any) {
      console.error(`[ExtractionEngine] Failed to extract item ${item.id}:`, e);
      await this.rawStorage.markError(item.id, e.message || "Unknown LLM extraction error");
      return false;
    }
  }

  private async hasSourceReference(rawItemId: string): Promise<boolean> {
    const rows = await db.select({ id: sourceReferences.id })
      .from(sourceReferences)
      .where(eq(sourceReferences.rawItemId, rawItemId))
      .limit(1);

    return rows.length > 0;
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
   * Save the parsed event and its source reference.
   */
  private async saveExtractedEvent(rawItem: any, context: SourceContext, extracted: EventExtractionResult): Promise<void> {
    const extractedEventId = randomUUID();
    const referenceId = randomUUID();
    const artistId = await this.getArtistIdForRawItem(rawItem);
    const startTime = parsePersistedDate(extracted.start_time, "start_time");
    const endTime = extracted.end_time ? parsePersistedDate(extracted.end_time, "end_time") : null;
    const venueResolution = await this.venueResolver.resolve({
      venueName: extracted.venue_name,
      venueUrl: extracted.venue_url,
    });

    db.transaction((tx) => {
      // 1. Insert the extracted event
      tx.insert(extractedEvents).values({
        id: extractedEventId,
        artistId,
        title: extracted.title,
        description: extracted.description,
        startTime,
        endTime,
        venueId: venueResolution?.venue.id || null,
        venueName: extracted.venue_name || null,
        venueUrl: extracted.venue_url || null,
        type: extracted.type,
        isCancelled: false,
        tags: extracted.tags,
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

      tx.insert(sourceReferences).values({
        id: referenceId,
        extractedEventId,
        rawItemId: rawItem.id,
        sourceName: rawItem.sourceName,
        sourceId: rawItem.sourceId,
        publishTime: context.publishTime,
        url: context.url,
        author: context.author,
        venueName: extracted.venue_name || null,
        venueUrl: extracted.venue_url || null,
        rawContent: context.rawContent,
        createdAt: new Date(),
      }).run();
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
