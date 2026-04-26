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

We will introduce two Drizzle tables.

### 1. `extracted_events`
The source-derived representation of one event candidate extracted from one raw item. This is not canonical and may later be merged with other extracted events. Source provenance is folded directly into this table because each extracted event is 1:1 with a raw item (enforced by a unique index on `raw_item_id`).
- `id` (text, uuid)
- `raw_item_id` (text, fk to raw_items, unique) — The source raw item this extracted event came from
- `artist_id` (text, optional fk to artists) — Direct artist link for Phase 3 candidate selection; nullable for historical rows and future non-watchlist imports
- `title` (text)
- `description` (text)
- `start_time` (timestamp, optional) — Event start time
- `end_time` (timestamp, optional)
- `venue_id` (text, optional fk to venues) — Canonical venue when resolved
- `venue_name` (text, optional)
- `venue_url` (text, optional)
- `type` (text) — e.g., 'live_stream', 'merchandise', 'concert'
- `event_scope` (text) — `main`, `sub`, or `unknown`
- `parent_event_hint` (text, optional) — Best-effort main-event title for sub-events when the source names or clearly implies it
- `is_cancelled` (boolean)
- `tags` (text, JSON array)
- `publish_time` (timestamp) — When the source item was published (provenance)
- `author` (text) — Source author / username / channel (provenance)
- `source_url` (text) — Canonical URL of the source item itself, e.g. the tweet URL (provenance)
- `raw_content` (text) — Full source-item text passed to the LLM (provenance)
- `created_at` (timestamp)
- `updated_at` (timestamp)

`source_url` points to the source item; links mentioned inside the source content belong in `extracted_event_related_links`.

`source_name` and `source_id` are intentionally not duplicated on this table — they remain on `raw_items` and are reachable via the `raw_item_id` join.

`venue_name` and `venue_url` capture the per-source venue extraction. They are also the best display values for this extracted event because each extracted event has exactly one source.

### 2. `extracted_event_related_links`
Event-relevant links extracted from the source content or structured source payload.
- `id` (text, uuid)
- `extracted_event_id` (text, fk to extracted_events)
- `raw_item_id` (text, fk to raw_items, optional) — The raw item that supplied the link
- `url` (text)
- `title` (text, optional) — Human-readable link title
- `created_at` (timestamp)

`extracted_event_related_links` are not provenance records. They represent destinations that are useful to downstream consumers and users. Each related link stores only a URL and title.

> **Historical note.** Earlier drafts of this design introduced a separate `source_references` table that mirrored the 1:1 relationship between extracted events and raw items. It was folded into `extracted_events` once that 1:1 relationship was enforced by a unique index, removing the always-needed join.

## Link Extraction

Sub-event announcements are valid extracted events even when they do not include the main event's full details. `start_time` is optional because the source may announce a real sub-event without providing that sub-event's time. The extractor may classify `event_scope = "sub"` and store a `parent_event_hint`, but it must not invent a main event as fact. Phase 3/3.1 owns canonical parent-child linking.

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
- **Detail View**: Shows the full event details, related links, and the inline source provenance (author, source URL, raw content).
- **Manual Reprocessing**: A keybind to retry extraction for `error` items in the Monitor tab.
