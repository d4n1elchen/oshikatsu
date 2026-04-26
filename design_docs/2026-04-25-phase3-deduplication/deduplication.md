# Phase 3 Merge and Deduplication Design

## Overview

Phase 3 consolidates multiple normalized records that refer to the same real-world event. The goal is to preserve all source provenance while presenting one canonical event to downstream consumers.

Phase 3 builds on:

- Phase 2 normalized events
- Direct `normalized_events.artist_id` links populated during normalization when a raw item came from a watch target
- `normalized_events.start_time` / `end_time`
- Phase 2.1 venue database and `normalized_events.venue_id`
- `source_references`
- `event_related_links`

## Problem

The same event may be announced multiple times or by multiple sources.

Examples:

- Artist posts an announcement, then official account reposts details.
- A ticket page and a tweet refer to the same concert.
- A release is announced once with teaser text and later with a premiere URL.
- A livestream changes time or gets a follow-up reminder.

Without deduplication, downstream calendar/notification workflows may create duplicates and users may see fragmented event details.

## Goals

- Identify duplicate or overlapping normalized events.
- Merge source provenance into a single canonical event.
- Preserve source references and related links from all duplicates.
- Avoid false merges, especially for generic virtual venues and repeated reminders.
- Record why a merge happened for debugging.
- Keep the first implementation conservative and explainable.

## Non-Goals

- Do not implement cross-source support beyond the current schema assumptions.
- Do not implement semantic vector search in the first Phase 3 pass.
- Do not delete duplicate records immediately.
- Do not merge based on one weak signal alone.
- Do not treat venue as mandatory.

## Core Concepts

### Canonical Event

A canonical event is the record users and downstream systems should treat as the primary event.

### Duplicate Event

A duplicate event is a normalized event believed to refer to the same real-world event as a canonical event.

### Merge Decision

A merge decision records the signals and reasoning that caused one event to be linked or merged into another.

## Data Model

### `normalized_events` additions

Phase 3 depends on the following identity and time fields, resolved before dedup implementation:

| Field | Type | Description |
| --- | --- | --- |
| `artist_id` | text fk nullable | Direct link to the primary artist for candidate selection. This intentionally does not model collaborations yet; collaboration support can add `event_artists` later. |
| `start_time` | timestamp nullable | Preferred event start time. New code should use this for time-window queries. |
| `end_time` | timestamp nullable | Optional event end time. |

`event_time` is removed from the active schema. Historical migrations may create it before a later migration drops it, but Phase 3 code should use `start_time`.

Add canonical linkage fields:

| Field | Type | Description |
| --- | --- | --- |
| `canonical_event_id` | text fk nullable | Points to the canonical event when this event is a duplicate |
| `merge_status` | text | `canonical`, `duplicate`, `needs_review`, or `ignored` |

Default:

- `canonical_event_id = null`
- `merge_status = "canonical"`

Interpretation:

- If `canonical_event_id` is null and `merge_status = "canonical"`, the event is currently canonical.
- If `canonical_event_id` is set, the event is a duplicate of that canonical event.
- `needs_review` means the dedup engine found possible candidates but did not safely merge.

### `event_merge_decisions`

Records merge attempts and decisions.

| Field | Type | Description |
| --- | --- | --- |
| `id` | text uuid | Internal decision identifier |
| `candidate_event_id` | text fk | Event being evaluated |
| `matched_event_id` | text fk nullable | Candidate canonical event, if any |
| `decision` | text | `merged`, `needs_review`, `no_match`, `ignored` |
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
  "source_reference_overlap": false
}
```

## Candidate Selection

The dedup engine should avoid comparing every event against every other event.

For each new or unmerged event, select candidates using:

- Event time window: initially +/- 48 hours.
- Same `artist_id` when available.
- Same or overlapping related links.
- Same `venue_id`, if present.
- Same source URL or source ID.

Candidate selection can be broad, but merge decisions should be conservative.

## Matching Signals

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

## Initial Merge Rules

The first implementation should use explainable rules before more advanced scoring.

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

## Title Similarity

Start with a simple deterministic similarity function.

Possible first-pass approach:

- Normalize whitespace.
- Case-fold ASCII characters.
- Preserve Japanese and official names.
- Compare token overlap and substring containment.

Avoid romanizing Japanese titles or names for matching in the first pass.

If deterministic similarity is not enough later, document and add semantic matching separately.

## Merge Behavior

When event B is merged into canonical event A:

1. Set `B.canonical_event_id = A.id`.
2. Set `B.merge_status = "duplicate"`.
3. Copy B's `source_references` to point at A, or keep them on B and query through duplicate links.
4. Copy B's `event_related_links` to A, deduped by URL.
5. Record an `event_merge_decisions` row.

Near-term recommendation:

- Keep duplicate event rows.
- Move or copy source references and related links onto the canonical event.
- Do not delete duplicates.

## Canonical Field Selection

When merging, canonical event fields should be updated conservatively.

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

## Cancellation and Reschedule Updates

Cancellation and reschedule handling should be conservative.

If a duplicate source clearly indicates cancellation:

- Set canonical `is_cancelled = true`.
- Preserve source reference.
- Record merge decision reason.

If a source indicates a new time:

- Do not automatically overwrite unless the source is clearly an update to the same event.
- Prefer `needs_review` for ambiguous time conflicts.

## TUI / Debug Visibility

The Events TUI should eventually expose:

- Canonical vs duplicate status.
- Number of merged source references.
- Related link count.
- Merge decision reason.
- `needs_review` queue.

The first implementation can start with a read-only merge status display.

## Execution Flow

Recommended placement:

1. Raw ingestion stores raw items.
2. Normalization creates normalized event, source reference, and related links.
3. Phase 2.1 venue resolver has already attempted `venue_id` population.
4. Dedup engine evaluates the new normalized event.
5. Merge decision is recorded.

The dedup engine should be idempotent. Re-running it should not duplicate source references, related links, or merge decisions unnecessarily.

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

## Implementation Plan

1. Add schema fields:
   - `normalized_events.canonical_event_id`
   - `normalized_events.merge_status`
   - `event_merge_decisions`
2. Implement title similarity helper.
3. Implement `DeduplicationEngine`.
4. Implement candidate selection queries.
5. Implement conservative rule-based merge decisions.
6. Update normalization/daemon flow to run dedup after each batch, after Phase 2.1 venue resolution.
7. Add TUI display for merge status.
8. Add fixture tests.

## Open Questions

- Should source references be moved to canonical events or queried across duplicate links?
- Should merge decisions be append-only, or should reruns update previous decisions?
- What threshold should title similarity use initially?
- Should `needs_review` be managed in TUI during Phase 3 or deferred?
- Should cancellation/reschedule handling be part of first Phase 3 implementation or a follow-up?

## Current Status

Not implemented yet. This document defines the Phase 3 target design.
