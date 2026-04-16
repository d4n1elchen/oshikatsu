# 2026-04-15 架構討論

## Topics

- Confirm Oshikatsu core system architecture
- Design the data ingestion and processing flow
- Discuss design documentation and implementation responsibilities
- Decide whether to create a new design document or update existing documentation

## Discussion Notes

- The system should be modular and source-agnostic, with a clean separation between ingestion, normalization, deduplication, storage, and downstream export.
- Current focus is on one source (Twitter / X) but the design should allow adding new sources with minimal impact.
- We should preserve source provenance while normalizing records into a unified internal schema.
- Core interactions are: Source Connector -> Normalization -> Merge/Deduplication -> Repository -> Downstream Integration.
- The primary goal is to draft `ARCHITECTURE.md`; this meeting is to capture the high-level architecture concept first.
- Each source should have its own normalizer to translate raw source-specific items into the shared internal record model.
- Proposed components:
  - Source Connectors: ingest raw items from each external source.
  - Normalization Engine: convert raw source items into a unified internal record shape.
  - Merge / Deduplication Layer: identify and merge duplicate or overlapping events across sources.
  - Repository / Storage Interface: persist normalized records and support retrieval.
  - Downstream Integration: expose standardized records to automation workflows, calendars, and notifications.
- Normalized record format should include a stable set of fields for downstream processing, such as:
  - `id`: internal record identifier
  - `source_ids`: mapping of source-specific item IDs and provenance metadata
  - `title`: canonical event title or announcement summary
  - `description`: normalized content summary
  - `timestamp`: normalized publish or source item time
  - `event_time` / `start_time` / `end_time`: actual event or activity time
  - `location` / `venue`: normalized place information for the event
  - `type`: event category (e.g. announcement, live stream, merchandise, release)
    - `collaboration`: activities defined by a partnership or co-branded project
    - `side event`: ancillary activities related to a main event, such as merch or pre-show sessions
  - `artist`: normalized artist/personality metadata
  - `source_metadata`: source-specific details preserved for auditing and context
  - `tags`: normalized labels for event type, platform, fandom, or priority
- Source-specific original time and location should also be preserved in `source_metadata` when available, so the normalized event can retain context and provenance.
- Support one event with multiple source entries, including multiple items from the same source. The normalized event should represent the consolidated activity, while preserving each source item in `source_entries` or equivalent provenance collections.
- Adopt a main event + related sub-events design. Main events and sub-events share the same event-like data structure.
- The only structural difference is:
  - main events may have `sub_events`
  - sub-events must have `parent_event_id`
- Main events represent the core activity (e.g. the concert) and include fields like `id`, `title`, `event_time`, `location`, `artist`, and `type`.
- Sub-events are related activity records that use the same fields but are linked back to the main event through `parent_event_id`.
- Sub-events should not have their own `sub_events`; only main events can have children in the hierarchy.
- Interfaces should be abstract and stable: `fetchUpdates()`, `normalize(raw)`, `merge(existing, normalized)`, `save(record)`, `export(record)`.
- Basic end-to-end flow should be expressed clearly in the design notes before any implementation details.

## Artifacts

-

## Decisions

-

## Action Items

-
