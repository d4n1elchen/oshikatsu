# Phase 3 Event Resolution Design

## Overview

Phase 3 introduces the **Event Resolution Engine**: the component that takes source-derived extracted event candidates and resolves them into canonical normalized events. "Resolution" is broader than deduplication — the engine has three intertwined responsibilities:

1. **Identity resolution** — decide whether an extracted event represents a new real-world event or refers to an event already known to the system.
2. **Record consolidation (merge / dedup)** — when an extracted event matches an existing canonical event, merge its provenance and related links without overwriting trustworthy canonical fields.
3. **Hierarchy resolution** — decide whether an extracted event is a main event in its own right, or a sub-event that should be linked to an existing canonical main event (e.g., a merch booth or pre-show talk attached to a concert).

The goal is to preserve all source provenance while presenting one canonical normalized event per real-world activity to downstream consumers, with sub-events correctly attached to their parents.

Phase 3 builds on:

- Phase 2 extracted events (each row carries its source provenance inline: `publish_time`, `author`, `source_url`, `raw_content`)
- Direct `extracted_events.artist_id` links populated during extraction when a raw item came from a watch target
- `extracted_events.start_time` / `end_time`
- Source-derived `extracted_events.event_scope` (`main` / `sub` / `unknown`) and `parent_event_hint`
- Phase 2.1 venue database and `extracted_events.venue_id`
- `extracted_event_related_links`

## Problem

The same real-world event surfaces in messy ways across raw items:

- Artist posts an announcement, then official account reposts details. → identity + merge
- A ticket page and a tweet refer to the same concert. → identity + merge
- A release is announced once with teaser text and later with a premiere URL. → identity + merge
- A livestream changes time or gets a follow-up reminder. → identity + merge with conflict handling
- A concert has a separately announced merch booth, pre-show talk, or post-show meet & greet. → hierarchy: distinct canonical event, but child of the concert
- A livestream of the same concert is announced separately. → hierarchy: child of the concert

Without resolution, downstream calendar/notification workflows produce duplicates, fragmented details, and orphaned sub-activities.

## Goals

- Identify whether each extracted event matches an existing canonical event or represents a new one.
- Merge provenance (source references and related links) from duplicate candidates into a single canonical event.
- Detect parent/sub-event relationships using source-derived hints plus conservative signals, and link sub-events to their canonical main event.
- Avoid false merges and false hierarchy links, especially around generic virtual venues and repeated reminders.
- Record why each resolution decision was made (merged, linked as sub-event, treated as new, deferred for review) for debugging and auditability.
- Keep the first implementation conservative and explainable.

## Non-Goals

- Do not implement cross-source identity beyond the current schema assumptions.
- Do not implement semantic vector search in the first Phase 3 pass.
- Do not delete duplicate or sub-event extracted records immediately.
- Do not merge or link based on a single weak signal alone.
- Do not treat venue as mandatory for either merge or hierarchy decisions.
- Do not invent main events that no source has announced (the engine can only link sub-events to canonical main events that already exist).

## Phasing

The Event Resolution Engine is large enough to ship in two stages:

- **Phase 3.0 — Identity & Merge.** Land the canonical normalized event layer, identity resolution, and record consolidation. Hierarchy is recorded as evidence (`event_scope`, `parent_event_hint` carried through to the resolution decision) but not yet acted on.
- **Phase 3.1 — Hierarchy Resolution.** Add parent/sub-event linking on top of the canonical layer, using the hints captured during 3.0 plus conservative signals.

Both stages live in the same component (`EventResolver`) and share the same decision log; the staging is about scope of automation, not separate code.

## Core Concepts

### Extracted Event

An extracted event is one source-derived event candidate extracted from one raw item. It is useful for audit/debugging but is not canonical.

### Normalized Event

A normalized event is the canonical post-resolution record users and downstream systems should treat as the event. A normalized event aggregates one or more extracted events that the engine has resolved to the same identity.

### Resolution Decision

A resolution decision records the signals and reasoning behind one of the following outcomes for an extracted event:

- `new` — no existing canonical event matched; a new normalized event is created.
- `merged` — matched an existing canonical event; provenance and related links were folded in.
- `linked_as_sub` — matched as a sub-event of an existing canonical event (Phase 3.1).
- `needs_review` — signals are ambiguous or conflicting; defer.
- `ignored` — explicitly should not contribute to canonical events (e.g., spam-like reminders).

"Merge decision" from earlier drafts is one specific outcome of a resolution decision.

### Duplicate / Overlapping Candidate

A duplicate candidate is an extracted event believed to refer to the same real-world event as an existing normalized event or another extracted event in the same resolution group.

### Sub-event Candidate

A sub-event candidate is an extracted event that the engine believes describes an activity attached to a larger canonical event rather than a duplicate of it.

## Data Model

### `extracted_events`

Phase 3 depends on the following fields on extracted event candidates, resolved before resolution implementation:

| Field | Type | Description |
| --- | --- | --- |
| `raw_item_id` | text fk unique | Direct link to the source raw item for the one-raw-item-to-one-extracted-event contract. |
| `artist_id` | text fk nullable | Direct link to the primary artist for candidate selection. This intentionally does not model collaborations yet; collaboration support can add `event_artists` later. |
| `start_time` | timestamp nullable | Preferred event start time when known. Some extracted sub-events may not have their own time. |
| `end_time` | timestamp nullable | Optional event end time. |
| `event_scope` | text | `main`, `sub`, or `unknown`; source-derived hint feeding hierarchy resolution. |
| `parent_event_hint` | text nullable | Source-derived hint naming or implying the larger event for a sub-event. |

One raw item maps to at most one extracted event. The current implementation stores this layer in `extracted_events`; Phase 3 should add separate canonical normalized-event storage instead of changing the meaning of extracted rows.

Sub-event hints are not canonical relationships. Phase 3 candidate selection should not require `start_time` for extracted sub-events; when time is missing, use stronger signals such as source references, related links, artist, venue, and `parent_event_hint`, or defer to Phase 3.1 review.

### `normalized_events`

Phase 3 should introduce true normalized events as canonical post-resolution records.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Canonical normalized event identifier |
| `parent_event_id` | text fk nullable | Self-reference to the canonical main event when this record is a sub-event (Phase 3.1). |
| `title` | text | Canonical title selected from merged candidates |
| `description` | text | Canonical description selected or synthesized from merged candidates |
| `artist_id` | text fk nullable | Primary artist for candidate selection and display |
| `start_time` | timestamp nullable | Canonical event start time |
| `end_time` | timestamp nullable | Canonical event end time |
| `venue_id` | text fk nullable | Canonical venue when resolved |
| `venue_name` | text nullable | Best display venue text |
| `venue_url` | text nullable | Best display venue URL |
| `type` | text | Canonical event type |
| `is_cancelled` | boolean | Cancellation flag |
| `tags` | json | Union/curated tags |
| `created_at` | timestamp | Creation time |
| `updated_at` | timestamp | Last update time |

Sub-events cannot have their own sub-events: the hierarchy is one level deep, matching the conceptual schema in `ARCHITECTURE.md`.

### `normalized_event_sources`

Links canonical normalized events to the extracted events they were built from.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal link identifier |
| `normalized_event_id` | text fk | Canonical normalized event |
| `extracted_event_id` | text fk | Source extracted event candidate |
| `role` | text | `primary`, `merged`, `review_candidate`, or `ignored` |
| `created_at` | timestamp | Link creation time |

This link table preserves the many-to-one relationship from source-derived candidates to canonical normalized events without mutating the meaning of either layer.

### `event_resolution_decisions`

Records resolution attempts and decisions. (Earlier drafts called this `event_merge_decisions`; the broader name reflects that not every decision is a merge.)

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal decision identifier |
| `candidate_extracted_event_id` | text fk | Extracted event being evaluated |
| `matched_normalized_event_id` | text fk nullable | Candidate canonical normalized event, if any |
| `decision` | text | `new`, `merged`, `linked_as_sub`, `needs_review`, `no_match`, `ignored` |
| `score` | real nullable | Aggregate score from matching signals |
| `signals` | json | Signal details used for the decision |
| `reason` | text | Human-readable explanation |
| `created_at` | timestamp | Decision time |

The `signals` JSON should be compact and inspectable.

Example:

```json
{
  "time_window": "within_6_hours",
  "related_link_overlap": true,
  "venue_id_match": false,
  "title_similarity": 0.82,
  "source_identity_overlap": false,
  "event_scope": "sub",
  "parent_event_hint_matched": true
}
```

## Candidate Selection

The resolution engine should avoid comparing every event against every other event.

For each new extracted event, select candidate extracted and normalized events using:

- Event time window: initially +/- 48 hours.
- Same `artist_id` when available.
- Same or overlapping related links.
- Same `venue_id`, if present.
- Same source URL or source ID.
- For `event_scope = "sub"` candidates: also include normalized main events whose title or aliases match `parent_event_hint`, regardless of exact time alignment.

Candidate selection can be broad, but resolution decisions should be conservative.

## Matching Signals

Signals feed both identity/merge and hierarchy decisions. The engine interprets the same signal differently depending on `event_scope`.

### Strong Signals

Any of these can heavily influence a merge:

- Same source reference URL or same `(source_name, source_id)`.
- Same related link URL and close event time.
- Same `venue_id`, close event time, and similar title.

### Moderate Signals

These help when combined:

- Similar title.
- Same extracted `venue_name`.
- Same event type.
- Same or nearby event time.
- Shared tags.

### Weak / Risky Signals

These should not cause a merge by themselves:

- Same generic virtual venue such as YouTube.
- Same event type only.
- Same artist/watch target only.
- Similar title without time proximity.
- Same day but unrelated title/links.

### Hierarchy Signals (Phase 3.1)

Distinct from merge signals; used to link a sub-event to a canonical main event rather than to merge them:

- Source `event_scope = "sub"`.
- `parent_event_hint` matches the canonical main event's title or a known alias.
- Same `artist_id` and start time within the main event's window.
- Same `venue_id` or compatible venue (e.g., the same physical venue, or a livestream venue paired with a physical main event).

Merge and hierarchy decisions are mutually exclusive for a single resolution pass: an extracted event is either folded into an existing canonical event (merge) or attached as a sub-event (link), but not both.

## Initial Resolution Rules

The first implementation should use explainable rules before more advanced scoring.

### Merge cases (Phase 3.0)

Recommended automatic merge cases:

1. **Exact source duplicate**
   - Same source reference URL or same `(source_name, source_id)`.

2. **Same related link + close time**
   - At least one identical related link URL.
   - Event times are within 48 hours.

3. **Same venue + close time + similar title**
   - Same non-null `venue_id`.
   - Event times are within 48 hours.
   - Title similarity passes threshold.

Recommended review cases:

- Same related link but event times differ by more than 48 hours.
- Same venue and similar title but no related link overlap.
- Similar title and close time, but no venue or link support.

Recommended no-match cases:

- Only same generic virtual venue.
- Only same artist/watch target.
- Only same event type.

### Hierarchy cases (Phase 3.1)

Recommended automatic sub-event link cases:

1. **Explicit hint + matching parent**
   - `event_scope = "sub"` and `parent_event_hint` matches a canonical main event's title or alias.
   - Same `artist_id`.
   - Sub-event start time, when present, falls within the main event's day or extended window.

2. **Strong contextual attachment**
   - `event_scope = "sub"`.
   - Same `artist_id`, same `venue_id`, and start time within the main event's window.

Recommended review cases for hierarchy:

- `event_scope = "sub"` but no `parent_event_hint` and no exact venue/time overlap.
- A candidate sub-event matches multiple plausible main events.

Recommended no-link cases:

- `event_scope = "main"` or `unknown` without strong sub-event evidence.
- Hint matches a main event from a different artist.

## Title Similarity

Start with a simple deterministic similarity function.

Possible first-pass approach:

- Normalize whitespace.
- Case-fold ASCII characters.
- Preserve Japanese and official names.
- Compare token overlap and substring containment.

Avoid romanizing Japanese titles or names for matching in the first pass.

If deterministic similarity is not enough later, document and add semantic matching separately.

## Resolution Behavior

### Merge

When extracted event B is merged into normalized event A:

1. Create or update normalized event A.
2. Add a `normalized_event_sources` row linking A to extracted event B.
3. Copy or project B's related links into canonical normalized-event related links, deduped by URL.
4. Keep source references attached to the extracted event layer, and expose them through `normalized_event_sources`.
5. Record an `event_resolution_decisions` row with `decision = "merged"`.

### Sub-event link (Phase 3.1)

When extracted event B is resolved as a sub-event of canonical main event A:

1. Create a new normalized event B' with `parent_event_id = A.id`.
2. Add a `normalized_event_sources` row linking B' to extracted event B.
3. Copy B's related links onto B' (not onto A), deduped by URL.
4. Record an `event_resolution_decisions` row with `decision = "linked_as_sub"` and the matched signals.

### Near-term recommendations

- Keep extracted event rows as immutable-ish audit records.
- Query source references through `normalized_event_sources` rather than moving provenance away from the extracted layer.
- Do not delete duplicate or sub-event candidates automatically.

## Canonical Field Selection

When merging, normalized event fields should be updated conservatively.

Recommended rules:

- Keep the earliest high-quality title unless the new title is clearly more specific.
- Prefer non-empty description, but avoid overwriting with shorter reminders.
- Prefer explicit event time over publish-time defaults.
- Preserve `is_cancelled = true` if any source indicates cancellation.
- Union tags.
- Union related links by URL.
- Preserve all source references.

Conflict examples:

- Different event times: mark `needs_review` unless one appears to be an update/reschedule.
- Different venues: mark `needs_review` unless one is generic virtual and the other is specific.

For sub-events, canonical fields are selected from the sub-event's own extracted candidates only; the parent's fields are not edited by sub-event resolution.

## Cancellation and Reschedule Updates

Cancellation and reschedule handling should be conservative.

If a duplicate source clearly indicates cancellation:

- Set canonical `is_cancelled = true`.
- Preserve source reference.
- Record resolution decision reason.

If a source indicates a new time:

- Do not automatically overwrite unless the source is clearly an update to the same event.
- Prefer `needs_review` for ambiguous time conflicts.

## TUI / Debug Visibility

The Events TUI should eventually expose:

- Canonical vs duplicate vs sub-event status.
- Number of merged source references.
- Related link count.
- Resolution decision reason.
- Parent event reference for sub-events.
- `needs_review` queue.

The first implementation can start with a read-only resolution status display.

## Execution Flow

Recommended placement:

1. Raw ingestion stores raw items.
2. Extraction creates one extracted event, source reference, and related links.
3. Phase 2.1 venue resolver has already attempted `venue_id` population.
4. Event Resolution Engine evaluates the new extracted event:
   a. Select candidates.
   b. Try identity/merge resolution against canonical events and other recent candidates.
   c. If no merge match, try hierarchy resolution (Phase 3.1).
   d. Otherwise, treat as a new canonical event.
5. A normalized canonical event is created or updated; sub-event links are written if applicable.
6. Resolution decision is recorded.

The resolution engine should be idempotent. Re-running it should not duplicate source references, related links, sub-event links, or resolution decisions unnecessarily.

## Testing Strategy

Required fixtures:

- Same related link + close time should merge.
- Same source reference should merge.
- Same generic virtual venue only should not merge.
- Same venue + close time + similar title should merge.
- Similar title but far time should not merge automatically.
- Conflicting venue or time should produce `needs_review`.
- Related links are deduped by URL on merge.
- Source references are preserved.
- `event_scope = "sub"` with matching `parent_event_hint` should link as sub-event, not merge (Phase 3.1).
- `event_scope = "sub"` with no parent match should produce `needs_review`, not invent a parent (Phase 3.1).
- Sub-event resolution does not edit the parent's canonical fields (Phase 3.1).

## Implementation Plan

Phase 3.0:

1. Add schema for canonical `normalized_events`, `normalized_event_sources`, and `event_resolution_decisions` (note the rename from `event_merge_decisions`).
2. Implement title similarity helper.
3. Implement `EventResolver` (the Event Resolution Engine).
4. Implement candidate selection queries.
5. Implement conservative rule-based identity/merge decisions.
6. Update extraction/daemon flow to run resolution after each batch, after Phase 2.1 venue resolution.
7. Add TUI display for resolution status.
8. Add fixture tests.

Phase 3.1:

9. Add `parent_event_id` self-reference on `normalized_events`.
10. Extend `EventResolver` with hierarchy resolution rules and `linked_as_sub` outcome.
11. Surface parent/sub relationships in the TUI.
12. Add hierarchy fixture tests.

## Open Questions

- Should canonical normalized-event related links be copied from extracted links, queried through `normalized_event_sources`, or both?
- Should resolution decisions be append-only, or should reruns update previous decisions?
- What threshold should title similarity use initially?
- Should `needs_review` be managed in TUI during Phase 3.0 or deferred?
- Should cancellation/reschedule handling be part of first Phase 3.0 implementation or a follow-up?
- Should hierarchy resolution run in the same pass as identity/merge, or as a follow-up sweep over recently created canonical events?

## Current Status

Not implemented yet. This document defines the Phase 3 target design. The component name "Event Resolution Engine" replaces the earlier "Merge/Deduplication Layer" terminology to reflect that the component handles identity, consolidation, and hierarchy together.
