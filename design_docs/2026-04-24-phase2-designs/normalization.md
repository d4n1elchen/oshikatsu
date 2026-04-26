# Normalization Engine Design (Phase 2)

## Overview

The Normalization Engine is responsible for transforming unstructured or platform-specific data (`RawItem`) into a unified, predictable schema (`NormalizedEvent`). This decoupling ensures that downstream consumers (UI, Calendar exports, automations) never need to understand the nuances of Twitter's GraphQL or Instagram's API.

Since artist announcements are highly unstructured natural language, the Normalization Engine relies on a **Local LLM** (Large Language Model) configured for structured data extraction.

## Core Pipeline Flow

1. **Batch Retrieval**: The engine queries `RawStorage` for a batch of items where `status = "new"`.
2. **Context Assembly**: The engine extracts the text payload (e.g., `full_text` from a tweet), metadata (publish time, author), and any embedded links available in the raw source payload.
3. **LLM Extraction**: The text and related link candidates are passed to a local LLM with a strict system prompt and a JSON schema.
4. **Validation**: The LLM output is validated against our expected TypeScript types using `zod`.
5. **Persistence**:
   - On successful LLM extraction, the unified record is written to `NormalizedStorage`, and the raw item is marked as `processed`.
   - If LLM extraction, schema validation, strategy sanitization, context assembly, or persistence fails, the raw item is marked as `error` and no normalized event is created. This intentionally avoids low-confidence fallback events. *(TODO: Implement an automated retry/repair mechanism for malformed LLM output or prompt tweaks in future phases).*

## Data Model (Normalized Storage)

We will introduce three new Drizzle tables.

### 1. `normalized_events`
The canonical representation of an event.
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

### 2. `event_related_links`
Event-relevant links extracted from the source content or structured source payload.
- `id` (text, uuid)
- `event_id` (text, fk to normalized_events)
- `raw_item_id` (text, fk to raw_items, optional) — The raw item that supplied the link
- `url` (text)
- `title` (text, optional) — Human-readable link title
- `created_at` (timestamp)

`event_related_links` are not provenance records. They represent destinations that are useful to downstream consumers and users. Each related link stores only a URL and title.

### 3. `source_references`
The provenance links tying normalized events back to the raw data.
- `id` (text, uuid)
- `event_id` (text, fk to normalized_events)
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

`source_references.url` points to the original source item, such as the tweet URL. If that tweet also mentions a ticket page or stream page, those links belong in `event_related_links`.

`source_references.venue_name` and `source_references.venue_url` preserve the venue extraction from that specific source item. Event-level venue fields can use the best display value, while source references retain the per-source extraction.

## Link Extraction

The normalization pipeline extracts related links from two places:

1. **Source payload links**: URLs exposed by the connector, such as expanded Twitter/X URLs in `rawData.legacy.entities.urls`.
2. **LLM-titled links**: The LLM may produce a human-readable title for candidate links using surrounding text.

The raw connector should preserve all link metadata available from the source. The normalization strategy should pass candidate links into the prompt so the LLM can decide which links are relevant to the event and title them appropriately.

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

To monitor the normalization pipeline, we will add an **Events** tab to the TUI (accessible via `Tab` or `3`).

- **List View**: Displays successfully normalized events ordered by `start_time`.
- **Detail View**: Shows the full event details, related links, and a nested list of its `source_references`.
- **Manual Reprocessing**: A keybind to retry normalization for `error` items in the Monitor tab.
