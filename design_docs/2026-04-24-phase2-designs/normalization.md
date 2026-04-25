# Normalization Engine Design (Phase 2)

## Overview

The Normalization Engine is responsible for transforming unstructured or platform-specific data (`RawItem`) into a unified, predictable schema (`NormalizedEvent`). This decoupling ensures that downstream consumers (UI, Calendar exports, automations) never need to understand the nuances of Twitter's GraphQL or Instagram's API.

Since artist announcements are highly unstructured natural language, the Normalization Engine relies on a **Local LLM** (Large Language Model) configured for structured data extraction.

## Core Pipeline Flow

1. **Batch Retrieval**: The engine queries `RawStorage` for a batch of items where `status = "new"`.
2. **Context Assembly**: The engine extracts the text payload (e.g., `full_text` from a tweet) and metadata (publish time, author).
3. **LLM Extraction**: The text is passed to a local LLM with a strict system prompt and a JSON schema.
4. **Validation**: The LLM output is validated against our expected TypeScript types using `zod`.
5. **Persistence**: 
   - On success, the unified record is written to `NormalizedStorage`, and the raw item is marked as `processed`.
   - On failure (parse error, missing required fields), the raw item is marked as `error` and skipped. *(TODO: Implement an automated retry mechanism with exponential backoff for intermittent LLM failures or prompt tweaks in future phases).*

## Data Model (Normalized Storage)

We will introduce two new Drizzle tables.

### 1. `normalized_events`
The canonical representation of an event.
- `id` (text, uuid)
- `title` (text)
- `description` (text)
- `event_time` (timestamp) — The actual time the event occurs (not the publish time)
- `venue_name` (text, optional)
- `venue_url` (text, optional)
- `type` (text) — e.g., 'live_stream', 'merchandise', 'concert'
- `is_cancelled` (boolean)
- `tags` (text, JSON array)
- `created_at` (timestamp)
- `updated_at` (timestamp)

### 2. `source_references`
The provenance links tying normalized events back to the raw data.
- `id` (text, uuid)
- `event_id` (text, fk to normalized_events)
- `raw_item_id` (text, fk to raw_items)
- `source_name` (text) — e.g., 'twitter'
- `source_id` (text) — The native platform ID (e.g., tweet ID)
- `publish_time` (timestamp)
- `url` (text)
- `author` (text)
- `raw_content` (text)
- `created_at` (timestamp)

## The LLM Interface

We will build an `LLMProvider` interface to decouple the specific model from the business logic.

```typescript
export interface LLMProvider {
  /**
   * Extract structured data from raw text.
   * @param text The raw announcement text
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

- **List View**: Displays successfully normalized events ordered by `event_time`.
- **Detail View**: Shows the full event details and a nested list of its `source_references`.
- **Manual Reprocessing**: A keybind to retry normalization for `error` items in the Monitor tab.
