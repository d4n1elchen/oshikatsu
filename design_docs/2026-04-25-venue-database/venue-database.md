# Phase 2.1 Venue Database Design

## Overview

The Venue Database is a Phase 2.1 reference layer for physical and virtual event locations. It should be implemented after Phase 2 extraction and before Phase 3 event resolution.

The purpose of Phase 2.1 is to give Phase 3 a stable venue identity without replacing the venue text extracted during extraction. Each extracted event stores its per-source venue extraction in `extracted_events.venue_name` and `extracted_events.venue_url` (the per-source extraction is also the best display value, since each extracted event is 1:1 with a raw item). Phase 2.1 adds a nullable `venue_id` so candidates can point at a canonical venue record when exact resolution is possible.

## Problem

Announcements often refer to the same venue using different names or formats.

Examples:

- `Tokyo Dome`
- `東京ドーム`
- `TOKYO DOME`
- `YouTube`
- `YouTube Premiere`
- `オンライン配信`

Without a venue database, event resolution can only compare raw text fields. That makes it harder to identify duplicate or related events when sources describe the same venue differently.

## Goals

- Create a canonical venue identity for event resolution and enrichment.
- Support both physical venues and virtual platforms.
- Preserve the original venue text extracted from each source.
- Add only the minimum venue linkage needed before Phase 3.
- Keep venue matching conservative so incorrect venue links do not cause false merges.
- Leave room for future venue management UI.

## Non-Goals

- Do not implement a full global venue directory.
- Do not require every event to have a venue record.
- Do not automatically geocode addresses in Phase 2.1.
- Do not use venue matching as the only event resolution signal.
- Do not overwrite the original venue extraction preserved on the extracted event (`venue_name`, `venue_url`).
- Do not model multiple venues per event yet.

## Data Model

### `venues`

Canonical venue records.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal venue identifier |
| `name` | text | Canonical display name |
| `kind` | text | `physical`, `virtual`, or `unknown` |
| `status` | text | `discovered`, `verified`, or `ignored` |
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
- `venues.status`

### `venue_aliases`

Alternate names or spellings for a venue.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal alias identifier |
| `venue_id` | text fk | Canonical venue |
| `alias` | text | Alternate spelling/name |
| `locale` | text nullable | Optional locale/language hint, e.g. `ja`, `en` |
| `source` | text nullable | Where the alias came from, e.g. `manual`, `extraction`, `import` |
| `created_at` | timestamp | Creation time |

Recommended unique constraint:

- `(venue_id, alias)`

### `extracted_events` additions

Add a nullable canonical venue reference:

| Field | Type | Description |
| --- | --- | --- |
| `venue_id` | text fk nullable | Canonical venue when resolved |

Existing fields remain:

- `venue_name`
- `venue_url`

These extracted event-level fields *are* the per-source extraction (each extracted event is 1:1 with a raw item), and they double as the best display value. `venue_id` adds canonical identity without removing the original extraction.

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

Venue resolution should be conservative and auto-discovery first in Phase 2.1. The system should not require manually created venues before it can start assigning `venue_id`.

Recommended matching order:

1. **Exact URL match**: If `extracted_events.venue_url` matches a known venue URL or known platform URL.
2. **Exact alias match**: Normalize whitespace/case and compare `extracted_events.venue_name` to `venue_aliases.alias`.
3. **Exact name match**: Normalize whitespace/case and compare `extracted_events.venue_name` to `venues.name`.
4. **Auto-discovery**: If `venue_name` exists and no exact match is found, create a new venue with `status = "discovered"` and add the extracted name as an alias.
5. **Manual link**: User or future UI explicitly sets `extracted_events.venue_id`.
6. **Unmatched**: Keep `venue_id = null` only when no usable `venue_name` exists.

Normalization for matching may include:

- Trim surrounding whitespace.
- Collapse repeated spaces.
- Case-fold ASCII text.
- Preserve original Japanese/official names.
- Do not romanize names automatically.

LLM-suggested venue candidates can be explored later, but Phase 2.1 should start with exact URL and exact alias matching.

### Venue Status

Venue status indicates how trustworthy the venue record is.

- `discovered`: Created automatically from extracted event data.
- `verified`: Reviewed or curated by a user or trusted seed data.
- `ignored`: Known noisy/generic venue value that should not be used as an event resolution signal.

Newly auto-created venues should start as `discovered`.

### Auto-Discovery Rules

When an event has extracted `venue_name` and no existing venue matches:

1. Create a `venues` row:
   - `name = venue_name`
   - `kind = "unknown"` unless simple platform detection safely identifies `virtual`
   - `status = "discovered"`
   - `url = venue_url`, if present
2. Create a `venue_aliases` row:
   - `alias = venue_name`
   - `source = "extraction"`
3. Set `extracted_events.venue_id` to the discovered venue ID.

Auto-discovery should not create a venue when `venue_name` is empty, generic punctuation, or otherwise unusable.

If a later event uses a different extracted name for the same exact `venue_url`, the resolver should reuse the existing venue and add the new extracted name as an alias.

## Use in Phase 3 Event Resolution

Venue identity can strengthen event matching (both merge and hierarchy) but should not be mandatory.

Strong resolution signals:

- Same verified canonical `venue_id` and close event time.
- Same related link URL and close event time.
- Same source URL or exact source ID.

Moderate resolution signals:

- Same discovered `venue_id` and close event time, when supported by title similarity or related link overlap.
- Same extracted `venue_name` and similar title.
- Same city/country through matched venue records and close event time.
- Same virtual platform and similar title.

Weak or risky resolution signals:

- Venue name only, without time/title similarity.
- Generic virtual venues such as `YouTube`, because many unrelated events happen there.
- Ignored venues.

Event resolution should avoid merging or linking events based only on common generic virtual platforms.

## Future Expansion: Event-Venue Links

If the system later needs multiple venues per event, venue match confidence/history, or detailed auditability of venue resolution, add an `event_venue_links` table.

That table is intentionally deferred for now. The Phase 2.1 model should use nullable `extracted_events.venue_id` to keep the implementation small.

## TUI / UI Considerations

Phase 2.1 TUI may show venue match status for debugging:

- Extracted venue name
- Matched canonical venue name, if any
- Venue kind
- Venue status

Full venue CRUD can wait until a later management UI, but the Phase 2.1 storage model should support it.

## Implementation Plan

1. Add Drizzle tables:
   - `venues`
   - `venue_aliases`
2. Add nullable `venue_id` to `extracted_events`.
3. Add TypeScript inferred types.
4. Add a `VenueResolver` service with conservative exact URL, exact alias, exact name, and auto-discovery behavior.
5. Update extraction persistence or post-extraction processing to populate `venue_id`, creating discovered venues when needed.
6. Use `venue_id` as one signal in Phase 3 event resolution.
7. Add focused tests for exact alias, exact URL, exact name, auto-discovered venue, ignored venue, and virtual venue matching.

## Open Questions

- Should venue URL matching include related links or only `venue_url`?
- Should exact venue matching run during extraction or as a separate enrichment pass before event resolution?
- Which venue names should be treated as too generic and marked `ignored`?

## Current Status

Implemented base Phase 2.1 support:

- `venues`
- `venue_aliases`
- `venues.status` with `discovered`, `verified`, and `ignored`
- nullable `extracted_events.venue_id`
- conservative exact URL / exact alias / exact name resolver
- auto-discovery for usable extracted venue names
- extraction-sourced venue aliases for discovered venues
- ignored venue names are not reused or rediscovered
- Events TUI visibility for matched canonical venue

Refinements layered on top of the base design:

- `design_docs/2026-04-25-virtual-venue-granularity/virtual-venue-granularity.md` — virtual venues require a URL to be auto-discovered (channel-URL granularity), so platform-only names like "YouTube" no longer create a single conflated venue.

Deferred:

- Venue review / CRUD workflow
- Duplicate discovered venue merge workflow
- Full venue CRUD
- Fuzzy or LLM-suggested venue matching
- `event_venue_links`
