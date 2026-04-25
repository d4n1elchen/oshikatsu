# Scheduler Design

## Overview

The scheduler runs the ingestion pipeline periodically, orchestrating the fetch cycle by querying the [Watch List Manager](./watchlist.md) for active sources and dispatching them to the appropriate [source connectors](./twitter-connector.md). Fetched items are persisted via [raw storage](./raw-storage.md).

## Configuration

The scheduler reads its interval from the global `config.yaml` under `scheduler.ingestionIntervalMinutes`. Conceptual fields below describe behavior; not all are wired into the current `SchedulerConfig` (see Interface).

```yaml
scheduler:
  ingestionIntervalMinutes: 15
  # Conceptual fields, not all currently honored:
  maxConcurrentJobs: 1
  retryOnFailure: true
  retryDelayMinutes: 5
```

## Interface

```typescript
export interface SchedulerConfig {
  intervalMinutes: number;
  maxConcurrentJobs: number;
  retryOnFailure: boolean;
  retryDelayMinutes: number;
}

export class IngestionScheduler {
  constructor(private config: SchedulerConfig) {
    // The scheduler currently constructs its own WatchListManager,
    // RawStorage, and TwitterConnector internally. Moving to dependency
    // injection (so connectors are passed in) is a near-term refactor.
  }

  /** Start the scheduler loop. */
  async start(): Promise<void> {}

  /** Stop the scheduler gracefully. */
  async stop(): Promise<void> {}

  /** Execute one ingestion cycle across all active watch targets. */
  async runOnce(): Promise<void> {}
}
```

## Ingestion Cycle

Each `runOnce()` call performs the following:

1. Query the Watch List for all active watch targets, grouped by platform (today only `twitter`).
2. For each platform with active watch targets:
   a. Look up or instantiate the corresponding connector.
   b. For each active watch target, call `connector.fetchUpdates(target)`.
   c. Bulk-persist returned raw items via `storage.saveItems(targetId, sourceName, items)`.
3. Log results (items fetched per target, errors encountered).

## Scheduling Strategy

- Use Node's native `setInterval` for in-process scheduling. (`node-cron` is acceptable if cron-style expressions are needed later. Earlier drafts of this doc referenced APScheduler from the Python ecosystem; the project standardized on Node/TypeScript before Phase 1 began.)
- Interval-based scheduling (every N minutes), kicked off by an immediate first run on `start()`.
- Idempotent: re-running does not create duplicates (dedup handled by Raw Storage's unique index on `source_name` + `source_id`, plus `INSERT ... ON CONFLICT DO NOTHING`).
- Graceful shutdown: stop the timer and let the current in-flight cycle complete before exiting.

## Error Handling

- If a single source fails, log the error and continue to the next source
- Retry failed cycles with exponential backoff
- Log all errors with context
