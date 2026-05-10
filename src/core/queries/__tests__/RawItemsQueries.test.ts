import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listRecentRawItems } from "../RawItemsQueries";

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
      source_id TEXT NOT NULL UNIQUE, source_url TEXT, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedArtist(db: Db, args: { id: string; handle: string; name: string }) {
  await db.insert(schema.artists).values({
    id: args.id, handle: args.handle, name: args.name,
    categories: [], groups: [], enabled: true,
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

async function seedRawItem(db: Db, args: {
  id: string; watchTargetId: string; fetchedAt: Date; text?: string;
  rawData?: Record<string, unknown>;
  postedAt?: Date | null;
}) {
  await db.insert(schema.rawItems).values({
    id: args.id,
    watchTargetId: args.watchTargetId,
    sourceName: "twitter",
    sourceId: args.id,
    rawData: args.rawData ?? { text: args.text ?? `tweet ${args.id}` },
    postedAt: args.postedAt ?? null,
    fetchedAt: args.fetchedAt,
    status: "processed",
    errorMessage: null, errorClass: null,
  });
}

test("returns empty list when no items exist", async () => {
  const db = createTestDb();
  const items = await listRecentRawItems({}, db as any);
  assert.deepEqual(items, []);
});

test("returns recent raw items joined with artist info, newest first", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "Hoshino Aoi" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  await seedRawItem(db, { id: "r1", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-01") });
  await seedRawItem(db, { id: "r2", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-03") });
  await seedRawItem(db, { id: "r3", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-02") });

  const items = await listRecentRawItems({}, db as any);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.id, "r2");
  assert.equal(items[1]!.id, "r3");
  assert.equal(items[2]!.id, "r1");
  assert.equal(items[0]!.artistName, "Hoshino Aoi");
  assert.equal(items[0]!.artistHandle, "h1");
  assert.deepEqual(items[0]!.rawData, { text: "tweet r2" });
});

test("filters by artistId", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "A1" });
  await seedArtist(db, { id: "a2", handle: "h2", name: "A2" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  await seedWatchTarget(db, { id: "wt-2", artistId: "a2" });
  await seedRawItem(db, { id: "r1", watchTargetId: "wt-1", fetchedAt: new Date("2026-05-01") });
  await seedRawItem(db, { id: "r2", watchTargetId: "wt-2", fetchedAt: new Date("2026-05-02") });

  const items = await listRecentRawItems({ artistId: "a1" }, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "r1");
});

test("postedAt is returned from the raw_items column", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h", name: "A" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  const posted = new Date("2026-05-03T18:30:00Z");
  await seedRawItem(db, {
    id: "r-with-time",
    watchTargetId: "wt-1",
    fetchedAt: new Date("2026-05-04T08:00:00Z"),
    postedAt: posted,
  });
  await seedRawItem(db, {
    id: "r-without-time",
    watchTargetId: "wt-1",
    fetchedAt: new Date("2026-05-04T08:00:00Z"),
    postedAt: null,
  });

  const items = await listRecentRawItems({}, db as any);
  const withTime = items.find((i) => i.id === "r-with-time")!;
  const withoutTime = items.find((i) => i.id === "r-without-time")!;
  assert.equal(withTime.postedAt?.toISOString(), posted.toISOString());
  assert.equal(withoutTime.postedAt, null);
});

test("cursor returns items strictly older than the cursor", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h1", name: "A" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  const t1 = new Date("2026-05-01");
  const t2 = new Date("2026-05-02");
  const t3 = new Date("2026-05-03");
  await seedRawItem(db, { id: "r1", watchTargetId: "wt-1", fetchedAt: t1 });
  await seedRawItem(db, { id: "r2", watchTargetId: "wt-1", fetchedAt: t2 });
  await seedRawItem(db, { id: "r3", watchTargetId: "wt-1", fetchedAt: t3 });

  const items = await listRecentRawItems({ cursor: t3 }, db as any);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "r2");
  assert.equal(items[1]!.id, "r1");
});

test("limit caps the result count", async () => {
  const db = createTestDb();
  await seedArtist(db, { id: "a1", handle: "h", name: "A" });
  await seedWatchTarget(db, { id: "wt-1", artistId: "a1" });
  for (let i = 0; i < 5; i++) {
    await seedRawItem(db, {
      id: `r${i}`,
      watchTargetId: "wt-1",
      fetchedAt: new Date(2026, 4, i + 1),
    });
  }
  const items = await listRecentRawItems({ limit: 2 }, db as any);
  assert.equal(items.length, 2);
});
