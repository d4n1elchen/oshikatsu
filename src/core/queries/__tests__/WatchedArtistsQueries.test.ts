import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listWatchedArtists } from "../WatchedArtistsQueries";

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
    CREATE TABLE watch_targets (
      id TEXT PRIMARY KEY, artist_id TEXT NOT NULL,
      platform TEXT NOT NULL, source_type TEXT NOT NULL,
      source_config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY, watch_target_id TEXT NOT NULL, source_name TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedArtist(db: Db, args: { id: string; handle: string; name: string; enabled?: boolean }) {
  await db.insert(schema.artists).values({
    id: args.id, handle: args.handle, name: args.name,
    categories: [], groups: [], enabled: args.enabled ?? true,
    createdAt: new Date(), updatedAt: new Date(),
  });
}

async function seedWatchTarget(db: Db, args: { id: string; artistId: string }) {
  await db.insert(schema.watchTargets).values({
    id: args.id, artistId: args.artistId, platform: "twitter", sourceType: "account",
    sourceConfig: {}, enabled: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
}

async function seedRawItem(db: Db, args: { id: string; watchTargetId: string; fetchedAt: Date }) {
  await db.insert(schema.rawItems).values({
    id: args.id, watchTargetId: args.watchTargetId, sourceName: "twitter",
    sourceId: args.id, rawData: {}, fetchedAt: args.fetchedAt,
    status: "processed", errorMessage: null, errorClass: null,
  });
}

test("returns empty list when no artists exist", async () => {
  const db = createTestDb();
  const items = await listWatchedArtists(db as any);
  assert.deepEqual(items, []);
});

test("returns each enabled artist with their latest fetched_at", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "Hoshino" });
  await seedArtist(db, { id: "a2", handle: "h2", name: "Tsukimi" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  await seedWatchTarget(db, { id: "wt-2", artistId: "a2" });
  await seedRawItem(db, { id: "r1", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-01") });
  await seedRawItem(db, { id: "r2", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-03") });
  await seedRawItem(db, { id: "r3", watchTargetId: "wt-2", fetchedAt: new Date("2026-05-02") });

  const items = await listWatchedArtists(db as any);
  // Sorted by recency desc — a1's latest (May 3) comes before a2's latest (May 2)
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "a1");
  assert.equal(items[0]!.lastActivityAt?.toISOString(), new Date("2026-05-03").toISOString());
  assert.equal(items[1]!.id, "a2");
  assert.equal(items[1]!.lastActivityAt?.toISOString(), new Date("2026-05-02").toISOString());
});

test("artist with no raw items has lastActivityAt = null", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "Quiet" });

  const items = await listWatchedArtists(db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.lastActivityAt, null);
});

test("disabled artists are excluded", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "On", enabled: true });
  await seedArtist(db, { id: "a2", handle: "h2", name: "Off", enabled: false });

  const items = await listWatchedArtists(db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "a1");
});
