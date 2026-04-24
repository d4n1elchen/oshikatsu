# Raw Storage Design

## Overview

The raw storage layer persists raw items fetched from sources before they are normalized. It is source-agnostic — it stores whatever the source returns without interpretation.

## Purpose

- Store the raw response from each source exactly as-is, without interpretation.
- Track processing status so the normalization pipeline knows which items still need processing.
- Preserve full provenance for debugging and reprocessing.

## Data Model

### RawItem Table

| Field        | Type     | Description                                       |
| ------------ | -------- | ------------------------------------------------- |
| id            | string   | Internal unique identifier (auto-generated UUID)  |
| source_entry_id| string  | Reference to the watch list source entry           |
| source_name   | string   | Source identifier (e.g., "twitter")                |
| source_id     | string   | Original ID from the source (e.g., tweet ID)      |
| raw_data      | JSON     | Complete source response payload (shape varies)    |
| fetched_at    | datetime | Timestamp when fetched                             |
| status        | string   | "new", "processed", "error"                        |
| error_message | string   | Error details (null unless status is "error")      |

**Key design decisions:**

- `id` is an internal auto-generated identifier, separate from `source_id`, to avoid collisions across sources.
- `source_entry_id` links back to the watch list source entry for traceability (which artist/source produced this item).
- `source_name` + `source_id` together form a unique constraint for deduplication at ingestion time.
- `raw_data` stores the complete, unmodified source payload. The storage layer never interprets its contents.

### Indexes

- `(source_name, source_id)` — unique constraint, prevents duplicate ingestion
- `(source_name, status)` — for querying unprocessed items per source
- `fetched_at` — for time-range queries and data retention

## Interface

```typescript
export interface RawItem {
  id: string;
  source_entry_id: string;
  source_name: string;
  source_id: string;
  raw_data: Record<string, any>;
  fetched_at: Date;
  status: "new" | "processed" | "error";
  error_message: string | null;
}

export interface RawStorageInterface {
  /** Save a raw item. Throws if (source_name, source_id) already exists. */
  save(source_entry_id: string, source_name: string, source_id: string, raw_data: Record<string, any>): Promise<RawItem>;

  /** Check if an item from this source already exists. */
  exists(source_name: string, source_id: string): Promise<boolean>;

  /** Get unprocessed items for a source, ordered by fetched_at. */
  getUnprocessed(source_name: string, limit?: number): Promise<RawItem[]>;

  /** Mark an item as processed. */
  markProcessed(item_id: string): Promise<void>;

  /** Mark an item as errored with details. */
  markError(item_id: string, error_message: string): Promise<void>;

  /** Return storage statistics, optionally filtered by source. */
  getStats(source_name?: string): Promise<Record<string, any>>;
}
```

## Storage Backend

- **SQLite** for Phase 1 (local development and small-scale deployment).
- `raw_data` stored as TEXT (JSON serialized) in SQLite.
- The interface is backend-agnostic; a PostgreSQL implementation can be swapped in later without changing consumers.

## Error Handling

- Duplicate ingestion attempts (same `source_name` + `source_id`) are rejected gracefully — the caller can check with `exists()` first or handle the unique constraint violation.
- Storage-level errors (e.g., SQLite locking) are retried with exponential backoff.
- Malformed `raw_data` (not JSON-serializable) is rejected at save time with a clear error.
