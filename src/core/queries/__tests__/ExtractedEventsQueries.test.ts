import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listExtractedEvents } from "../ExtractedEventsQueries";

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
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY, watch_target_id TEXT NOT NULL, source_name TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE, source_url TEXT, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY, raw_item_id TEXT NOT NULL UNIQUE, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, record_kind TEXT NOT NULL DEFAULT 'event', event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL, publish_time INTEGER NOT NULL,
      author TEXT NOT NULL, source_url TEXT NOT NULL, raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE extracted_event_related_links (
      id TEXT PRIMARY KEY, extracted_event_id TEXT NOT NULL,
      raw_item_id TEXT, url TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedRawItem(db: Db, id: string, sourceName: string = "twitter") {
  await db.insert(schema.rawItems).values({
    id, watchTargetId: "wt-1", sourceName, sourceId: id, rawData: {},
    fetchedAt: new Date(), status: "processed",
    errorMessage: null, errorClass: null,
  });
}

async function seedExtracted(db: Db, args: {
  id: string;
  startTime?: Date;
  artistId?: string | null;
  venueId?: string | null;
}) {
  await seedRawItem(db, `raw-${args.id}`);
  await db.insert(schema.extractedEvents).values({
    id: args.id,
    rawItemId: `raw-${args.id}`,
    artistId: args.artistId ?? null,
    title: `Event ${args.id}`,
    description: "desc",
    startTime: args.startTime ?? new Date("2026-06-01T10:00:00Z"),
    endTime: null,
    venueId: args.venueId ?? null,
    venueName: null, venueUrl: null,
    type: "concert", eventScope: "unknown", parentEventHint: null,
    isCancelled: false, tags: ["a", "b"],
    publishTime: new Date("2026-05-30T10:00:00Z"),
    author: "test", sourceUrl: "https://x.test/p", rawContent: "raw",
    createdAt: new Date(), updatedAt: new Date(),
  });
}

test("returns empty list when no extracted events exist", async () => {
  const db = createTestDb();
  const items = await listExtractedEvents({}, db as any);
  assert.deepEqual(items, []);
});

test("joins artist, venue, source name and related links in a single payload", async () => {
  const db = createTestDb();
  await db.insert(schema.artists).values({
    id: "art-1", handle: "h", name: "Hoshino Aoi",
    categories: [], groups: [], enabled: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.venues).values({
    id: "ven-1", name: "Zepp DiverCity", kind: "physical", status: "verified",
    url: null, address: null, city: null, region: null, country: null,
    latitude: null, longitude: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await seedExtracted(db, { id: "e1", artistId: "art-1", venueId: "ven-1" });
  await db.insert(schema.extractedEventRelatedLinks).values([
    { id: "l1", extractedEventId: "e1", rawItemId: null, url: "https://example.com/a", title: "Ticket", createdAt: new Date() },
    { id: "l2", extractedEventId: "e1", rawItemId: null, url: "https://example.com/b", title: null, createdAt: new Date() },
  ]);

  const items = await listExtractedEvents({}, db as any);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.artistName, "Hoshino Aoi");
  assert.equal(item.venue?.name, "Zepp DiverCity");
  assert.equal(item.venue?.kind, "physical");
  assert.equal(item.sourceName, "twitter");
  assert.equal(item.links.length, 2);
  assert.deepEqual(item.tags, ["a", "b"]);
});

test("orders by start_time desc and respects limit", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1", startTime: new Date("2026-06-01") });
  await seedExtracted(db, { id: "e2", startTime: new Date("2026-06-03") });
  await seedExtracted(db, { id: "e3", startTime: new Date("2026-06-02") });

  const items = await listExtractedEvents({ limit: 2 }, db as any);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.id, "e2");
  assert.equal(items[1]!.id, "e3");
});

test("missing artist/venue/links surface as null/empty without error", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1", artistId: null, venueId: null });

  const items = await listExtractedEvents({}, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.artistName, null);
  assert.equal(items[0]!.venue, null);
  assert.deepEqual(items[0]!.links, []);
});
