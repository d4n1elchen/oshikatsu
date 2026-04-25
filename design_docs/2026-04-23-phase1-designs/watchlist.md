# Watch List Manager Design

## Overview

The Watch List Manager is a core component (see [ARCHITECTURE.md](../../ARCHITECTURE.md), Component #2) that provides the logic layer for managing artists and their monitored sources. It reads from and writes to the Watch List storage (same database as [raw storage](./raw-storage.md)).

## Concepts

- **Artist**: A person or group being tracked (e.g., a singer, Vtuber, idol).
- **Watch Target**: A specific feed to monitor for an artist (e.g., a Twitter timeline, a search query, a YouTube channel). Earlier drafts of this doc called this a "Source Entry"; the implementation renamed it to Watch Target and that is the name used in `src/`.
- **Monitoring Toggle**: Both artists and individual watch targets can be independently enabled or disabled.

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

### Watch Target

| Field         | Type     | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| id            | string   | Unique identifier (auto-generated UUID)              |
| artist_id     | string   | Reference to the parent artist                       |
| platform      | string   | Platform identifier (e.g., "twitter", "youtube")     |
| source_type   | string   | Type of source (e.g., "user_timeline", "search")     |
| source_config | json     | Platform-specific parameters (see below)             |
| enabled       | boolean  | Toggle for this individual watch target              |
| created_at    | datetime | When this watch target was added                     |
| updated_at    | datetime | Last modification time                               |

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

## Active Watch Target Resolution

A watch target is **active** (should be fetched) only when:

1. The parent artist's `enabled` is `true`, AND
2. The watch target's `enabled` is `true`.

The Scheduler queries the watch list for active watch targets on each platform before every fetch cycle and dispatches them to the appropriate connector.

## Interface

Note: Drizzle generates camelCase TypeScript field names from the snake_case columns above (e.g., `artist_id` → `artistId`, `source_config` → `sourceConfig`). Code uses the camelCase names; the table column names remain snake_case.

```typescript
export interface Artist {
  id: string;
  name: string;
  categories: string[];
  groups: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WatchTarget {
  id: string;
  artistId: string;
  platform: string;
  sourceType: string;
  sourceConfig: Record<string, any>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WatchListManager {
  // --- Artist management ---

  /** Add a new artist to the watch list. */
  addArtist(name: string, categories?: string[], groups?: string[]): Promise<Artist>;

  /** Remove an artist and all their watch targets (cascading). */
  removeArtist(artistId: string): Promise<void>;

  /** Enable or disable all monitoring for an artist. */
  toggleArtist(artistId: string, enabled: boolean): Promise<void>;

  /** Update an artist's editable fields (name, categories, groups). */
  updateArtist(artistId: string, fields: { name?: string; categories?: string[]; groups?: string[] }): Promise<void>;

  /** List all artists, optionally filtering to enabled only. */
  listArtists(enabledOnly?: boolean): Promise<Artist[]>;

  // --- Watch target management ---

  /** Add a new watch target for an artist. */
  addTarget(artistId: string, platform: string, sourceType: string, sourceConfig: Record<string, any>): Promise<WatchTarget>;

  /** Remove a watch target. */
  removeTarget(targetId: string): Promise<void>;

  /** Enable or disable a specific watch target. */
  toggleTarget(targetId: string, enabled: boolean): Promise<void>;

  /**
   * Get all active watch targets for a platform.
   * Returns targets where both the artist and the target are enabled.
   * Used by the Scheduler to know what to fetch.
   */
  getActiveTargets(platform: string): Promise<WatchTarget[]>;

  /** Get all watch targets for an artist. */
  getTargetsForArtist(artistId: string): Promise<WatchTarget[]>;
}
```

## Storage

The Watch List Manager persists data to the Watch List storage tables (`artists`, `watch_targets`) in the same database as raw items. See [raw-storage.md](./raw-storage.md) for the shared storage backend.

## Integration with Scheduler and Connectors

The Scheduler orchestrates the fetch cycle using the Watch List Manager:

1. Scheduler calls `watchlist.getActiveTargets("twitter")` to get active watch targets.
2. Scheduler dispatches each target to the appropriate connector via `connector.fetchUpdates(target)`.
3. Scheduler bulk-persists returned raw items via `storage.saveItems(targetId, "twitter", items)`.

Connectors do not interact with the Watch List Manager directly — they just receive a `WatchTarget` and fetch data.

## CLI Examples (Future)

```bash
# Add an artist
oshikatsu artist add "Hoshimachi Suisei" --categories vtuber,singer

# Add a Twitter watch target for them
oshikatsu target add <artist_id> twitter user_timeline --username "suisei_hosimati"

# Toggle monitoring
oshikatsu artist disable <artist_id>
oshikatsu target disable <target_id>

# List active watch targets
oshikatsu target list --platform twitter --active
```
