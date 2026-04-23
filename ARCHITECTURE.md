# Oshikatsu Architecture

## Overview

Oshikatsu is a platform for tracking updates about favorite artists and converting them into a unified, analyzable data format. The system ingests data from multiple sources, normalizes it into a consistent schema, deduplicates events, and exports to downstream pipelines.

## Core Components

### 1. Source Connectors

Ingest raw items from external sources (e.g., Twitter/X, Instagram, YouTube).

- Each source has its own connector implementation
- Connectors expose `fetchUpdates()` to retrieve new items
- Connectors are source-agnostic and can be extended independently

### 2. Normalization Engine

Converts raw source items into a unified internal record shape.

- Each source has its own normalizer
- Normalizers expose `normalize(raw)` to transform raw data
- Output follows the unified event schema

### 3. Merge/Deduplication Layer

Identifies and merges duplicate or overlapping events across sources.

- Goal: consolidate multiple source items referring to the same event into a single normalized record while preserving all provenance in `source_entries`

### 4. Repository/Storage Interface

Persists normalized records and supports retrieval.

- Exposes `save(record)` to store records
- Provides query capabilities for downstream consumers

### 5. Downstream Integration

Exposes standardized records to automation workflows.

- Exposes `export(record)` to push data to downstream pipelines
- Supports calendar updates, notification dispatch, and other integrations

## Data Model

### Unified Event Schema

```json
{
  "id": "internal record identifier",
  "source_entries": [
    {
      "source_id": "original ID from the source",
      "source_name": "source identifier (e.g., 'twitter')",
      "publish_time": "when the source item was published",
      "url": "link to the original source item",
      "author": "who posted it (user ID, username)",
      "raw_content": "original text/content"
    }
  ],
  "title": "canonical event title or announcement summary",
  "description": "normalized content summary",
  "event_time": "actual event or activity time",
  "start_time": "event start time",
  "end_time": "event end time",
  "venue": {
    "name": "venue name (e.g., 'Tokyo Dome', 'Twitch')",
    "address": "physical address (for in-person events)",
    "coordinates": "latitude/longitude (optional)",
    "url": "platform/stream URL (for virtual events)",
    "city": "geographic context",
    "country": "geographic context"
  },
  "type": "event category",
  "is_cancelled": "boolean flag for cancelled events",
  "artist": {
    "id": "unique artist identifier",
    "name": "display name",
    "handle": "social media handle (e.g., Twitter/X username)",
    "profile_url": "link to artist profile",
    "categories": "artist type (e.g., singer, Vtuber, idol, voice actor)",
    "groups": "associated groups or units (if applicable)"
  },
  "tags": "normalized labels for event type, platform, fandom, or priority"
}
```

### Event Categories

- `announcement` — general announcement
- `live_stream` — live stream event
- `merchandise` — merchandise release/news
- `release` — song/album/content release
- `concert` — concert or live show
- `broadcast` — TV/radio program update
- `collaboration` — partnership or co-branded project
- `side_event` — ancillary activity (merch booth, pre-show session, etc.)

### Event Hierarchy

- **Main events**: May have `sub_events` array
- **Sub-events**: Must have `parent_event_id`, cannot have their own `sub_events`
- Main events represent the core activity (e.g., the concert)
- Sub-events are related activity records linked back to the main event

## Interfaces

All components expose stable, abstract interfaces:

- `fetchUpdates()` — retrieve new items from a source
- `normalize(raw)` — convert raw source items to unified format
- `merge(existing, normalized)` — identify and merge duplicates
- `save(record)` — persist normalized records
- `export(record)` — expose records to downstream pipelines

## Design Principles

- **Modularity**: Clean separation between ingestion, normalization, deduplication, storage, and downstream export
- **Source-agnostic**: Design allows adding new sources with minimal impact
- **Provenance preservation**: Preserve source provenance while normalizing records
- **Incremental growth**: Start with a single source (Twitter/X) and expand to additional sources over time

## Current Data Source

- Twitter/X is the currently implemented source

## Success Criteria

- **Coverage**: Able to ingest new items from supported sources reliably
- **Consistency**: Data is transformed into a stable, unified schema
- **Extensibility**: New sources can be added with minimal disruption

## Long-term Direction

- Evolve from single-source ingestion into a platform supporting multiple types of information feeds
- Keep the focus on reusable data models and source-agnostic processing
- Support downstream use cases such as event tracking, content aggregation, automatic calendar creation, and automated notification dispatch