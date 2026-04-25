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

### Venue database is designed but not implemented

The Phase 2.1 design exists in `design_docs/2026-04-25-venue-database/venue-database.md`, but there are no `venues` or `venue_aliases` tables yet.

### Event-venue link table is deferred

The venue design now uses nullable `venue_id` directly on `normalized_events` for the Phase 2.1 implementation.

An `event_venue_links` table is deferred until we need multiple venues per event, venue match confidence/history, or detailed auditability of venue resolution.

### Venue seed data needs a decision

Open questions:

- Should common virtual platforms such as YouTube be seeded immediately?
- Should starter venues be stored in migrations or a separate data file?
- Should venue URL matching include related links or only `venue_url`?

## Phase 3 Merge / Deduplication

### Event identity rules are designed but not implemented

The Phase 3 merge/dedup design exists in `design_docs/2026-04-25-phase3-deduplication/deduplication.md`, but implementation should wait until Phase 2.1 venue database work is complete.

### Merge auditability is undecided

We need to decide how to record why events were merged.

Possible approaches:

- Store merge decision logs.
- Store confidence and matched fields.
- Keep superseded event IDs linked to canonical events.

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
