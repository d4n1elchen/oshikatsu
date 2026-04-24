# Watch List Manager Design

## Overview

The Watch List Manager is a core component (see [ARCHITECTURE.md](../../ARCHITECTURE.md), Component #2) that provides the logic layer for managing artists and their monitored sources. It reads from and writes to the Watch List storage (same database as [raw storage](./raw-storage.md)).

## Concepts

- **Artist**: A person or group being tracked (e.g., a singer, Vtuber, idol).
- **Source Entry**: A specific feed to monitor for an artist (e.g., a Twitter timeline, a search query, a YouTube channel).
- **Monitoring Toggle**: Both artists and individual source entries can be independently enabled or disabled.

## Data Model

### Artist

| Field       | Type     | Description                                           |
| ----------- | -------- | ----------------------------------------------------- |
| id          | string   | Unique identifier (auto-generated)                    |
| name        | string   | Display name                                          |
| categories  | list     | Artist types (e.g., singer, Vtuber, idol)             |
| groups      | list     | Associated groups or units (optional)                 |
| enabled     | boolean  | Master toggle — disables all sources when false       |
| created_at  | datetime | When this artist was added                            |
| updated_at  | datetime | Last modification time                                |

### Source Entry

| Field        | Type     | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| id           | string   | Unique identifier (auto-generated)                   |
| artist_id    | string   | Reference to the parent artist                       |
| platform     | string   | Platform identifier (e.g., "twitter", "youtube")     |
| source_type  | string   | Type of source (e.g., "user_timeline", "search")     |
| source_config| dict     | Platform-specific parameters (see below)             |
| enabled      | boolean  | Toggle for this individual source                    |
| created_at   | datetime | When this source was added                           |
| updated_at   | datetime | Last modification time                               |

### Source Config Examples

**Twitter user timeline:**
```json
{
  "username": "artist_handle"
}
```

**Twitter search:**
```json
{
  "query": "#OshiArtist OR @artist_handle"
}
```

**YouTube channel (future):**
```json
{
  "channel_id": "UC..."
}
```

The `source_config` is opaque to the watch list — each connector knows how to interpret its own platform's config.

## Active Source Resolution

A source is **active** (should be fetched) only when:

1. The parent artist's `enabled` is `true`, AND
2. The source entry's `enabled` is `true`.

Connectors query the watch list for active sources on their platform before each fetch cycle.

## Interface

```typescript
export interface Artist {
  id: string;
  name: string;
  categories: string[];
  groups: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface SourceEntry {
  id: string;
  artist_id: string;
  platform: string;
  source_type: string;
  source_config: Record<string, any>;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WatchListManager {
  // --- Artist management ---

  /** Add a new artist to the watch list. */
  addArtist(name: string, categories?: string[], groups?: string[]): Promise<Artist>;

  /** Remove an artist and all their source entries. */
  removeArtist(artist_id: string): Promise<void>;

  /** Enable or disable all monitoring for an artist. */
  toggleArtist(artist_id: string, enabled: boolean): Promise<void>;

  /** List all artists, optionally filtering to enabled only. */
  listArtists(enabledOnly?: boolean): Promise<Artist[]>;

  // --- Source entry management ---

  /** Add a new source entry for an artist. */
  addSource(artist_id: string, platform: string, source_type: string, source_config: Record<string, any>): Promise<SourceEntry>;

  /** Remove a source entry. */
  removeSource(source_id: string): Promise<void>;

  /** Enable or disable a specific source. */
  toggleSource(source_id: string, enabled: boolean): Promise<void>;

  /** 
   * Get all active sources for a platform.
   * Returns sources where both the artist and the source are enabled.
   * Used by the Scheduler to know what to fetch.
   */
  getActiveSources(platform: string): Promise<SourceEntry[]>;

  /** Get all source entries for an artist. */
  getSourcesForArtist(artist_id: string): Promise<SourceEntry[]>;
}
```

## Storage

The Watch List Manager persists data to the Watch List storage tables (Artists, Source Entries) in the same database as raw items. See [raw-storage.md](./raw-storage.md) for the shared storage backend.

## Integration with Scheduler and Connectors

The Scheduler orchestrates the fetch cycle using the Watch List Manager:

1. Scheduler calls `watchlist.get_active_sources("twitter")` to get active sources.
2. Scheduler dispatches each source to the appropriate connector via `connector.fetch_updates(source)`.
3. Scheduler saves returned raw items to storage via `storage.save()`.

Connectors do not interact with the Watch List Manager directly — they just receive a `SourceEntry` and fetch data.

## CLI Examples (Future)

```bash
# Add an artist
oshikatsu artist add "Hoshimachi Suisei" --categories vtuber,singer

# Add a Twitter source for them
oshikatsu source add <artist_id> twitter user_timeline --username "suaboroshi"

# Toggle monitoring
oshikatsu artist disable <artist_id>
oshikatsu source disable <source_id>

# List active sources
oshikatsu source list --platform twitter --active
```
