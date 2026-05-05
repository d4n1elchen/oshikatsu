# Phase 5: Downstream Export Protocol

> **Status:** Landed. New tests in `ExportRunner.test.ts` (7) and `EventResolverExport.test.ts` (4); all 122 unit tests pass.
> **Follow-ups:** Specific consumer implementations (iCal, webhook, notification dispatch, etc.) are out of scope for this phase and tracked in `TECH_DEBTS.md`.

## Overview

Phase 5 introduces a generic export protocol that lets the daemon push canonical events to downstream consumers without baking in any specific consumer (calendar, webhook, notification, message bus, etc.). The deliverable is the protocol — a `Consumer` interface, a delivery loop, a state table that tracks which consumers have seen which events, and Monitor visibility — plus a single in-tree no-op consumer used by tests. Adding a real consumer (e.g. iCal file emitter, Discord webhook) becomes a self-contained follow-up: implement the interface, register it, done.

This phase is intentionally narrow. We are not building integrations; we are building the substrate that makes integrations cheap.

## Problem

Canonical normalized events exist in `normalized_events`, but the system has no built-in way to deliver them anywhere. Any downstream user (an operator's calendar, a notification bot, an analytics pipeline, a future web UI's push channel) currently has to read the SQLite file directly, reimplement "what's new since I last looked," and handle their own retries.

Several concerns recur across every plausible consumer and would otherwise be reinvented per-consumer:

- **Change tracking** — "give me events I haven't seen yet" must be answered without scanning the whole table on every tick.
- **Idempotency** — a consumer must be safe to retry; a webhook timeout that actually delivered shouldn't double-send. This needs both an event-level cursor *and* a stable per-event identity the consumer can use as its own dedup key.
- **Failure handling** — a flaky consumer should not block other consumers, and its failures should surface in the existing Monitor view.
- **Hierarchy semantics** — sub-events (Phase 3.1) need a defined contract: emit them as independent records? Bundled with their parent? Either, depending on consumer? The protocol decides this once.
- **Update semantics** — a canonical event can change after first emission (rescheduled, cancelled, merged into via a later extracted event). The protocol needs an unambiguous answer for "what does the consumer see when an event changes?"

Picking a single concrete consumer first and abstracting later would bake those concerns into whichever consumer was first. Designing the protocol up-front, with the consumer count starting at one (a no-op stub), keeps the seams in the right place.

## Goals

- Define a `Consumer` interface that any downstream sink can implement in isolation.
- Persist per-consumer delivery state so the daemon survives restarts and consumer additions without re-emitting history.
- Run delivery as a `ScheduledTask`, getting Monitor visibility for free (Phase 4 substrate).
- Define the contract for sub-events, updates, and cancellations once, in the protocol layer, so consumers don't each invent it.
- Support pluggable registration: dropping a new `Consumer` and wiring it in `daemon.ts` is the only code change required to add a sink.

## Non-Goals

- No specific consumer implementation (iCal, Google Calendar, Discord, Slack, webhook, email, push) — each is its own follow-up once the protocol lands.
- No web/HTTP server or pull API. Phase 5 is push-only; the eventual web UI (Phase 8) will add pull endpoints.
- No fan-out across machines / queueing infrastructure. Single-process, single-daemon delivery.
- No automatic retry-with-backoff scheduling beyond "the next tick will try again." Sophisticated DLQ / circuit-breaker behavior is deferred.
- No alerting on consumer failure — Phase 7 will build this on the same `scheduler_runs` substrate.
- No exactly-once guarantee. We provide at-least-once with stable identity and let consumers dedup.

## Design

### Architectural picture

```
normalized_events ──► ExportRunner (ScheduledTask)
                          │
                          ├── for each registered Consumer:
                          │    1. read consumer_cursor
                          │    2. fetch ExportRecord batch since cursor
                          │    3. consumer.deliver(batch)
                          │    4. on success: advance cursor + record per-event delivery
                          │    5. on failure: leave cursor; surface via scheduler_runs.details
                          │
                          └── one tick = N consumers attempted independently
```

The runner is a single `ScheduledTask` registered on the existing `Scheduler`. Each tick iterates registered consumers; one consumer's failure does not abort the others. The tick's `details` payload is `{ consumers: { <name>: { delivered, failed, skipped } } }` — already compatible with the Monitor view.

### The `Consumer` interface

```ts
export interface Consumer {
  /** Stable identifier; persisted in consumer_cursors. Renaming is a migration. */
  readonly name: string;

  /** Optional one-time setup (open file handle, validate config, etc.). */
  start?(): Promise<void>;

  /** Optional teardown on daemon shutdown. */
  stop?(): Promise<void>;

  /**
   * Deliver a batch of records. Should be idempotent — the runner may retry
   * the same batch on the next tick if a previous tick failed mid-flight.
   *
   * Throwing surfaces as a per-consumer failure for this tick. The cursor is
   * not advanced; the same records are retried next tick.
   *
   * Resolving with per-record outcomes (rather than throwing) lets a consumer
   * partially succeed: delivered records advance the cursor, failed records
   * stay pending.
   */
  deliver(batch: ExportRecord[], signal: AbortSignal): Promise<DeliveryResult>;
}

export type DeliveryResult = {
  /** IDs of records the consumer durably accepted; cursor advances past these. */
  delivered: string[];
  /** IDs the consumer rejected permanently (will not be retried). */
  rejected: { id: string; reason: string }[];
  /** IDs the consumer wants retried next tick. (Anything not in delivered/rejected is implicitly retried.) */
  retry?: string[];
};
```

Throwing from `deliver` is treated as "everything in the batch is implicitly retried"; it's the connectivity-failure shortcut. `rejected` is the schema-failure / validation escape hatch — the operator can inspect it later but the runner won't loop forever on a record the consumer cannot accept.

### `ExportRecord` shape

A flattened, consumer-friendly projection of a canonical event. Consumers do not see the raw schema; they get a stable shape that survives internal refactors.

```ts
export type ExportRecord = {
  id: string;                  // normalized_events.id
  version: number;             // monotonic per id; bumps on update
  changeType: "created" | "updated" | "cancelled";
  parentId: string | null;     // normalized_events.parent_event_id
  artist: { id: string; name: string } | null;
  title: string;
  description: string;
  startTime: string | null;    // ISO-8601 with timezone
  endTime: string | null;
  venue: {
    id: string | null;
    name: string | null;
    url: string | null;
  };
  type: string;
  isCancelled: boolean;
  tags: string[];
  // Source provenance, denormalized for consumers that want to attribute / link back.
  sources: {
    sourceUrl: string;
    publishTime: string;
    author: string;
  }[];
  emittedAt: string;           // when the runner produced this record
};
```

`version` is incremented in the export layer, not on `normalized_events` — this isolates the export-facing version from internal `updated_at` churn (which can change for non-consumer-visible reasons). See "Change detection" below.

### Change tracking & cursors

A new table tracks per-consumer delivery state:

#### `export_cursors`

| Field             | Type            | Description |
| ----------------- | --------------- | ----------- |
| `consumer_name`   | text PK         | Matches `Consumer.name`. |
| `cursor_position` | integer         | Monotonic position in the export queue (see below). |
| `updated_at`      | timestamp       | Last advance. |

A new consumer registered for the first time starts at the current head, **not** at zero. We do not replay history to brand-new consumers by default; an explicit `reset:export-cursor` script lets the operator opt in.

#### `export_queue`

| Field             | Type            | Description |
| ----------------- | --------------- | ----------- |
| `position`        | integer PK auto | Monotonic position. The cursor compares against this. |
| `normalized_event_id` | text        | FK to `normalized_events.id`. |
| `change_type`     | text            | `created` \| `updated` \| `cancelled`. |
| `version`         | integer         | Per-event version; bumps on each enqueue for the same id. |
| `enqueued_at`     | timestamp       |             |

Indexed on `(normalized_event_id, position)` so we can find the latest entry per event for compaction.

A row is appended whenever:

- A new `normalized_events` row is inserted by `EventResolver.applyDecision` (`change_type='created'`).
- An existing row is updated through resolution (merge that flips `is_cancelled`, hierarchy linking, future `updated_at` bumps from re-resolution): `change_type='updated'`, or `'cancelled'` if the update set `is_cancelled=true`.

The `EventResolver` already runs every transition in a transaction; the queue insert joins those transactions. Centralizing enqueueing in the resolver (the only writer of `normalized_events`) keeps "what counts as a consumer-visible change" in one place.

#### Why a queue, not "scan since updated_at"

A `WHERE updated_at > cursor_time` scan looks simpler, but:

- Time-based cursors corrupt under clock skew or daemon backdating.
- An update that doesn't bump `updated_at` (or one that bumps it for a non-consumer-visible reason) is invisible / spurious.
- Compaction ("the consumer hasn't seen this id yet, and there are 5 updates queued — collapse to one") needs an explicit log to compact against.

The queue is append-only and small (at most one row per event per change), so cost is bounded.

### Compaction

On each tick, before delivering, the runner compacts the per-consumer slice: if the queue has multiple unseen entries for the same `normalized_event_id`, only the latest is delivered, with `version` set to that latest entry's version. Earlier entries are skipped (not deleted; another consumer may still be lagging behind them). This means:

- A consumer that hasn't run in a week sees one record per event, not the full edit history.
- Cancelled-then-rescheduled-then-cancelled-again collapses to the final state.
- Rapid resolver churn doesn't multiply downstream noise.

A separate maintenance script (or a lazy "delete entries older than the slowest cursor" pass at end-of-tick) prunes the queue.

### Sub-event semantics

Sub-events (Phase 3.1) are independent rows in `normalized_events` with `parent_event_id` set. The protocol delivers them as **independent records** with `parentId` populated. Consumers decide whether to render them as separate calendar items, attach as a description bullet on the parent, or ignore.

The alternative — bundling parent + children into a single record — was rejected because:

- It would force ordering: the parent must be delivered before any child, even if the child landed first.
- It would require synthesizing a "bundle changed" event when a child is added long after the parent was emitted.
- Consumers that *do* want bundling can build it client-side via `parentId`; consumers that don't would have to unbundle.

A consumer that wants the bundled view at delivery time can override via a future `Consumer.transform()` hook. Out of scope for this phase.

### Update semantics

Every consumer-visible mutation (re-resolution, merge with cancellation flip, hierarchy linkage) appends a queue row. The consumer sees the *current* projection of the event, with `version` bumped and `changeType="updated"` (or `"cancelled"`). It is the consumer's job to decide whether to PATCH, replace, or upsert; the protocol guarantees only that it will see the change at least once with a stable id and an increasing version.

Cancellation is modeled as a `changeType="cancelled"` record rather than a delete. Calendars typically need to mark events cancelled, not vanish them. A consumer that wants delete-on-cancel can implement that mapping locally.

### Registration & wiring

`daemon.ts` constructs the runner with a list of consumers:

```ts
const exportRunner = new ExportRunner([
  // Real consumers added in follow-up phases:
  // new ICalFileConsumer({ outputPath: ... }),
  // new DiscordWebhookConsumer({ url: ... }),
]);

scheduler.add({
  name: "Export",
  intervalMinutes: config.scheduler.exportIntervalMinutes,
  run: (signal) => exportRunner.tick(signal),
});
```

Config is per-consumer and lives in `config.yaml` under `export.<consumer-name>.*`. The runner does not load config; consumers do, in their constructors. This keeps the runner agnostic to consumer count and shape.

### Monitor integration

The `Export` task records to `scheduler_runs` like any other task. The details payload is structured:

```json
{
  "consumers": {
    "ical_file": { "delivered": 12, "rejected": 0, "retried": 0 },
    "discord_webhook": { "delivered": 0, "rejected": 0, "retried": 12, "errorClass": "FetchError" }
  }
}
```

The Monitor view's existing per-task render reads `details` generically. A future enhancement (tracked separately) can add a per-consumer drilldown; for Phase 5, the JSON visible in the run row is enough to diagnose.

## Data Model Changes

Two new tables, no changes to existing tables:

- `export_queue` (described above).
- `export_cursors` (described above).

`EventResolver.applyDecision` gains queue inserts inside its existing transactions. The `normalizedEvents` schema is unchanged; we deliberately do not add an `export_version` column there because the version is queue-derived and consumer-facing, not an internal property of the canonical record.

## Testing Strategy

- `ExportRunner.test.ts` — given a fake consumer that records calls, verify cursor advancement, partial-success handling, exception → retry, compaction across multiple updates.
- `ExportQueue.test.ts` — given direct resolver calls, verify queue rows appear with correct `change_type` for created/updated/cancelled.
- An in-tree `NoopConsumer` that always returns `{ delivered: batch.map(r => r.id) }` exists for tests and as a reference implementation. It is *not* registered in `daemon.ts` by default.

## Migration & rollout

1. Add `export_queue` and `export_cursors` tables.
2. Add resolver-side queue inserts behind feature flag (`export.enabled` in config, default `false`).
3. Wire `ExportRunner` into the daemon (no-op when no consumers registered).
4. Land protocol; close phase.
5. Each real consumer becomes its own follow-up commit/PR — adding one is a single-file `Consumer` impl plus a one-line registration in `daemon.ts`.

When `export.enabled=false` (default), no queue rows are written and the runner is not registered. This means an operator who never wants exports pays nothing.

## Decisions

- `version` is a plain monotonically-increasing **integer** per `normalized_event_id`. Debuggable, sortable, easy for consumers to compare against their own stored copy.

## Deferred (follow-ups)

- Per-consumer filtering at registration time (event type, artist, tag). Start with filtering inside `deliver`; promote to a registration-time predicate if multiple consumers reinvent it.
- `export_rejections` table for operator review of permanently-rejected records. For Phase 5 these only show up in `scheduler_runs.details`.
- Cross-tick rate limiting. Per-tick batch size cap + self-throttling inside `deliver` is enough today.
- `Consumer.transform()` hook (e.g., bundle parent + sub-events for consumers that want a single calendar entry).

## Forward-Compatibility With a Future Plugin System

We're not building a plugin loader now, but a few cheap choices keep that door open so a third-party consumer can later be installed without touching core:

- **`Consumer` is the only seam.** The runner depends only on the interface; it does not import any specific consumer. A plugin loader's job becomes "construct a `Consumer` and hand it to the runner" — no other contract to honor.
- **No shared mutable state between runner and consumer.** Everything passes through `deliver`'s arguments and return value. No global registries, no singletons reaching into consumer internals. A sandboxed plugin (eventually a separate process or worker) can implement the same interface over IPC without changing the protocol.
- **Stable `Consumer.name` is the only identity.** The cursor table keys on it; the runner's debug output keys on it. A plugin declaring `name: "acme-discord"` can be installed, removed, and reinstalled across daemon restarts without losing or corrupting delivery state.
- **`ExportRecord` is a plain serializable shape**, not a class with methods, not a reference into the live ORM. It crosses any boundary (process, network, language) cleanly. A future plugin in another language gets the same JSON shape a JS plugin sees.
- **Config is per-consumer, namespaced by name** (`config.yaml: export.<consumer-name>.*`). A plugin manifest can declare its config schema under its own namespace without colliding with core or other plugins.
- **Failures are local.** One consumer's exception cannot poison the runner or other consumers; the runner already isolates them. A misbehaving plugin degrades only itself.
- **Versioned record shape.** When `ExportRecord` evolves, we'll add fields (additive) and bump a protocol version constant the runner advertises; consumers that need it can negotiate. Out of scope to wire today, but the discipline of "additive changes only" starts now.

What we are explicitly *not* doing yet: a manifest format, a plugin discovery mechanism, sandboxing, or signature verification. Those belong to whatever phase actually introduces third-party plugins.
