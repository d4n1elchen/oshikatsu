# Technical Debts

This document tracks known technical debts, follow-up decisions, and intentionally deferred work. It should be updated whenever we choose a pragmatic shortcut so the project does not lose the context.

## Phase 2 Event Extraction

### Test coverage gaps

The full test suite covers 149 cases across `EventResolver`, `titleSimilarity`, `canonicalizeUrl`, `VenueResolver`, `TwitterConnector`, `ExtractionStrategy`, `ExtractionEngine`, `Scheduler`, `SchedulerRunsRepo`, `ExportRunner`, `ICalConsumer`, `icalSerialize`, `validateHandle`, and `WatchListManager` (handle behavior). Areas without coverage:

- LLM provider implementations (`OllamaProvider`) — currently only exercised through the fake in `ExtractionEngine.test.ts`.
- TUI views (`RawItems`, `ExtractedEvents`, `NormalizedEvents`, `ReviewQueue`, `WatchList`, `Monitor`).
- Daemon wiring.

Follow-up:

- Add coverage when behavior gets non-trivial enough that regressions become a real risk.

### `listNormalizedEvents` N+1 regression-guard test fails

`src/core/queries/__tests__/NormalizedEventsQueries.test.ts` includes a "query count is constant regardless of result size (N+1 regression guard)" test. It currently fails on `main` — the 1-row case logs 5 queries while the 20-row case logs 4 (or similar small delta), so the assertion that the counts are equal trips. The pipeline keeps the failure visible but does not block on it; everything else in the suite passes.

The most likely cause is a conditional code path inside `listNormalizedEvents` that only runs when the result set contains a `parentEventId` (the parent-titles fetch in `NormalizedEventsQueries.ts` is the obvious candidate), combined with seed data that happens to satisfy that condition for one of the two cases but not the other. The query plan is not actually N+1; the test's "constant query count" invariant is too strict for the current implementation.

Follow-up:

- Either relax the test to assert query count grows by at most a small constant (the actual invariant we care about), or change the query to issue the conditional fetches unconditionally so the count matches.
- Re-run the suite after fixing and confirm 195/195 pass.

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

The strategy layer exists, but source-specific behavior is conservative. It does not yet include richer source-specific rules, fixture-driven prompts, or configurable extraction policies. Phase 3 resolution has landed without surfacing a concrete shortfall yet, so this remains "expand when a real gap is observed."

Follow-up:

- Expand the strategy layer when the review queue or resolution decisions reveal a missing field or extraction rule.
- Keep artist-, song-, concert-, and venue-specific rules out of the core engine.

### Operator inspection surface for `not_an_event` orphan rows

Annotation reconciliation has landed (`design_docs/2026-05-14-annotation-reconciliation/`), so annotation rows now attach to their parent normalized event and surface in the event modal "Updates" section. The remaining piece is the orphan side: there is no UI today for browsing `raw_items.status='not_an_event'` rows by category, spot-checking the LLM's classification, or returning misclassified items to the queue. The reset script is the only path.

Follow-up:

- Add an operator-facing surface (admin tab) to browse orphan posts by category. The orphan category is logged but not persisted as a column; promote it back to a `raw_items` column when a filter consumer appears.

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
- Treat discovered venues as weaker Phase 3 resolution signals than verified venues.

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

## Timezone handling

### No venue-level or event-level timezone stored

`artists.timezone` exists and is the extraction-time fallback (artist → `config.defaultTimezone` → reject). For *display*, this is also a reasonable proxy ("this artist's events default to JST"), but it breaks for an artist's overseas tour: the venue is in a different TZ than the artist's home TZ, and we have no field for it.

Follow-up:

- Add `timezone` (IANA name) to `venues`, with `normalized_events.timezone` as a fallback when venue TZ is unknown. Web UI display can then prefer venue → artist → config.
- Decide the display contract for cross-TZ users (browser-local vs. event-local with annotation) when the Phase 6 dashboard hits this.

### TUI displays dates in host-local time

`NormalizedEvents.tsx` and other views call `new Date(startTime).toLocaleString()`, which renders in the daemon host's locale. Cosmetic and operator-only — not a correctness issue — but inconsistent if operator and event venue are in different timezones.

Follow-up:

- Switch TUI display to render in artist-local TZ (`artists.timezone`) with an explicit suffix (`18:00 JST`). Upgrade to venue-local once the venue/event TZ field above lands.

## Phase 3 Event Resolution

### Title similarity is deterministic only

The current `titleSimilarity` uses Jaccard token overlap + substring containment, CJK-safe. Per the design doc, semantic vector similarity was deferred. If false-merges or missed-merges become a recurring pattern in the review queue, revisit.

Follow-up:

- Inspect the review queue periodically to see whether semantic matching would actually move the needle.
- Document and add semantic matching as a layered pass (not a replacement) if needed.

### Sub-event hint matching only checks normalized titles, not aliases

`tryHierarchyResolution` matches `parent_event_hint` against the canonical main event's title. The design doc says it should also match against aliases — but events don't have an alias model yet (only venues do).

Follow-up:

- If hint matching misses obvious parents (visible in the review queue), add an event-alias table or use the union of merged extracted-event titles as informal aliases.

## Scheduler

### Ingestion connector registry is hardcoded

`runIngestionCycle` instantiates `TwitterConnector` directly and only iterates `getActiveTargets("twitter")`. Adding Instagram/YouTube means editing the function. The conceptual `connectors: Record<string, BaseConnector>` registry from the design doc isn't implemented yet because there's only one connector — defer until the second one lands.

Follow-up:

- When adding a second connector, accept `connectors: Record<string, BaseConnector>` as a parameter to `runIngestionCycle` and iterate platforms.

### Browser context is recreated every ingestion cycle

Every cycle does `launchPersistentContext` → process all targets → `close`. Each cycle pays a ~5–10s cold-start cost. Acceptable at the default 15-minute interval, expensive if shortened. Reusing the context across cycles is doable but trades simplicity for a moving piece (a stuck/zombie context between cycles is harder to detect than one that's clearly torn down each time).

Follow-up:

- Defer until ingestion intervals get tightened or browser cold-start becomes a measurable bottleneck. Then weigh the recovery cost.

## Raw Storage

### No alerting on persistent storage failures

`RawStorage` write paths propagate errors to the scheduler's per-target catch, which logs the failure and surfaces it in `scheduler_runs.details.perTarget[username].errorClass` for the Monitor view. A catastrophic failure (`SQLITE_CORRUPT`, `SQLITE_READONLY`, `SQLITE_FULL`) is now visible — but it produces an endless stream of identical failed runs while the daemon keeps running. We deliberately do not crash on these; daemons that quit on a transient disk hiccup cause more pages than they prevent.

Follow-up (Phase 8):

- Track a per-target consecutive-failure counter on top of the existing `scheduler_runs` data; mark a target unhealthy after N failures; trigger an alert; let the operator decide whether to intervene.

### `scheduler_runs` pruning is manual

`scheduler_runs` grows unbounded as the daemon runs. With the current 1- to 30-minute cadences, this is roughly 100–700 rows/day — fine for SQLite, harmless for the Monitor view's `LIMIT 50`. Manual pruning is available via `npm run reset:runs -- --older-than=30d`.

Follow-up:

- Add a daily prune `ScheduledTask` if the table grows large enough to slow queries, or if a Phase 8 retention policy is needed for compliance/visibility reasons.

### Monitor view computes per-target stats client-side

The Monitor TUI scans the most recent `scheduler_runs` rows and groups by `details.perTarget` in TypeScript to compute "last success per target." This is fine for ~50 rows but will not scale to richer dashboards.

Follow-up:

- Promote per-target stats to a denormalized view or aggregate query when Phase 8 alerting needs server-side aggregation.

### Resolution per-event failures are not persisted

`EventResolver.processBatch` catches per-event errors and increments a `failed` counter that ends up in `scheduler_runs.details`. The failed event itself stays un-resolved and retries next cycle. There's no per-event error_class tagging like `raw_items` has.

Follow-up:

- If recurring resolver errors become a real signal (e.g., a code bug producing the same exception every cycle), promote to a similar `error_class`-tagged persistence shape. Ephemeral retry is fine for now.

### Optional indexes deferred until needed

The original design proposed `(source_name, status)` and `fetched_at` indexes. Only the unique `(source_name, source_id)` index is in place. `getUnprocessed` currently scans by `status = 'new'` ordered by `fetched_at`.

Follow-up:

- Add the deferred indexes if `getUnprocessed` becomes a hot path or batch sizes grow.

## Twitter/X Connector

### Connector depends on X internal GraphQL shape

The Twitter connector intercepts X GraphQL responses. This is more stable than DOM scraping but still fragile if X changes response names or payload structure. `TimelineShapeError` (from the login-wall detection design) makes shape changes loud, but doesn't fix the underlying fragility.

Follow-up:

- Add connector health checks.
- Add sample payload fixtures so a shape change can be reproduced offline.

### Anti-bot marker list will drift

`src/connectors/twitter/errors.ts` exports `ANTI_BOT_MARKERS`, a small list of (location, substring) pairs used to detect Cloudflare-style interstitials. Platforms update these pages over time. Periodic refresh required.

Follow-up:

- Review the list quarterly or whenever an `AntiBotError` rate spike is observed.

### Anti-lock follow-ups deferred per design doc

`design_docs/2026-05-09-twitter-anti-lock` landed launch-options unification, dropped the hard-coded UA, and switched to headful. The remaining behavioral fingerprint surface is unaddressed:

- **Login still happens inside Playwright.** Importing cookies from the operator's real Chrome profile would remove the riskiest moment in the session lifetime.
- **`window.scrollBy` emits no `wheel` events.** `page.mouse.wheel` would dispatch real wheel events.
- **Per-page timing is metronomic.** The 3000ms post-load wait and 1500ms scroll delay are constants. Add ±30–50% jitter, occasional heavier-tail pauses.
- **No mouse movement at all.** A couple of `page.mouse.move` calls between scrolls would be cheap and meaningful.
- **Fixed `1280×800` viewport every session.** ±5% randomization on each session start would break the stable device fingerprint.
- **Ingestion fires on the dot every 60 min.** Schedule jitter on cycle start would help.

Follow-up:

- Promote any of these from "defer" to "address" if a future lock or `AntiBotError` rate spike points at behavioral fingerprinting specifically. Do not preemptively bundle them — each adds surface area, and the unified-fingerprint + headful change is the leverage point.

## Phase 5 Downstream Export

### Monitor TUI hardcodes the task-name list

`src/tui/views/Monitor.tsx` keys its per-task cards on a literal `["Ingestion", "Extraction", "Resolution"]`. Export ticks land in `scheduler_runs` and show up in the bottom recent-runs list, but no per-task card renders for them. The same gap will hit Phase 7 multi-source ingestion and any future `ScheduledTask`.

Follow-up:

- Derive task names from `SELECT DISTINCT task_name FROM scheduler_runs`, falling back to a baseline list when the table is empty.

### iCal `SEQUENCE` is timestamp-derived, not consecutive

`ICalConsumer` emits `SEQUENCE: floor(updated_at / 1000)`. Calendars only require a monotonic non-negative integer per UID, so this works, but values are large (≈10-digit Unix seconds) rather than the conventional small counter. Cosmetic only.

Follow-up:

- If a calendar client rejects the values, switch to a per-UID counter persisted on `normalized_events` or derived from `export_queue.version`.

### Stale iCal files are not swept on artist rename or delete

Artist handles can change via the TUI; an old `<old-handle>.ics` file is not removed. Same for artist deletion. The user explicitly opted out of sweep logic during development.

Follow-up:

- If the project gains real subscribers, add a sweep that lists `outputDir`, compares to the current artist handle set, and removes orphans. Until then, the operator clears the directory manually.

### Export-protocol follow-ups deferred per design doc

The Phase 5 design doc lists items intentionally out of scope: a `Consumer.transform()` hook for parent+sub-event bundling, an `export_rejections` table for operator review of permanently-rejected records, registration-time consumer filters, cross-tick rate limiting. None block any current consumer.

Follow-up:

- Promote each only when a concrete consumer needs it.

## TUI / Developer Workflow

### One-shot scripts are useful but informal

`extract:once` and `resolve:once` are useful for development and repair. `extract:once` already supports `--limit` and `--retry-errors`; `reset:*` supports `--dry-run`. The remaining gaps are options that don't have a clear use case yet.

Follow-up:

- Add `--source` and `--raw-item-id` filters to `extract:once` when a need arises (e.g., re-extracting a specific item with a new prompt).
- Pair with the deferred reprocess command (see "Existing extracted data may need reprocessing").

## Documentation Hygiene

### Design docs may drift from implementation

Several docs are now evolving quickly during Phase 2/3 planning.

Follow-up:

- At the end of each phase, review `ARCHITECTURE.md`, phase design docs, and this file together. Remove resolved items rather than keeping them as historical entries — `git log` is the changelog.
