import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listLiveAndUpcomingStreams } from "../StreamsQueries";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      categories TEXT NOT NULL, groups TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE venues (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'discovered', url TEXT, address TEXT, city TEXT,
      region TEXT, country TEXT, latitude REAL, longitude REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY, parent_event_id TEXT, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, series_name TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      operator_owned INTEGER NOT NULL DEFAULT 0, operator_edited_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedVenue(
  db: Db,
  args: { id: string; kind: "physical" | "virtual" | "unknown"; url?: string | null; name?: string }
) {
  await db.insert(schema.venues).values({
    id: args.id, name: args.name ?? `venue-${args.id}`,
    kind: args.kind, status: "verified",
    url: args.url ?? null,
    address: null, city: null, region: null, country: null,
    latitude: null, longitude: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
}

async function seedEvent(
  db: Db,
  args: { id: string; venueId: string; startTime: Date; endTime?: Date | null; title?: string }
) {
  await db.insert(schema.normalizedEvents).values({
    id: args.id, parentEventId: null, artistId: null,
    title: args.title ?? `Event ${args.id}`,
    description: "",
    startTime: args.startTime, endTime: args.endTime ?? null,
    venueId: args.venueId, venueName: null, venueUrl: null,
    type: "live_stream", isCancelled: false, tags: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
}

test("returns empty list when no virtual-venue events exist", async () => {
  const db = createTestDb();
  await seedVenue(db, { id: "v-phys", kind: "physical" });
  await seedEvent(db, { id: "e1", venueId: "v-phys", startTime: new Date(Date.now() + 3600_000) });

  const items = await listLiveAndUpcomingStreams({}, db as any);
  assert.deepEqual(items, []);
});

test("orders ongoing first then upcoming, by start_time asc", async () => {
  const db = createTestDb();
  await seedVenue(db, { id: "v-yt", kind: "virtual", url: "https://youtube.com/@kafu" });

  const now = Date.now();
  await seedEvent(db, { id: "ongoing", venueId: "v-yt", startTime: new Date(now - 600_000) });
  await seedEvent(db, { id: "soon", venueId: "v-yt", startTime: new Date(now + 1000_000) });
  await seedEvent(db, { id: "later", venueId: "v-yt", startTime: new Date(now + 5_000_000) });

  const items = await listLiveAndUpcomingStreams({}, db as any);
  assert.deepEqual(items.map((i) => i.id), ["ongoing", "soon", "later"]);
  assert.equal(items[0]!.isLive, true);
  assert.equal(items[1]!.isLive, false);
});

test("excludes ended events past the grace window", async () => {
  const db = createTestDb();
  await seedVenue(db, { id: "v", kind: "virtual" });
  const now = Date.now();
  // Started 6h ago with no end_time → grace 4h means it's expired.
  await seedEvent(db, { id: "stale", venueId: "v", startTime: new Date(now - 6 * 3600_000) });
  // Started 2h ago, end 10m ago → ended.
  await seedEvent(db, {
    id: "ended-explicit",
    venueId: "v",
    startTime: new Date(now - 2 * 3600_000),
    endTime: new Date(now - 600_000),
  });
  // Started 2h ago, no end → still within grace.
  await seedEvent(db, { id: "ongoing", venueId: "v", startTime: new Date(now - 2 * 3600_000) });

  const items = await listLiveAndUpcomingStreams({}, db as any);
  assert.deepEqual(items.map((i) => i.id), ["ongoing"]);
  assert.equal(items[0]!.isLive, true);
});

test("respects explicit end_time for ongoing detection", async () => {
  const db = createTestDb();
  await seedVenue(db, { id: "v", kind: "virtual" });
  const now = Date.now();
  await seedEvent(db, {
    id: "long-running",
    venueId: "v",
    startTime: new Date(now - 1000_000),
    endTime: new Date(now + 5 * 3600_000),
  });

  const items = await listLiveAndUpcomingStreams({}, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.isLive, true);
});

test("detects platform from venue URL", async () => {
  const db = createTestDb();
  await seedVenue(db, { id: "v-yt", kind: "virtual", url: "https://www.youtube.com/@x" });
  await seedVenue(db, { id: "v-tw", kind: "virtual", url: "https://twitch.tv/y" });
  await seedVenue(db, { id: "v-none", kind: "virtual", url: null });
  const now = Date.now();
  await seedEvent(db, { id: "y", venueId: "v-yt", startTime: new Date(now + 1000_000) });
  await seedEvent(db, { id: "t", venueId: "v-tw", startTime: new Date(now + 2000_000) });
  await seedEvent(db, { id: "n", venueId: "v-none", startTime: new Date(now + 3000_000) });

  const items = await listLiveAndUpcomingStreams({}, db as any);
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("y")!.platform, "youtube");
  assert.equal(byId.get("t")!.platform, "twitch");
  assert.equal(byId.get("n")!.platform, "other");
});

test("filters by artistId when provided", async () => {
  const db = createTestDb();
  await db.insert(schema.artists).values([
    {
      id: "a1", handle: "h1", name: "A", categories: [], groups: [], enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: "a2", handle: "h2", name: "B", categories: [], groups: [], enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
  ]);
  await seedVenue(db, { id: "v", kind: "virtual" });
  const now = Date.now();
  await db.insert(schema.normalizedEvents).values([
    {
      id: "e-a1", parentEventId: null, artistId: "a1", title: "T",
      description: "", startTime: new Date(now + 1000_000), endTime: null,
      venueId: "v", venueName: null, venueUrl: null,
      type: "live_stream", isCancelled: false, tags: [],
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: "e-a2", parentEventId: null, artistId: "a2", title: "T",
      description: "", startTime: new Date(now + 2000_000), endTime: null,
      venueId: "v", venueName: null, venueUrl: null,
      type: "live_stream", isCancelled: false, tags: [],
      createdAt: new Date(), updatedAt: new Date(),
    },
  ]);

  const items = await listLiveAndUpcomingStreams({ artistId: "a1" }, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "e-a1");
});
