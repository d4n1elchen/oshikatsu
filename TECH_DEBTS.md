# Technical Debts

This document tracks known technical debts, follow-up decisions, and intentionally deferred work. It should be updated whenever we choose a pragmatic shortcut so the project does not lose the context.

## Phase 2 Event Extraction

### Test coverage is still too thin

Current `npm test` only runs TypeScript typecheck.

Needed tests:

- Twitter strategy context extraction from fixture raw items
- Related link extraction and persistence
- LLM failure marks raw items as `error`
- Idempotency when a raw item already has a source reference
- Database persistence consistency between extracted event rows (with inline source provenance) and `extracted_event_related_links`

### Existing extracted data may need reprocessing

Some local extracted event rows were created before the prompt rule that preserves official names and titles. These rows may contain translated or romanized artist names, concert names, or song titles.

Follow-up:

- Add a controlled reprocess command for selected raw items/events.
- Decide whether reprocessing should replace existing extracted rows or create revised rows.

### LLM retry and repair loop is not implemented

The extractor currently relies on schema-constrained output and marks raw items as `error` when LLM extraction, validation, or sanitization fails. It does not yet implement an automated retry/repair loop for malformed LLM output.

Follow-up:

- Add limited retries with a stricter repair prompt.
- Track retry count and last extraction error.
- Avoid infinite retry loops for persistent prompt/model failures.

### Extraction strategy is intentionally minimal

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

Only newly extracted items populate `extracted_event_related_links`. Existing extracted event rows may not have related links even if their source items contain URLs.

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

The venue design now uses nullable `venue_id` directly on the Phase 2 `extracted_events` table.

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

The virtual-venue-granularity design lists six focused resolver tests (null on virtual-without-URL, distinct venues for distinct channel URLs, alias addition on subsequent matches, regression guard for physical auto-discovery). These cannot land until the project has a test runner — currently `npm test` only typechecks. Tracked here so the tests aren't lost when test infrastructure is set up (see "Test coverage is still too thin" under Phase 2 Event Extraction).

## Phase 3 Merge / Deduplication

### Event identity rules are designed but not implemented

The Phase 3 merge/dedup design exists in `design_docs/2026-04-25-phase3-deduplication/deduplication.md`, but implementation has not started.

### Canonical normalized event storage is not implemented

The refined event-layer model is now reflected in Phase 2 code:

- `raw_items`: fetched source payloads.
- `extracted_events`: one source-derived event candidate per raw item.
- `normalized_events`: canonical events after deduplication and merging.

Phase 3 still needs to add true canonical `normalized_events` storage and a `normalized_event_sources` link table. Until then, downstream views should treat `extracted_events` as source-derived candidates rather than canonical events.

### Merge auditability is undecided

We need to decide how to record why events were merged.

Possible approaches:

- Store merge decision logs.
- Store confidence and matched fields.
- Keep links between extracted event IDs and canonical normalized event IDs.

### Schema gaps to resolve before Phase 3 starts

`ARCHITECTURE.md` describes a normalized canonical event schema richer than what the current Phase 2 extracted event table stores. These gaps are noted explicitly in the Data Model callout, and Phase 3 will need to make decisions on them before it can express the candidate-selection queries cleanly.

Decision:

- **Artist link on extracted events.** Add nullable `artist_id` directly to the Phase 2 extracted event table for the Phase 3 candidate query. This is the simplest primary-artist model; collaborations and guest appearances can add an `event_artists` join table later if needed.
- **`start_time` / `end_time`.** Add nullable `start_time` and `end_time` to extracted events and later carry selected canonical values into normalized events; remove `event_time` from the active schema and code.
- **Event hierarchy.** Extracted events now carry source-derived `event_scope` and `parent_event_hint`, but canonical parent/sub-event links remain Phase 3.1 work. Phase 3 must treat the hint as evidence, not as an authoritative relationship.

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

`extracted_events.source_url` should always point to the source item, such as the tweet URL. Links mentioned inside the source content belong in `extracted_event_related_links`.

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

`extract:once` is useful for development and repair, but it is not yet a polished admin command.

Follow-up:

- Add options for source filter, raw item ID, retry errors, dry run, and reprocess existing extracted rows.

## Documentation Hygiene

### Design docs may drift from implementation

Several docs are now evolving quickly during Phase 2/3 planning.

Follow-up:

- At the end of each phase, review `ARCHITECTURE.md`, phase design docs, and this file together.
- Move resolved debts into a changelog or remove them once addressed.

### Phase 2 extraction failure policy was updated on 2026-04-26

Resolved during the Phase 3 preparation pass, then revised after deciding low-confidence fallback events should not be created: `design_docs/2026-04-24-phase2-designs/extraction.md` and `design_docs/2026-04-25-extraction-strategy/extraction-strategy.md` now state that LLM extraction, validation, and sanitization failures mark the raw item as `error`.

### `source_references` table folded into `extracted_events` on 2026-04-26

Resolved during the Phase 3 prep work. Because the unique index on `extracted_events.raw_item_id` already enforces a 1:1 relationship between extracted events and raw items, the dedicated `source_references` table was always-joined and added no information. Its provenance columns (`publish_time`, `author`, `source_url`, `raw_content`) now live inline on `extracted_events`. `source_name` and `source_id` were not duplicated since they remain on `raw_items` reachable via the `raw_item_id` join. `venue_name` and `venue_url` were already on the extracted event and stay there. The conceptual `source_references` array on the normalized event schema in ARCHITECTURE.md remains valid because Phase 3 dedup will aggregate multiple extracted events under a single normalized event, each contributing its provenance.

### Phase 1 design docs were reconciled to current code on 2026-04-25

Resolved during the Tier 2 doc cleanup pass: `watchlist.md` (SourceEntry → WatchTarget rename, `updateArtist`), `raw-storage.md` (`watch_target_id`, deterministic IDs, bulk `saveItems`, `markNew`, typed `getStats`), `scheduler.md` (drop APScheduler reference, camelCase config, current method names), and `twitter-connector.md` (drop `account` block, document `headless: true` default, reference `npm run login:twitter`). Listed here so the next phase-end review knows these were done deliberately and any further drift is new.
