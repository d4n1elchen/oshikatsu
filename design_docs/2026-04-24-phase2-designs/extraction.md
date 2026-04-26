# Event Extraction Engine Design (Phase 2)

## Overview

The Phase 2 engine is responsible for transforming unstructured or platform-specific data (`RawItem`) into a unified, predictable extracted event candidate (`ExtractedEvent`). One raw item maps to at most one extracted event. This decoupling ensures later pipeline stages never need to understand the nuances of Twitter's GraphQL or Instagram's API.

Since artist announcements are highly unstructured natural language, the extraction engine relies on a **Local LLM** (Large Language Model) configured for structured data extraction.

Terminology note: earlier project docs used `normalized_events` or `preprocessed_events` for the Phase 2 output table. The implementation now uses `extracted_events` for this layer: source-derived, one-to-one with raw items, and not yet deduplicated. In the refined model, **normalized events** are the Phase 3 output after deduplication and merging.

## Core Pipeline Flow

1. **Batch Retrieval**: The engine queries `RawStorage` for a batch of items where `status = "new"`.
2. **Context Assembly**: The engine extracts the text payload (e.g., `full_text` from a tweet), metadata (publish time, author), and any embedded links available in the raw source payload.
3. **LLM Extraction**: The text and related link candidates are passed to a local LLM with a strict system prompt and a JSON schema.
4. **Validation**: The LLM output is validated against our expected TypeScript types using `zod`.
5. **Persistence**:
   - On successful LLM extraction, the extracted event record is written to extracted event storage, and the raw item is marked as `processed`.
   - If LLM extraction, schema validation, strategy sanitization, context assembly, or persistence fails, the raw item is marked as `error` and no extracted event is created. This intentionally avoids low-confidence fallback events. *(TODO: Implement an automated retry/repair mechanism for malformed LLM output or prompt tweaks in future phases).*

## Data Model (Extracted Event Storage)

We will introduce three new Drizzle tables.

### 1. `extracted_events`
The source-derived representation of one event candidate extracted from one raw item. This is not canonical and may later be merged with other extracted events.
- `id` (text, uuid)
- `artist_id` (text, optional fk to artists) — Direct artist link for Phase 3 candidate selection; nullable for historical rows and future non-watchlist imports
- `title` (text)
- `description` (text)
- `start_time` (timestamp, optional) — Event start time
- `end_time` (timestamp, optional)
- `venue_name` (text, optional)
- `venue_url` (text, optional)
- `type` (text) — e.g., 'live_stream', 'merchandise', 'concert'
- `is_cancelled` (boolean)
- `tags` (text, JSON array)
- `created_at` (timestamp)
- `updated_at` (timestamp)

### 2. `extracted_event_related_links`
Event-relevant links extracted from the source content or structured source payload.
- `id` (text, uuid)
- `extracted_event_id` (text, fk to extracted_events)
- `raw_item_id` (text, fk to raw_items, optional) — The raw item that supplied the link
- `url` (text)
- `title` (text, optional) — Human-readable link title
- `created_at` (timestamp)

`extracted_event_related_links` are not provenance records. They represent destinations that are useful to downstream consumers and users. Each related link stores only a URL and title.

### 3. `source_references`
The provenance links tying extracted events back to the raw data.
- `id` (text, uuid)
- `extracted_event_id` (text, fk to extracted_events)
- `raw_item_id` (text, fk to raw_items)
- `source_name` (text) — e.g., 'twitter'
- `source_id` (text) — The native platform ID (e.g., tweet ID)
- `publish_time` (timestamp)
- `url` (text)
- `author` (text)
- `venue_name` (text, optional) — Venue text extracted from this source item
- `venue_url` (text, optional) — Venue URL extracted from this source item
- `raw_content` (text)
- `created_at` (timestamp)

`source_references.url` points to the original source item, such as the tweet URL. If that tweet also mentions a ticket page or stream page, those links belong in `extracted_event_related_links`.

`source_references.venue_name` and `source_references.venue_url` preserve the venue extraction from that specific source item. Extracted event-level venue fields can use the best extracted display value, while source references retain the per-source extraction.

## Link Extraction

The extraction pipeline extracts related links from two places:

1. **Source payload links**: URLs exposed by the connector, such as expanded Twitter/X URLs in `rawData.legacy.entities.urls`.
2. **LLM-titled links**: The LLM may produce a human-readable title for candidate links using surrounding text.

The raw connector should preserve all link metadata available from the source. The extraction strategy should pass candidate links into the prompt so the LLM can decide which links are relevant to the event and title them appropriately.

If link title extraction fails, the engine should still preserve explicit candidate URLs with an empty or source-provided title rather than dropping them.

## The LLM Interface

We will build an `LLMProvider` interface to decouple the specific model from the business logic.

```typescript
export interface LLMProvider {
  /**
   * Extract structured data from raw text.
   * @param text The raw announcement text and related link candidates
   * @param schema The Zod schema enforcing the expected JSON output
   */
  extract<T>(text: string, schema: z.ZodSchema<T>): Promise<T>;
}
```

**Implementation details**:
- By default, we will implement `OllamaProvider` pointing to a local `localhost:11434` instance to ensure privacy and zero API costs.
- The prompt will instruct the model to "Extract the event details from the following announcement. Return ONLY valid JSON matching the provided schema."

## TUI Expansion

To monitor the extraction pipeline, we will add an **Events** tab to the TUI (accessible via `Tab` or `3`).

- **List View**: Displays successfully extracted events ordered by `start_time` until Phase 3 introduces canonical normalized events.
- **Detail View**: Shows the full event details, related links, and a nested list of its `source_references`.
- **Manual Reprocessing**: A keybind to retry extraction for `error` items in the Monitor tab.
