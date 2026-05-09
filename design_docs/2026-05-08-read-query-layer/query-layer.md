# Read/Query Service Layer

> **Status:** Landed. Five original modules (Monitor, ReviewQueue, ExtractedEvents, NormalizedEvents, RawItems) shipped along with the four TUI view migrations. Two additional modules added during the Phase 6 web build-out: `WatchedArtistsQueries` (sidebar oshi list with last-activity timestamp) and `StreamsQueries` (live & upcoming streams rail — virtual-venue-scoped events). `TECH_DEBTS.md`'s "TUI directly uses DB access" entry has been removed.
> **Follow-ups:** New TUI/web read paths belong in this layer. Per-field DTO sharing across modules is still off — generalize on the second real overlap, not preemptively.

## Overview

A read-only service layer that owns every list/detail query the TUI and the eventual web UI need, so neither client reaches into `db` or drizzle directly. The layer is plain async functions returning view-shaped DTOs, transport-agnostic, and consumed in-process by the TUI and through HTTP handlers by the web UI.

The deliverable is the layer itself plus a migration of the four TUI views that currently bypass it (`Monitor`, `NormalizedEvents`, `ExtractedEvents`, `ReviewQueue`). One additional module (`RawItemsQueries`) is added for the web UI timeline rail; it has no TUI consumer to migrate, but living in the same place keeps the read surface in one directory.

## Problem

Four of six TUI views import `db` and drizzle operators directly and write joins inline (`Monitor`, `NormalizedEvents`, `ExtractedEvents`, `ReviewQueue`). Adding a web UI without a service layer would duplicate that pattern across two clients, double the surface area for joins to drift, and prevent fixing latent issues like the N+1 in `NormalizedEvents.tsx` (one outer query + six per-row queries × up to 50 rows = ~300 statements per refresh).

The remaining two TUI views (`WatchList`, `RawItems`) already go through core services (`WatchListManager`, `RawStorage`). Those are the precedent — read services are the same idea, separated by read/write responsibility because the read surface is much wider and won't fit the existing class-based repos cleanly.

## Goals

- One module per view-surface, located under `src/core/queries/`.
- Plain async functions returning view-shaped DTOs. No HTTP types, no framework coupling.
- Single function for `NormalizedEvents` that returns a fully enriched list in one query, killing the N+1.
- Typed options object on every list query: `{ limit, cursor?, artistId?, … }`.
- Consumed identically by the TUI (in-process) and the web UI (wrapped in HTTP handlers).
- Tests under `src/core/queries/__tests__/`, mirroring existing convention.

## Non-Goals

- **No write surface.** Existing repos (`SchedulerRunsRepo`, `ExportQueueRepo`, `RawStorage`, `WatchListManager`) keep writes. This layer is read-only.
- **No GraphQL, no query-builder DSL, no ORM-on-top-of-ORM.** Plain functions.
- **No caching layer.** SQLite reads are fast enough for the dashboard and TUI. Add caching only if a measured query becomes a bottleneck.
- **No pagination implementation in v1 modules that don't need it yet.** Cursor support is shaped into the options type so adding it later is non-breaking, but the actual implementation is deferred per query.
- **No migration of `WatchList.tsx` or `RawItems.tsx`.** Both already use service layers; touching them is out of scope.
- **No behavioral changes to the TUI views.** Migration must be drop-in; the user-visible surface is unchanged.

## Design

### File structure

```
src/core/queries/
  index.ts                       // re-exports
  MonitorQueries.ts              // getExtractionFailureSummary
  NormalizedEventsQueries.ts     // listNormalizedEvents
  ExtractedEventsQueries.ts      // listExtractedEvents
  ReviewQueueQueries.ts          // listReviewQueue
  RawItemsQueries.ts             // listRecentRawItems  (web Feed rail)
  WatchedArtistsQueries.ts       // listWatchedArtists  (web sidebar — added during Phase 6)
  StreamsQueries.ts              // listLiveAndUpcomingStreams  (web streams rail — added during Phase 6)
  __tests__/
    MonitorQueries.test.ts
    NormalizedEventsQueries.test.ts
    ExtractedEventsQueries.test.ts
    ReviewQueueQueries.test.ts
    RawItemsQueries.test.ts
    WatchedArtistsQueries.test.ts
```

### Module conventions

- **Plain async functions, not classes.** They close over the default `db` from `src/db`. Tests can pass an explicit `db` argument when needed (mirrors existing repo test pattern).
- **One file per surface, not one mega-service.** Mirrors how the views are organized; each file's scope is visible at a glance.
- **View-shaped DTOs, not raw rows.** Joins flattened, counts attached, fields named for the consumer.
- **`Date` for date fields, not ISO strings.** Cleaner for the in-process TUI; the HTTP layer's `JSON.stringify` calls `Date.prototype.toJSON` and serializes them as ISO strings naturally. One DTO shape, both clients happy.
- **Typed options object on every list query.** `{ limit, cursor?, artistId?, … }`. Cheap to add now, painful to retrofit when both clients consume them.
- **Defaults baked in.** `limit` defaults to a sensible value per query (50 for events, 100 for raw items). Callers can override.

### Tradeoff accepted

View-shaped DTOs mean two views needing similar data either share one function with broader options or get two functions. We default to duplication and only generalize on the second real overlap. Premature shared shapes turn query layers into ORMs-on-top-of-ORMs, which is exactly what we're avoiding. Today there is no overlap — each view's shape is unique.

### Per-module signatures

Concrete signatures below. Field-by-field DTO shapes are illustrative; the actual fields match what each view already destructures.

#### `MonitorQueries.ts`

```ts
export type ExtractionFailureGroup = {
  errorClass: string;
  count: number;
  oldest: Date;
  newest: Date;
};

export type ExtractionFailureSummary = {
  total: number;
  groups: ExtractionFailureGroup[];   // sorted by count desc
};

export async function getExtractionFailureSummary(): Promise<ExtractionFailureSummary>;
```

Implementation: a single `GROUP BY error_class` over `raw_items WHERE status = 'error'`. Replaces the in-TS grouping in `Monitor.tsx`.

`SchedulerRunsRepo` is not migrated; it already serves the rest of the Monitor view.

#### `NormalizedEventsQueries.ts`

```ts
export type ListNormalizedEventsOptions = {
  limit?: number;                         // default 50
  cursor?: string;                        // event id, deferred
  artistId?: string;
  orderBy?: "startTime" | "updatedAt";    // TUI: startTime; web feed: updatedAt
};

export type NormalizedEventListItem = {
  id: string;
  title: string;
  description: string;
  type: string;
  tags: string[];
  isCancelled: boolean;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
  updatedAt: Date;

  artistId: string | null;
  artistName: string | null;

  venueId: string | null;
  venueName: string | null;               // extracted name (may differ from canonical)
  venue: { id: string; name: string; kind: string } | null;

  parentEventId: string | null;
  parentTitle: string | null;
  subEventCount: number;

  sourceCount: number;
  latestDecision: string | null;
  latestReason: string | null;
};

export async function listNormalizedEvents(
  opts?: ListNormalizedEventsOptions
): Promise<NormalizedEventListItem[]>;
```

**N+1 fix.** Implementation joins:
- `normalized_events` (outer) ⟕ `artists` ⟕ `venues` (canonical) ⟕ self-join for `parentTitle`
- aggregate sub-queries for `subEventCount` (children), `sourceCount`, and the primary-source's resolution decision (`event_resolution_decisions` joined via `normalized_event_sources` filtered to `role = 'primary'`)

Single statement returning the fully enriched list. Replaces the 6-per-row N+1 currently in `NormalizedEvents.tsx`.

#### `ExtractedEventsQueries.ts`

```ts
export type ListExtractedEventsOptions = {
  limit?: number;                         // default 50
  cursor?: string;                        // deferred
  artistId?: string;
};

export type ExtractedEventListItem = {
  // … fields the existing view destructures, including:
  id: string;
  title: string;
  description: string;
  startTime: Date | null;
  endTime: Date | null;
  artistName: string | null;
  venue: { id: string; name: string; kind: string } | null;
  venueName: string | null;
  sourceName: string | null;              // from raw_items
  relatedLinks: Array<{ url: string; title: string | null }>;
  // …
};

export async function listExtractedEvents(
  opts?: ListExtractedEventsOptions
): Promise<ExtractedEventListItem[]>;
```

#### `ReviewQueueQueries.ts`

```ts
export type ListReviewQueueOptions = {
  limit?: number;                         // default 50
};

export type ReviewQueueItem = {
  // … fields the existing view destructures, including:
  extractedEventId: string;
  title: string;
  artistName: string | null;
  venueName: string | null;
  matched: {
    normalizedEventId: string;
    title: string;
    venueName: string | null;
  } | null;
  decision: string;
  reason: string | null;
  // …
};

export async function listReviewQueue(
  opts?: ListReviewQueueOptions
): Promise<ReviewQueueItem[]>;
```

#### `RawItemsQueries.ts` (new — web UI only)

```ts
export type ListRecentRawItemsOptions = {
  limit?: number;                         // default 100
  cursor?: Date;                          // fetched_at cursor for infinite scroll
  artistId?: string;
};

export type RawItemTimelineEntry = {
  id: string;
  sourceName: string;
  sourceId: string;
  authorHandle: string | null;
  authorDisplayName: string | null;
  text: string;
  fetchedAt: Date;
  postedAt: Date | null;
  artistId: string | null;
  artistName: string | null;
};

export async function listRecentRawItems(
  opts?: ListRecentRawItemsOptions
): Promise<RawItemTimelineEntry[]>;
```

Joined to `watch_targets` and `artists` to attach artist info — the timeline rail row needs to identify *which oshi* posted, not just which target.

`RawStorage` is unaffected; it owns writes and operator-flavored queue queries.

### Test approach

Each module gets a test file under `src/core/queries/__tests__/`. Tests use the same in-memory SQLite + migration setup the existing repo tests use (see `EventResolverExport.test.ts` etc.). Coverage:

- One happy-path test per query.
- Filter behavior (`artistId` scopes correctly).
- Edge cases that matter per query: empty result, `null` joins (event without venue/artist), sub-event hierarchy (child + parent in same result), pagination boundaries once cursor lands.
- `NormalizedEventsQueries` specifically: a test that asserts a single query (or constant number of queries regardless of result size) — guards against N+1 regression.

## Migration plan

The TUI migration is the validation that the layer's shape is right. Each step is independently shippable; the TUI keeps working after every step.

1. **Create `MonitorQueries.ts` + tests.** Migrate `Monitor.tsx` to consume `getExtractionFailureSummary()`. Smallest pilot — one new query, simple group-by — validates the module shape and naming before wider migration.
2. **Create `ReviewQueueQueries.ts` + tests.** Migrate `ReviewQueue.tsx`.
3. **Create `ExtractedEventsQueries.ts` + tests.** Migrate `ExtractedEvents.tsx`.
4. **Create `NormalizedEventsQueries.ts` + tests.** Migrate `NormalizedEvents.tsx` — biggest payoff (kills N+1) but most complex SQL; deliberately last so the pattern is settled.
5. **Create `RawItemsQueries.ts` + tests.** No TUI consumer. Lands ahead of the web UI timeline rail so the rail's first PR doesn't have to also introduce the query module.

After step 4, `TECH_DEBTS.md` "TUI directly uses DB access" can be removed.

## Open questions

- **Pagination shape.** Cursor field types vary by query (`updatedAt` for events feed, `fetched_at` for raw items, opaque event id for stable ordering). Decide per-query when implementing; the options type accepts whatever's right.
- **Will the web UI ever need an aggregated "dashboard bundle" endpoint** (e.g., `/api/dashboard` returning hero + streams + week + feed in one round trip)? If so, that's a `DashboardQueries.ts` composing the others — added during Phase 6, not now.
