# Raw Storage Design

## Overview

The raw storage layer persists raw items fetched from sources before event extraction. It is source-agnostic — it stores whatever the source returns without interpretation.

## Purpose

- Store the raw response from each source exactly as-is, without interpretation.
- Track processing status so the extraction pipeline knows which items still need processing.
- Preserve full provenance for debugging and reprocessing.

## Data Model

### `raw_items` Table

| Field           | Type     | Description                                                          |
| --------------- | -------- | -------------------------------------------------------------------- |
| id              | string   | Internal unique identifier; deterministic `${source_name}_${source_id}` |
| watch_target_id | string   | Reference to the watch list `watch_targets` row that produced this item |
| source_name     | string   | Source identifier (e.g., "twitter")                                  |
| source_id       | string   | Original ID from the source (e.g., tweet ID)                         |
| raw_data        | JSON     | Complete source response payload (shape varies)                      |
| fetched_at      | datetime | Timestamp when fetched                                               |
| status          | string   | "new", "processed", "error"                                          |
| error_message   | string   | Error details (null unless status is "error")                        |

**Key design decisions:**

- `id` is internal but built deterministically as `${source_name}_${source_id}`. This gives ingestion idempotency for free under `INSERT ... ON CONFLICT DO NOTHING` even if the unique index were missing, and makes raw items addressable from logs without an extra lookup. (Earlier drafts proposed a random UUID; the deterministic form was adopted in the implementation.)
- `watch_target_id` links back to the watch list watch target for traceability (which artist/target produced this item). Earlier drafts called this `source_entry_id`; it was renamed alongside the watch target rename.
- `source_name` + `source_id` together form a unique constraint (`idx_source_dedup`) for deduplication at ingestion time.
- `raw_data` stores the complete, unmodified source payload. The storage layer never interprets its contents.

### Indexes

- `idx_source_dedup` on `(source_name, source_id)` — unique constraint, prevents duplicate ingestion.
- Status filtering uses `WHERE status = 'new'` scans; a `(source_name, status)` index can be added if scans become hot.
- `fetched_at` ordering is used by `getUnprocessed`; a dedicated index can be added if needed.

## Interface

Drizzle generates camelCase TypeScript field names from the snake_case columns above (e.g., `watch_target_id` → `watchTargetId`). Code uses the camelCase names.

```typescript
export interface RawItem {
  id: string;
  watchTargetId: string;
  sourceName: string;
  sourceId: string;
  rawData: Record<string, any>;
  fetchedAt: Date;
  status: "new" | "processed" | "error";
  errorMessage: string | null;
}

export class RawStorage {
  /**
   * Save a batch of raw items for a single watch target / source.
   * Uses INSERT ... ON CONFLICT DO NOTHING against the (source_name, source_id)
   * unique index, so already-known items are silently skipped.
   * Returns the number of newly inserted items.
   */
  async saveItems(
    watchTargetId: string,
    sourceName: string,
    items: Array<{ sourceId: string; rawData: Record<string, any> }>
  ): Promise<number>;

  /** Check if an item from this source already exists. */
  async exists(sourceName: string, sourceId: string): Promise<boolean>;

  /**
   * Get unprocessed items, optionally filtered by source name,
   * ordered by fetchedAt descending.
   */
  async getUnprocessed(sourceName?: string, limit?: number): Promise<RawItem[]>;

  /** Mark an item as processed. */
  async markProcessed(itemId: string): Promise<void>;

  /** Mark an item as errored with details. */
  async markError(itemId: string, errorMessage: string): Promise<void>;

  /** Re-queue an item for processing (used by the extract:once retry script). */
  async markNew(itemId: string): Promise<void>;

  /** Return storage statistics, optionally filtered by source. */
  async getStats(sourceName?: string): Promise<{ total: number; new: number; processed: number; error: number }>;
}
```

Notes on what changed from earlier drafts:

- `save()` (single-item, throws on conflict) was replaced by `saveItems()` (bulk, silently skips conflicts) because the Twitter connector returns batches and we want ingestion to be idempotent rather than throw.
- `markNew()` was added so the `extract:once --retry-errors` script can re-queue errored items without manual SQL.
- `getStats` returns a typed status breakdown rather than an open `Record<string, any>`.

## Storage Backend

- **SQLite** for Phase 1 (local development and small-scale deployment).
- `raw_data` stored as TEXT (JSON serialized) in SQLite.
- The interface is backend-agnostic; a PostgreSQL implementation can be swapped in later without changing consumers.

## Error Handling

- Duplicate ingestion attempts (same `source_name` + `source_id`) are silently skipped via `ON CONFLICT DO NOTHING` against `idx_source_dedup`. `saveItems` returns only the count of newly inserted rows, so callers can detect "no new items" without inspecting per-row errors.
- Storage-level errors during a `saveItems` call are caught and logged; the call returns 0 rather than throwing. (Retry/backoff for transient SQLite locking is not yet implemented.)
- Malformed `raw_data` (not JSON-serializable) will fail at the Drizzle JSON serialization step with a clear error.
