import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { normalizedEvents, eventRelatedLinks, sourceReferences } from "../db/schema";
import { RawStorage } from "./RawStorage";
import { VenueResolver } from "./VenueResolver";
import type { LLMProvider } from "./LLMProvider";
import {
  createDefaultNormalizationStrategies,
  EventExtractionSchema,
  type ExtractedEvent,
  type NormalizationStrategy,
  type SourceContext,
  parseDateOrFallback,
} from "./NormalizationStrategy";

type ProcessBatchResult = {
  processed: number;
  failed: number;
};

export class NormalizationEngine {
  private rawStorage: RawStorage;
  private strategies: NormalizationStrategy[];
  private venueResolver: VenueResolver;

  constructor(
    private llm: LLMProvider,
    strategies: NormalizationStrategy[] = createDefaultNormalizationStrategies(),
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

    console.log(`[NormalizationEngine] Processing batch of ${items.length} items...`);

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
      console.log(`[NormalizationEngine] Normalizing item ${item.id} from ${item.sourceName}...`);
      
      const strategy = this.getStrategy(item.sourceName);
      const context = strategy.buildContext(item);
      if (!context) {
        throw new Error("No usable text context found in raw data");
      }

      if (await this.hasSourceReference(item.id)) {
        await this.rawStorage.markProcessed(item.id);
        console.log(`[NormalizationEngine] Item ${item.id} already has a normalized source reference; marked processed.`);
        return true;
      }

      const systemPrompt = strategy.buildPrompt(context);

      const extracted = await this.extractWithFallback(item, context, strategy, systemPrompt);

      await this.saveNormalizedEvent(item, context, extracted);

      await this.rawStorage.markProcessed(item.id);
      console.log(`[NormalizationEngine] Successfully normalized item ${item.id}`);
      return true;

    } catch (e: any) {
      console.error(`[NormalizationEngine] Failed to normalize item ${item.id}:`, e);
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

  private getStrategy(sourceName: string): NormalizationStrategy {
    return this.strategies.find((strategy) => strategy.supports(sourceName)) ?? this.strategies[this.strategies.length - 1];
  }

  private async extractWithFallback(
    item: any,
    context: SourceContext,
    strategy: NormalizationStrategy,
    systemPrompt: string
  ): Promise<ExtractedEvent> {
    try {
      const extracted = await this.llm.extract(context.rawContent, EventExtractionSchema, systemPrompt);
      return strategy.sanitize(item, context, extracted);
    } catch (error) {
      console.warn(`[NormalizationEngine] LLM extraction failed for ${item.id}; using strategy fallback.`, error);
      return strategy.fallback(item, context);
    }
  }

  /**
   * Save the parsed event and its source reference.
   */
  private async saveNormalizedEvent(rawItem: any, context: SourceContext, extracted: ExtractedEvent): Promise<void> {
    const eventId = randomUUID();
    const referenceId = randomUUID();
    const venueResolution = await this.venueResolver.resolve({
      venueName: extracted.venue_name,
      venueUrl: extracted.venue_url,
    });

    db.transaction((tx) => {
      // 1. Insert the event
      tx.insert(normalizedEvents).values({
        id: eventId,
        title: extracted.title,
        description: extracted.description,
        eventTime: parseDateOrFallback(extracted.event_time, context.publishTime.toISOString()),
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
        tx.insert(eventRelatedLinks).values({
          id: randomUUID(),
          eventId,
          rawItemId: rawItem.id,
          url: link.url,
          title: link.title || null,
          createdAt: new Date(),
        }).onConflictDoNothing().run();
      }

      tx.insert(sourceReferences).values({
        id: referenceId,
        eventId: eventId,
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
}
