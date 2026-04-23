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
  - `source_entries`: provenance collection (array of source items)
    - `source_id`: original ID from the source (e.g., tweet ID)
    - `source_name`: source identifier (e.g., "twitter")
    - `publish_time`: when the source item was published
    - `url`: link to the original source item
    - `author`: who posted it (user ID, username)
    - `raw_content`: original text/content
  - `title`: canonical event title or announcement summary
  - `description`: normalized content summary
  - `event_time` / `start_time` / `end_time`: actual event or activity time
  - `venue`: normalized place information for the event
    - `name`: venue name (e.g., "Tokyo Dome", "Twitch")
    - `address`: physical address (for in-person events)
    - `coordinates`: latitude/longitude (optional)
    - `url`: platform/stream URL (for virtual events)
    - `city` / `country`: geographic context
  - `type`: event category
    - `announcement` — general announcement
    - `live_stream` — live stream event
    - `merchandise` — merchandise release/news
    - `release` — song/album/content release
    - `concert` — concert or live show
    - `broadcast` — TV/radio program update
    - `collaboration` — partnership or co-branded project
    - `side_event` — ancillary activity (merch booth, pre-show session, etc.)
  - `is_cancelled`: boolean flag for cancelled events
  - `artist`: normalized artist/personality metadata
    - `id`: unique artist identifier
    - `name`: display name
    - `handle`: social media handle (e.g., Twitter/X username)
    - `profile_url`: link to artist profile
    - `categories`: artist type (e.g., singer, Vtuber, idol, voice actor)
    - `groups`: associated groups or units (if applicable)
  - `tags`: normalized labels for event type, platform, fandom, or priority
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
- Merge/deduplication goal: consolidate multiple source items referring to the same event into a single normalized record while preserving all provenance in `source_entries`.

## Artifacts

- `ARCHITECTURE.md` in project root

## Decisions

-

## Action Items

- Create `ARCHITECTURE.md` in project root
