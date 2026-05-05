/**
 * Verify EventResolver enqueues export_queue rows when an ExportQueueRepo
 * is supplied — and does not when it isn't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { EventResolver } from "../EventResolver";
import { ExportQueueRepo } from "../ExportQueueRepo";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      categories TEXT NOT NULL,
      groups TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE venues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'discovered',
      url TEXT, address TEXT, city TEXT, region TEXT, country TEXT,
      latitude REAL, longitude REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY, watch_target_id TEXT NOT NULL,
      source_name TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
      raw_data TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY, raw_item_id TEXT NOT NULL UNIQUE, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      publish_time INTEGER NOT NULL, author TEXT NOT NULL,
      source_url TEXT NOT NULL, raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE extracted_event_related_links (
      id TEXT PRIMARY KEY, extracted_event_id TEXT NOT NULL,
      raw_item_id TEXT, url TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(extracted_event_id, url)
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_event_sources (
      id TEXT PRIMARY KEY, normalized_event_id TEXT NOT NULL,
      extracted_event_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(normalized_event_id, extracted_event_id)
    );
    CREATE TABLE event_resolution_decisions (
      id TEXT PRIMARY KEY,
      candidate_extracted_event_id TEXT NOT NULL,
      matched_normalized_event_id TEXT, decision TEXT NOT NULL,
      score REAL, signals TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE export_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_event_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL
    );
  `);
  return db;
}

const NOW = new Date("2026-05-01T00:00:00Z");
type TestDb = ReturnType<typeof createTestDb>;

function insertArtist(db: TestDb, id = "artist-1") {
  db.insert(schema.artists).values({
    id, name: "Test", categories: [], groups: [],
    enabled: true, createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

function insertExtractedEvent(db: TestDb, opts: { sourceUrl?: string; isCancelled?: boolean; artistId?: string } = {}) {
  const rawId = randomUUID();
  db.insert(schema.rawItems).values({
    id: rawId, watchTargetId: "wt", sourceName: "twitter", sourceId: randomUUID(),
    rawData: {}, fetchedAt: NOW, status: "processed",
  }).run();
  const id = randomUUID();
  db.insert(schema.extractedEvents).values({
    id, rawItemId: rawId, artistId: opts.artistId ?? "artist-1",
    title: "T", description: "D",
    startTime: NOW, endTime: null,
    venueId: null, venueName: null, venueUrl: null,
    type: "concert", eventScope: "main", parentEventHint: null,
    isCancelled: opts.isCancelled ?? false, tags: [],
    publishTime: NOW, author: "a",
    sourceUrl: opts.sourceUrl ?? "https://src/" + id, rawContent: "raw",
    createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

test("resolver with ExportQueueRepo enqueues 'created' for new normalized event", async () => {
  const db = createTestDb();
  insertArtist(db);
  const evId = insertExtractedEvent(db);

  const resolver = new EventResolver(db as any, undefined, new ExportQueueRepo(db as any));
  await resolver.resolve(evId);

  const queue = db.select().from(schema.exportQueue).all();
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.changeType, "created");
  assert.equal(queue[0]!.version, 1);
});

test("resolver without ExportQueueRepo enqueues nothing", async () => {
  const db = createTestDb();
  insertArtist(db);
  const evId = insertExtractedEvent(db);

  const resolver = new EventResolver(db as any);
  await resolver.resolve(evId);

  const queue = db.select().from(schema.exportQueue).all();
  assert.equal(queue.length, 0);
});

test("merge with cancellation flip enqueues 'cancelled' and bumps version", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedUrl = "https://example.com/tweet/1";

  const resolver = new EventResolver(db as any, undefined, new ExportQueueRepo(db as any));

  const first = insertExtractedEvent(db, { sourceUrl: sharedUrl, isCancelled: false });
  await resolver.resolve(first);

  const second = insertExtractedEvent(db, { sourceUrl: sharedUrl, isCancelled: true });
  await resolver.resolve(second);

  const queue = db.select().from(schema.exportQueue).all().sort((a, b) => a.position - b.position);
  assert.equal(queue.length, 2, "created + cancelled");
  assert.equal(queue[0]!.changeType, "created");
  assert.equal(queue[0]!.version, 1);
  assert.equal(queue[1]!.changeType, "cancelled");
  assert.equal(queue[1]!.version, 2);
  assert.equal(queue[0]!.normalizedEventId, queue[1]!.normalizedEventId);
});

test("merge without cancellation flip does not enqueue", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedUrl = "https://example.com/tweet/2";

  const resolver = new EventResolver(db as any, undefined, new ExportQueueRepo(db as any));

  const first = insertExtractedEvent(db, { sourceUrl: sharedUrl, isCancelled: false });
  await resolver.resolve(first);

  const second = insertExtractedEvent(db, { sourceUrl: sharedUrl, isCancelled: false });
  await resolver.resolve(second);

  const queue = db.select().from(schema.exportQueue).all();
  assert.equal(queue.length, 1, "only the initial 'created'");
  assert.equal(queue[0]!.changeType, "created");
});
