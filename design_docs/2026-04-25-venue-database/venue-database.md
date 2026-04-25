# Phase 2.1 Venue Database Design

## Overview

The Venue Database is a Phase 2.1 reference layer for physical and virtual event locations. It should be implemented after Phase 2 normalization and before Phase 3 merge/deduplication.

The purpose of Phase 2.1 is to give Phase 3 a stable venue identity without replacing the venue text extracted during normalization. Phase 2 normalized events store venue text directly as `venue_name` and `venue_url`; Phase 2.1 adds a nullable `venue_id` so those events can point at a canonical venue record when exact resolution is possible.

## Problem

Announcements often refer to the same venue using different names or formats.

Examples:

- `Tokyo Dome`
- `東京ドーム`
- `TOKYO DOME`
- `YouTube`
- `YouTube Premiere`
- `オンライン配信`

Without a venue database, deduplication can only compare raw text fields. That makes it harder to identify duplicate events when sources describe the same venue differently.

## Goals

- Create a canonical venue identity for deduplication and enrichment.
- Support both physical venues and virtual platforms.
- Preserve the original venue text extracted from each source.
- Add only the minimum venue linkage needed before Phase 3.
- Keep venue matching conservative so incorrect venue links do not cause false merges.
- Leave room for future venue management UI.

## Non-Goals

- Do not implement a full global venue directory.
- Do not require every event to have a venue record.
- Do not automatically geocode addresses in Phase 2.1.
- Do not use venue matching as the only deduplication signal.
- Do not overwrite the original extracted `venue_name` and `venue_url`.
- Do not model multiple venues per event yet.

## Data Model

### `venues`

Canonical venue records.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal venue identifier |
| `name` | text | Canonical display name |
| `kind` | text | `physical`, `virtual`, or `unknown` |
| `url` | text nullable | Official venue/platform URL |
| `address` | text nullable | Physical address when known |
| `city` | text nullable | City or locality |
| `region` | text nullable | State/prefecture/region |
| `country` | text nullable | Country |
| `latitude` | real nullable | Optional latitude |
| `longitude` | real nullable | Optional longitude |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

Recommended indexes:

- `venues.name`
- `venues.url`
- `venues.kind`

### `venue_aliases`

Alternate names or spellings for a venue.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal alias identifier |
| `venue_id` | text fk | Canonical venue |
| `alias` | text | Alternate spelling/name |
| `locale` | text nullable | Optional locale/language hint, e.g. `ja`, `en` |
| `source` | text nullable | Where the alias came from, e.g. `manual`, `normalization`, `import` |
| `created_at` | timestamp | Creation time |

Recommended unique constraint:

- `(venue_id, alias)`

### `normalized_events` additions

Add a nullable canonical venue reference:

| Field | Type | Description |
| --- | --- | --- |
| `venue_id` | text fk nullable | Canonical venue when resolved |

Existing fields remain:

- `venue_name`
- `venue_url`

These fields represent extracted/display venue text. `venue_id` adds canonical identity without removing the original extraction.

## Venue Kinds

### Physical

Physical venues have a location such as city/country and optionally address or coordinates.

Examples:

- Concert halls
- Arenas
- Theaters
- Convention centers
- Pop-up shops

### Virtual

Virtual venues are online destinations or platforms.

Examples:

- YouTube
- Twitch
- NicoNico
- Streaming+
- Z-aN

Virtual venues may have a canonical platform URL but usually do not have address or coordinates.

### Unknown

Use `unknown` when a venue record exists but its physical/virtual nature is not clear yet.

## Venue Resolution

Venue resolution should be conservative in Phase 2.1.

Recommended matching order:

1. **Exact URL match**: If `normalized_events.venue_url` matches a known venue URL or known platform URL.
2. **Exact alias match**: Normalize whitespace/case and compare `normalized_events.venue_name` to `venue_aliases.alias`.
3. **Manual link**: User or future UI explicitly sets `normalized_events.venue_id`.
4. **Unmatched**: Keep `venue_id = null` and preserve extracted venue text.

Normalization for matching may include:

- Trim surrounding whitespace.
- Collapse repeated spaces.
- Case-fold ASCII text.
- Preserve original Japanese/official names.
- Do not romanize names automatically.

LLM-suggested venue candidates can be explored later, but Phase 2.1 should start with exact URL and exact alias matching.

## Use in Phase 3 Deduplication

Venue identity can strengthen event matching but should not be mandatory.

Strong dedup signals:

- Same canonical `venue_id` and close event time.
- Same related link URL and close event time.
- Same source URL or exact source ID.

Moderate dedup signals:

- Same extracted `venue_name` and similar title.
- Same city/country through matched venue records and close event time.
- Same virtual platform and similar title.

Weak or risky dedup signals:

- Venue name only, without time/title similarity.
- Generic virtual venues such as `YouTube`, because many unrelated events happen there.

Dedup should avoid merging events based only on common generic virtual platforms.

## Future Expansion: Event-Venue Links

If the system later needs multiple venues per event, venue match confidence/history, or detailed auditability of venue resolution, add an `event_venue_links` table.

That table is intentionally deferred for now. The Phase 2.1 model should use nullable `normalized_events.venue_id` to keep the implementation small.

## TUI / UI Considerations

Phase 2.1 TUI may show venue match status for debugging:

- Extracted venue name
- Matched canonical venue name, if any
- Venue kind

Full venue CRUD can wait until a later management UI, but the Phase 2.1 storage model should support it.

## Implementation Plan

1. Add Drizzle tables:
   - `venues`
   - `venue_aliases`
2. Add nullable `venue_id` to `normalized_events`.
3. Add TypeScript inferred types.
4. Add a `VenueResolver` service with conservative exact URL and exact alias matching.
5. Update normalization persistence or post-normalization processing to populate `venue_id` when a venue can be resolved.
6. Use `venue_id` as one signal in Phase 3 deduplication.
7. Add focused tests for exact alias, exact URL, unmatched venue, and virtual venue matching.

## Open Questions

- Should manually curated starter venues be seeded in migrations or loaded from a separate data file?
- Should common virtual platforms such as YouTube be seeded immediately?
- Should venue URL matching include related links or only `venue_url`?
- Should exact venue matching run during normalization or as a separate enrichment pass before deduplication?

## Current Status

Not implemented yet. This document defines the target model for Phase 2.1.
