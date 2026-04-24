# Scheduler Design

## Overview

The scheduler runs the ingestion pipeline periodically, orchestrating the fetch cycle by querying the [Watch List Manager](./watchlist.md) for active sources and dispatching them to the appropriate [source connectors](./twitter-connector.md). Fetched items are persisted via [raw storage](./raw-storage.md).

## Configuration

```yaml
scheduler:
  interval_minutes: 15
  max_concurrent_jobs: 1
  retry_on_failure: true
  retry_delay_minutes: 5
```

## Interface

```typescript
export interface SchedulerConfig {
  interval_minutes: number;
  max_concurrent_jobs: number;
  retry_on_failure: boolean;
  retry_delay_minutes: number;
}

export class IngestionScheduler {
  constructor(
    private config: SchedulerConfig,
    private watchlist: WatchListManager,
    private connectors: Record<string, SourceConnector>,
    private storage: RawStorageInterface
  ) {}

  /** Start the scheduler. */
  async start(): Promise<void> {
    // implementation
  }

  /** Stop the scheduler gracefully. */
  async stop(): Promise<void> {
    // implementation
  }

  /** Execute one ingestion cycle. */
  async runOnce(): Promise<void> {
    // implementation
  }
}
```

## Ingestion Cycle

Each `run_once()` call performs the following:

1. Query the watch list for all active sources, grouped by platform.
2. For each platform with active sources:
   a. Look up the corresponding connector.
   b. For each active source, call `connector.fetch_updates(source)`.
   c. For each returned raw item, save to storage via `storage.save()`.
3. Log results (items fetched per source, errors encountered).

## Scheduling Strategy

- Use APScheduler for in-process scheduling
- Interval-based scheduling (every N minutes)
- Idempotent: re-running does not create duplicates (dedup handled by storage's unique constraint on `source_name` + `source_id`)
- Graceful shutdown: complete current cycle before stopping

## Error Handling

- If a single source fails, log the error and continue to the next source
- Retry failed cycles with exponential backoff
- Log all errors with context
