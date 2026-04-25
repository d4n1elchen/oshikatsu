# Technical Debts

This document tracks known technical debts, follow-up decisions, and intentionally deferred work. It should be updated whenever we choose a pragmatic shortcut so the project does not lose the context.

## Phase 2 Normalization

### Test coverage is still too thin

Current `npm test` only runs TypeScript typecheck.

Needed tests:

- Twitter strategy context extraction from fixture raw items
- Related link extraction and persistence
- LLM failure fallback
- Idempotency when a raw item already has a source reference
- Database persistence consistency between `normalized_events`, `source_references`, and `event_related_links`

### Existing normalized data may need reprocessing

Some local normalized rows were created before the prompt rule that preserves official names and titles. These rows may contain translated or romanized artist names, concert names, or song titles.

Follow-up:

- Add a controlled reprocess command for selected raw items/events.
- Decide whether reprocessing should replace existing normalized rows or create revised rows.

### LLM retry and repair loop is not implemented

The normalizer currently relies on schema-constrained output and fallback behavior. It does not yet implement an automated retry/repair loop for malformed LLM output.

Follow-up:

- Add limited retries with a stricter repair prompt.
- Track retry count and last normalization error.
- Avoid infinite retry loops for persistent prompt/model failures.

### Normalization strategy is intentionally minimal

The strategy layer exists, but source-specific behavior is conservative. It does not yet include richer source-specific rules, fixture-driven prompts, or configurable extraction policies.

Follow-up:

- Revisit strategy design after Phase 3 dedup reveals which fields matter most.
- Keep artist-, song-, concert-, and venue-specific rules out of the core engine.

## Related Links

### Related link extraction stores only URL and title

This is intentional for now. We removed link kind/classification to keep the model small.

Possible future additions, only if needed:

- Link ordering
- Preview metadata
- Source raw item reference display
- Link role/category

### Related links are not backfilled

Only newly normalized items populate `event_related_links`. Existing normalized events may not have related links even if their source items contain URLs.

Follow-up:

- Use the future reprocess command to backfill links from raw items.

## Phase 2.1 Venue Database

### Venue curation workflow is not implemented

The Phase 2.1 venue schema, exact resolver, and auto-discovery flow are implemented. New usable extracted venue names now create `discovered` venues automatically, but there is no workflow yet to review, verify, merge, or ignore discovered venues.

Follow-up:

- Add a venue review or admin workflow for `discovered`, `verified`, and `ignored`.
- Add a merge workflow for duplicate discovered venues.
- Treat discovered venues as weaker Phase 3 dedup signals than verified venues.

### Event-venue link table is deferred

The venue design now uses nullable `venue_id` directly on `normalized_events` for the Phase 2.1 implementation.

An `event_venue_links` table is deferred until we need multiple venues per event, venue match confidence/history, or detailed auditability of venue resolution.

### Venue generic/ignored rules need a decision

Open questions:

- Should venue URL matching include related links or only `venue_url`?
- Which generic venue names should become `ignored`?

## Phase 3 Merge / Deduplication

### Event identity rules are designed but not implemented

The Phase 3 merge/dedup design exists in `design_docs/2026-04-25-phase3-deduplication/deduplication.md`, but implementation has not started.

### Merge auditability is undecided

We need to decide how to record why events were merged.

Possible approaches:

- Store merge decision logs.
- Store confidence and matched fields.
- Keep superseded event IDs linked to canonical events.

### Schema gaps to resolve before Phase 3 starts

`ARCHITECTURE.md` describes a unified event schema richer than what `normalized_events` currently stores. These gaps are noted explicitly in the Data Model callout, and Phase 3 will need to make decisions on them before it can express the candidate-selection queries cleanly.

Follow-up:

- **Artist link on `normalized_events`.** Today the only path from an event to an artist is `source_references → raw_items → watch_targets → artists`. Phase 3's "same artist + close time" candidate query is awkward without a direct FK. Decide between adding `artist_id` to `normalized_events`, an `event_artists` join table (for collaborations), or keeping the chained join.
- **`start_time` / `end_time`.** `ARCHITECTURE.md` lists both; the schema only has `event_time`. Decide whether to add them, treat `event_time` as `start_time`, or leave as future scope.
- **Event hierarchy.** Tracked as Phase 3.1 in `design_docs/2026-04-23-implementation-plan/plan.md`; no schema work is needed before Phase 3, but the Phase 3 dedup design should not foreclose the parent/sub-event model.

## Scheduler

### Scheduler builds its own dependencies

`IngestionScheduler` constructs `WatchListManager`, `RawStorage`, and `TwitterConnector` internally rather than receiving them via constructor. This makes the class hard to test in isolation and ties the scheduler to a single connector type. The scheduler design doc has been updated to call this out.

Follow-up:

- Refactor to accept `watchlist`, `storage`, and a `connectors: Record<string, BaseConnector>` map via the constructor.
- Update `daemon.ts` to wire dependencies explicitly.

### Several `SchedulerConfig` fields are not honored

`SchedulerConfig` defines `maxConcurrentJobs`, `retryOnFailure`, and `retryDelayMinutes`, but the implementation only uses `intervalMinutes`. Targets are always processed sequentially with no retry on failure beyond per-target try/catch.

Follow-up:

- Either implement the missing behavior or remove the unused fields from the type.

## Raw Storage

### No retry/backoff for transient SQLite errors

`saveItems` catches errors, logs them, and returns 0. There is no exponential backoff for transient SQLite locking, which the original design called for.

Follow-up:

- Add a retry wrapper for `SQLITE_BUSY` / `SQLITE_LOCKED` with bounded exponential backoff.
- Decide whether `saveItems` should surface partial-batch failures distinctly from "no new items."

### Optional indexes deferred until needed

The original design proposed `(source_name, status)` and `fetched_at` indexes. Only the unique `(source_name, source_id)` index is in place. `getUnprocessed` currently scans by `status = 'new'` ordered by `fetched_at`.

Follow-up:

- Add the deferred indexes if `getUnprocessed` becomes a hot path or batch sizes grow.

## Twitter/X Connector

### Connector depends on X internal GraphQL shape

The Twitter connector intercepts X GraphQL responses. This is more stable than DOM scraping but still fragile if X changes response names or payload structure.

Follow-up:

- Add connector health checks.
- Add sample payload fixtures.
- Detect login wall / anti-bot / empty timeline states explicitly.

### Source URL handling needs continued attention

`source_references.url` should always point to the source item, such as the tweet URL. Links mentioned inside the source content belong in `event_related_links`.

## TUI / Developer Workflow

### TUI directly uses DB access

The TUI currently queries storage directly in places. This is acceptable for the prototype, but will become harder to maintain as workflows grow.

Follow-up:

- Introduce read/query services for Events and Monitor views.

### One-shot scripts are useful but informal

`normalize:once` is useful for development and repair, but it is not yet a polished admin command.

Follow-up:

- Add options for source filter, raw item ID, retry errors, dry run, and reprocess existing normalized rows.

## Documentation Hygiene

### Design docs may drift from implementation

Several docs are now evolving quickly during Phase 2/3 planning.

Follow-up:

- At the end of each phase, review `ARCHITECTURE.md`, phase design docs, and this file together.
- Move resolved debts into a changelog or remove them once addressed.

### Phase 2 normalization doc still describes the older error-only fallback

`design_docs/2026-04-24-phase2-designs/normalization.md` says LLM extraction failures mark the raw item as `error` and skip it. The newer `2026-04-25-normalization-strategy/normalization-strategy.md` and the implementation in `NormalizationEngine` instead fall back to a minimal `announcement` event and only mark `error` when `buildContext` returns null or persistence throws. The two docs now disagree on the contract.

Follow-up:

- Reconcile the Phase 2 doc with the strategy doc, or add a pointer at the top of the Phase 2 doc that the fallback policy was superseded by the strategy design.

### Phase 1 design docs were reconciled to current code on 2026-04-25

Resolved during the Tier 2 doc cleanup pass: `watchlist.md` (SourceEntry → WatchTarget rename, `updateArtist`), `raw-storage.md` (`watch_target_id`, deterministic IDs, bulk `saveItems`, `markNew`, typed `getStats`), `scheduler.md` (drop APScheduler reference, camelCase config, current method names), and `twitter-connector.md` (drop `account` block, document `headless: true` default, reference `npm run login:twitter`). Listed here so the next phase-end review knows these were done deliberately and any further drift is new.
