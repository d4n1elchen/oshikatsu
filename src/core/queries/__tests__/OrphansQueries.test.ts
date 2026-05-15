/**
 * Fixture tests for OrphansQueries. Uses an in-memory SQLite database
 * matching the raw_items / watch_targets / artists shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { listOrphans, requeueOrphan } from "../OrphansQueries";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      categories TEXT NOT NULL,
      groups TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE watch_targets (
      id TEXT PRIMARY KEY,
      artist_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY,
      watch_target_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE,
      source_url TEXT,
      raw_data TEXT NOT NULL,
      posted_at INTEGER,
      fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      error_message TEXT,
      error_class TEXT,
      not_an_event_category TEXT
    );
  `);
  return db;
}

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-05-14T12:00:00Z");

function seed(db: TestDb) {
  db.insert(schema.artists).values({
    id: "artist-1",
    handle: "test_artist",
    name: "Test Artist",
    categories: [],
    groups: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.watchTargets).values({
    id: "wt-1",
    artistId: "artist-1",
    platform: "twitter",
    sourceType: "user_timeline",
    sourceConfig: { handle: "test_artist" },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  } as any).run();
}

function insertRaw(
  db: TestDb,
  opts: {
    status?: "new" | "processed" | "error" | "not_an_event";
    category?: "mood" | "fan_engagement" | "other" | null;
    reason?: string | null;
    text?: string;
    fetchedAt?: Date;
  } = {}
) {
  const id = randomUUID();
  db.insert(schema.rawItems).values({
    id,
    watchTargetId: "wt-1",
    sourceName: "twitter",
    sourceId: randomUUID(),
    sourceUrl: `https://example.com/${id}`,
    rawData: { text: opts.text ?? "post text" },
    postedAt: NOW,
    fetchedAt: opts.fetchedAt ?? NOW,
    status: opts.status ?? "not_an_event",
    errorMessage: opts.reason ?? null,
    errorClass: null,
    notAnEventCategory: opts.category ?? null,
  } as any).run();
  return id;
}

test("listOrphans returns rows grouped by category", async () => {
  const db = createTestDb();
  seed(db);
  insertRaw(db, { category: "mood", reason: "greeting" });
  insertRaw(db, { category: "mood", reason: "weather" });
  insertRaw(db, { category: "fan_engagement", reason: "shoutout" });
  insertRaw(db, { category: "other", reason: "unsorted" });
  // Should not appear:
  insertRaw(db, { status: "processed" });
  insertRaw(db, { status: "error", reason: "boom" });

  const summary = await listOrphans({}, db as any);
  assert.equal(summary.total, 4);
  assert.equal(summary.items.length, 4);

  const counts = new Map(summary.byCategory.map((c) => [c.category, c.count]));
  assert.equal(counts.get("mood"), 2);
  assert.equal(counts.get("fan_engagement"), 1);
  assert.equal(counts.get("other"), 1);
});

test("listOrphans filters by category", async () => {
  const db = createTestDb();
  seed(db);
  insertRaw(db, { category: "mood" });
  insertRaw(db, { category: "fan_engagement" });
  insertRaw(db, { category: "other" });

  const result = await listOrphans({ category: "mood" }, db as any);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.category, "mood");
});

test("listOrphans surfaces legacy rows with null category as 'uncategorized'", async () => {
  const db = createTestDb();
  seed(db);
  insertRaw(db, { category: null, reason: "old row" });

  const summary = await listOrphans({}, db as any);
  assert.equal(summary.total, 1);
  const uncategorized = summary.byCategory.find((c) => c.category === "uncategorized");
  assert.ok(uncategorized, "should have uncategorized bucket");
  assert.equal(uncategorized!.count, 1);
});

test("listOrphans joins artist info when watch target resolves", async () => {
  const db = createTestDb();
  seed(db);
  insertRaw(db, { category: "mood" });

  const summary = await listOrphans({}, db as any);
  assert.equal(summary.items[0]!.artistName, "Test Artist");
  assert.equal(summary.items[0]!.artistHandle, "test_artist");
});

test("requeueOrphan flips status to 'new' and clears category/reason", async () => {
  const db = createTestDb();
  seed(db);
  const id = insertRaw(db, { category: "mood", reason: "misclassified" });

  await requeueOrphan(id, db as any);

  const rows = db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id)).all();
  assert.equal(rows[0]!.status, "new");
  assert.equal(rows[0]!.notAnEventCategory, null);
  assert.equal(rows[0]!.errorMessage, null);
});

test("requeueOrphan does not affect rows in other statuses", async () => {
  const db = createTestDb();
  seed(db);
  const id = insertRaw(db, { status: "processed" });

  await requeueOrphan(id, db as any);
  const rows = db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id)).all();
  assert.equal(rows[0]!.status, "processed");
});
