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

### Stream URLs accepted as virtual venue identity

Per `design_docs/2026-04-25-virtual-venue-granularity/virtual-venue-granularity.md`, when the LLM surfaces a stream URL (e.g., `https://youtube.com/watch?v=...`) but no channel URL, the resolver accepts the stream URL as `venue_url`. Over time this creates per-stream venue rows that conceptually belong under a single channel-level venue.

Follow-up:

- Add a curated merge action in a future venue review workflow.
- Or add an LLM-assisted post-pass to extract a channel URL from a stream URL and re-point references.

### No URL canonicalization across YouTube URL forms

The resolver matches venue URLs by exact string. The same channel referenced via different URL forms — `youtu.be/x`, `youtube.com/watch?v=x`, `youtube.com/@channel`, `youtube.com/channel/UCxxxx` — creates separate venue rows.

Follow-up:

- Add a small canonicalizer for known platforms (YouTube, Twitch, NicoNico) that maps recognized URL forms to a canonical channel/profile URL before lookup and storage.

### Resolver tests for virtual-venue rules are pending a test framework

The virtual-venue-granularity design lists six focused resolver tests (null on virtual-without-URL, distinct venues for distinct channel URLs, alias addition on subsequent matches, regression guard for physical auto-discovery). These cannot land until the project has a test runner — currently `npm test` only typechecks. Tracked here so the tests aren't lost when test infrastructure is set up (see "Test coverage is still too thin" under Phase 2 Normalization).

### Existing normalized event venue FK uses NO ACTION in local migrations

`src/db/schema.ts` declares `normalized_events.venue_id` with `onDelete: "set null"`, but migration `0003_sudden_warbird.sql` added the SQLite foreign key with default `NO ACTION`. Existing migrated databases therefore do not match the schema metadata and may block venue delete/merge workflows until the table is rebuilt or a corrective migration is added.

Follow-up:

- Add a migration that recreates `normalized_events` with `venue_id ON DELETE SET NULL`.
- Verify `PRAGMA foreign_key_list(normalized_events)` after migration.

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

Decision:

- **Artist link on `normalized_events`.** Add nullable `artist_id` directly to `normalized_events` for the Phase 3 candidate query. This is the simplest primary-artist model; collaborations and guest appearances can add an `event_artists` join table later if needed.
- **`start_time` / `end_time`.** Add nullable `start_time` and `end_time`; remove `event_time` from the active schema and code.
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

### Fetch failures currently look like empty successful fetches

`TwitterConnector.fetchUpdates` catches navigation and scraping failures, logs them, and returns the collected items, often an empty array. The scheduler only treats a target as failed when `fetchUpdates` throws, so timeouts, login walls, or broken page loads can be recorded as clean zero-item fetches.

Follow-up:

- Re-throw hard navigation/scraping failures or return a structured fetch result with status and error details.
- Add explicit detection for login walls, anti-bot pages, and unexpected empty timelines.

### Source URL handling needs continued attention

`source_references.url` should always point to the source item, such as the tweet URL. Links mentioned inside the source content belong in `event_related_links`.

## TUI / Developer Workflow

### TUI directly uses DB access

The TUI currently queries storage directly in places. This is acceptable for the prototype, but will become harder to maintain as workflows grow.

Follow-up:

- Introduce read/query services for Events and Monitor views.

### Monitor retry action cannot reach errored rows

The Monitor view advertises `x` to retry errored raw items, but it loads its selectable list through `RawStorage.getUnprocessed`, which filters to `status = "new"`. Errored rows appear only in the stats count, so the retry key path is currently unreachable.

Follow-up:

- Add a raw-item query that can include `error` rows, or add a dedicated error queue view.
- Keep retry behavior explicit so processed rows are not accidentally requeued.

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

### Phase 2 normalization fallback docs were reconciled on 2026-04-26

Resolved during the Phase 3 preparation pass: `design_docs/2026-04-24-phase2-designs/normalization.md` now points to the newer strategy contract where LLM extraction failures produce a conservative fallback `announcement` event, and raw items are marked `error` only when context assembly or persistence fails.

### Phase 1 design docs were reconciled to current code on 2026-04-25

Resolved during the Tier 2 doc cleanup pass: `watchlist.md` (SourceEntry → WatchTarget rename, `updateArtist`), `raw-storage.md` (`watch_target_id`, deterministic IDs, bulk `saveItems`, `markNew`, typed `getStats`), `scheduler.md` (drop APScheduler reference, camelCase config, current method names), and `twitter-connector.md` (drop `account` block, document `headless: true` default, reference `npm run login:twitter`). Listed here so the next phase-end review knows these were done deliberately and any further drift is new.
