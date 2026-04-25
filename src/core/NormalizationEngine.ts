import { z } from "zod";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { normalizedEvents, sourceReferences, rawItems } from "../db/schema";
import { RawStorage } from "./RawStorage";
import type { LLMProvider } from "./LLMProvider";

export const EventExtractionSchema = z.object({
  title: z.string().describe("A short, descriptive title for the event"),
  description: z.string().describe("A detailed summary of the announcement"),
  event_time: z.string().describe("ISO 8601 timestamp of when the event actually occurs (NOT when the announcement was posted). If none is found, return the publish time of the post."),
  venue_name: z.string().optional().describe("Name of the physical venue or virtual platform (e.g., 'YouTube', 'Tokyo Dome')"),
  venue_url: z.string().optional().describe("URL to the stream or venue website"),
  type: z.enum(["live_stream", "merchandise", "release", "concert", "broadcast", "collaboration", "side_event", "announcement"]).describe("The category of the event"),
  tags: z.array(z.string()).describe("List of relevant tags (e.g., fandom, members involved, platform)"),
});

type ExtractedEvent = z.infer<typeof EventExtractionSchema>;

export class NormalizationEngine {
  private rawStorage: RawStorage;

  constructor(private llm: LLMProvider) {
    this.rawStorage = new RawStorage();
  }

  /**
   * Process a batch of raw items.
   */
  async processBatch(limit: number = 20): Promise<void> {
    const items = await this.rawStorage.getUnprocessed(undefined, limit);
    if (items.length === 0) return;

    console.log(`[NormalizationEngine] Processing batch of ${items.length} items...`);

    for (const item of items) {
      await this.processItem(item);
    }
  }

  /**
   * Process a single raw item.
   */
  async processItem(item: any): Promise<boolean> {
    try {
      console.log(`[NormalizationEngine] Normalizing item ${item.id} from ${item.sourceName}...`);
      
      // 1. Extract context text
      const textContext = this.extractContext(item);
      if (!textContext) {
        throw new Error("No usable text context found in raw data");
      }

      // 2. Build system prompt
      const systemPrompt = `You are an AI assistant designed to parse announcements from Japanese and English social media into structured event records.
Your task is to extract the details of the event being announced.

Input text:
"${textContext}"

Remember:
- event_time should be the time the actual event/stream happens, converted to ISO8601.
- If no explicit event time is given, use the post time if applicable.
- Translate Japanese summaries to English.`;

      // 3. Extract via LLM
      const extracted = await this.llm.extract(textContext, EventExtractionSchema, systemPrompt);

      // 4. Save to NormalizedStorage
      await this.saveNormalizedEvent(item, extracted);

      // 5. Mark success
      await this.rawStorage.markProcessed(item.id);
      console.log(`[NormalizationEngine] Successfully normalized item ${item.id}`);
      return true;

    } catch (e: any) {
      console.error(`[NormalizationEngine] Failed to normalize item ${item.id}:`, e);
      await this.rawStorage.markError(item.id, e.message || "Unknown LLM extraction error");
      return false;
    }
  }

  /**
   * Platform-specific heuristics to get the main text payload.
   */
  private extractContext(item: any): string | null {
    if (item.sourceName === "twitter") {
      const legacy = item.rawData?.legacy;
      if (!legacy) return null;
      
      const fullText = legacy.full_text || "";
      const createdAt = legacy.created_at || "";
      return `[Posted at: ${createdAt}]\n\n${fullText}`;
    }
    
    // Fallback: try to stringify
    return JSON.stringify(item.rawData);
  }

  /**
   * Save the parsed event and its source reference.
   */
  private async saveNormalizedEvent(rawItem: any, extracted: ExtractedEvent): Promise<void> {
    const eventId = randomUUID();
    const referenceId = randomUUID();

    await db.transaction(async (tx) => {
      // 1. Insert the event
      await tx.insert(normalizedEvents).values({
        id: eventId,
        title: extracted.title,
        description: extracted.description,
        eventTime: new Date(extracted.event_time),
        venueName: extracted.venue_name || null,
        venueUrl: extracted.venue_url || null,
        type: extracted.type,
        isCancelled: false,
        tags: extracted.tags,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 2. Insert the source reference
      // Try to extract URL and Author for Twitter
      let url = "";
      let author = "";
      let publishTime = new Date();

      if (rawItem.sourceName === "twitter") {
        const legacy = rawItem.rawData?.legacy;
        const core = rawItem.rawData?.core?.user_results?.result?.legacy;
        
        author = core?.screen_name || "unknown";
        url = `https://x.com/${author}/status/${rawItem.sourceId}`;
        
        if (legacy?.created_at) {
          publishTime = new Date(legacy.created_at);
        }
      }

      await tx.insert(sourceReferences).values({
        id: referenceId,
        eventId: eventId,
        rawItemId: rawItem.id,
        sourceName: rawItem.sourceName,
        sourceId: rawItem.sourceId,
        publishTime,
        url,
        author,
        rawContent: this.extractContext(rawItem) || "",
        createdAt: new Date(),
      });
    });
  }
}
