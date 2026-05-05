/**
 * ExportRunner tests: cursor advancement, partial-success, retry-on-throw,
 * compaction across multiple updates for the same event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { ExportQueueRepo } from "../ExportQueueRepo";
import { ExportCursorsRepo } from "../ExportCursorsRepo";
import { ExportRunner } from "../ExportRunner";
import { NoopConsumer, type Consumer } from "../Consumer";
import type { DeliveryResult, ExportRecord } from "../types";

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
      url TEXT,
      address TEXT, city TEXT, region TEXT, country TEXT,
      latitude REAL, longitude REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY,
      watch_target_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE,
      raw_data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      error_message TEXT,
      error_class TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY,
      raw_item_id TEXT NOT NULL UNIQUE,
      artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL,
      event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      publish_time INTEGER NOT NULL,
      author TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_event_sources (
      id TEXT PRIMARY KEY,
      normalized_event_id TEXT NOT NULL,
      extracted_event_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(normalized_event_id, extracted_event_id)
    );
    CREATE TABLE export_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_event_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL
    );
    CREATE TABLE export_cursors (
      consumer_name TEXT PRIMARY KEY,
      cursor_position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

const NOW = new Date("2026-05-01T00:00:00Z");

type TestDb = ReturnType<typeof createTestDb>;

function insertNormalizedEvent(db: TestDb, opts: { id?: string; title?: string; isCancelled?: boolean } = {}): string {
  const id = opts.id ?? randomUUID();
  // need a raw_item + extracted_event for the source-provenance join
  const rawId = randomUUID();
  db.insert(schema.rawItems).values({
    id: rawId, watchTargetId: "wt", sourceName: "twitter", sourceId: randomUUID(),
    rawData: {}, fetchedAt: NOW, status: "processed",
  }).run();
  const exId = randomUUID();
  db.insert(schema.extractedEvents).values({
    id: exId, rawItemId: rawId, artistId: null,
    title: opts.title ?? "Title", description: "Desc",
    startTime: NOW, endTime: null, venueId: null, venueName: null, venueUrl: null,
    type: "concert", eventScope: "main", parentEventHint: null,
    isCancelled: opts.isCancelled ?? false, tags: [],
    publishTime: NOW, author: "a", sourceUrl: "https://src/" + exId, rawContent: "raw",
    createdAt: NOW, updatedAt: NOW,
  }).run();
  db.insert(schema.normalizedEvents).values({
    id, parentEventId: null, artistId: null,
    title: opts.title ?? "Title", description: "Desc",
    startTime: NOW, endTime: null, venueId: null, venueName: null, venueUrl: null,
    type: "concert", isCancelled: opts.isCancelled ?? false, tags: [],
    createdAt: NOW, updatedAt: NOW,
  }).run();
  db.insert(schema.normalizedEventSources).values({
    id: randomUUID(), normalizedEventId: id, extractedEventId: exId, role: "primary", createdAt: NOW,
  }).run();
  return id;
}

function enqueue(db: TestDb, normalizedEventId: string, changeType: "created" | "updated" | "cancelled") {
  const repo = new ExportQueueRepo(db as any);
  db.transaction((tx) => {
    repo.enqueueSync(tx as any, normalizedEventId, changeType);
  });
}

function abortNever(): AbortSignal {
  return new AbortController().signal;
}

test("new consumer starts at head and skips history", async () => {
  const db = createTestDb();
  const evA = insertNormalizedEvent(db);
  enqueue(db, evA, "created");

  const consumer = new NoopConsumer("noop");
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  // Cursor should be at head (position 1); a new event after start advances it.
  const result = await runner.tick(abortNever());
  assert.equal(consumer.received.length, 0, "should not replay history");
  assert.deepEqual(
    (result.consumers as Record<string, { delivered: number }>).noop,
    { delivered: 0, rejected: 0, retried: 0, skipped: 0 }
  );

  const evB = insertNormalizedEvent(db);
  enqueue(db, evB, "created");

  await runner.tick(abortNever());
  assert.equal(consumer.received.length, 1);
  assert.equal(consumer.received[0]!.id, evB);
  assert.equal(consumer.received[0]!.changeType, "created");
  assert.equal(consumer.received[0]!.version, 1);
});

test("compaction collapses multiple updates for same event", async () => {
  const db = createTestDb();
  const consumer = new NoopConsumer("noop");
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db);
  enqueue(db, evA, "created");
  enqueue(db, evA, "updated");
  enqueue(db, evA, "cancelled");

  await runner.tick(abortNever());
  assert.equal(consumer.received.length, 1, "should compact to single record");
  assert.equal(consumer.received[0]!.changeType, "cancelled", "should be the latest change");
  assert.equal(consumer.received[0]!.version, 3, "should be the latest version");
});

test("throwing from deliver retains cursor for retry next tick", async () => {
  const db = createTestDb();
  let throwOnce = true;
  const consumer: Consumer = {
    name: "flaky",
    async deliver(batch): Promise<DeliveryResult> {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("boom");
      }
      return { delivered: batch.map((r) => r.id) };
    },
  };
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db);
  enqueue(db, evA, "created");

  const r1 = await runner.tick(abortNever());
  const summary1 = (r1.consumers as Record<string, { retried: number; errorClass?: string }>).flaky;
  assert.equal(summary1.retried, 1);
  assert.equal(summary1.errorClass, "Error");

  // Cursor should not have advanced; next tick re-delivers.
  const r2 = await runner.tick(abortNever());
  const summary2 = (r2.consumers as Record<string, { delivered: number }>).flaky;
  assert.equal(summary2.delivered, 1);

  // Third tick: nothing new.
  const r3 = await runner.tick(abortNever());
  const summary3 = (r3.consumers as Record<string, { delivered: number }>).flaky;
  assert.equal(summary3.delivered, 0);
});

test("partial success: rejected ids are dropped, retry ids hold the cursor", async () => {
  const db = createTestDb();
  let attempts = 0;
  const consumer: Consumer = {
    name: "partial",
    async deliver(batch): Promise<DeliveryResult> {
      attempts++;
      if (attempts === 1) {
        // First call: deliver first, reject second, retry rest.
        return {
          delivered: batch[0] ? [batch[0].id] : [],
          rejected: batch[1] ? [{ id: batch[1].id, reason: "schema" }] : [],
        };
      }
      return { delivered: batch.map((r) => r.id) };
    },
  };
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db);
  const evB = insertNormalizedEvent(db);
  const evC = insertNormalizedEvent(db);
  enqueue(db, evA, "created");
  enqueue(db, evB, "created");
  enqueue(db, evC, "created");

  const r1 = await runner.tick(abortNever());
  const s1 = (r1.consumers as Record<string, { delivered: number; rejected: number; retried: number }>).partial;
  assert.equal(s1.delivered, 1);
  assert.equal(s1.rejected, 1);
  assert.equal(s1.retried, 1);

  // Second tick: evC delivers, cursor catches up.
  const r2 = await runner.tick(abortNever());
  const s2 = (r2.consumers as Record<string, { delivered: number }>).partial;
  assert.equal(s2.delivered, 1);
});

test("one consumer's failure does not block another's progress", async () => {
  const db = createTestDb();
  const flaky: Consumer = {
    name: "flaky",
    async deliver(): Promise<DeliveryResult> {
      throw new Error("nope");
    },
  };
  const noop = new NoopConsumer("noop");
  const runner = new ExportRunner([flaky, noop], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db);
  enqueue(db, evA, "created");

  const result = await runner.tick(abortNever());
  const summaries = result.consumers as Record<string, { delivered: number; retried: number }>;
  assert.equal(summaries.flaky!.retried, 1);
  assert.equal(summaries.noop!.delivered, 1);
});

test("ExportRecord projection includes provenance and stable shape", async () => {
  const db = createTestDb();
  const consumer = new NoopConsumer("noop");
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db, { title: "My Concert" });
  enqueue(db, evA, "created");

  await runner.tick(abortNever());
  assert.equal(consumer.received.length, 1);
  const record: ExportRecord = consumer.received[0]!;
  assert.equal(record.title, "My Concert");
  assert.equal(record.changeType, "created");
  assert.equal(record.parentId, null);
  assert.equal(record.sources.length, 1);
  assert.match(record.sources[0]!.sourceUrl, /^https:\/\/src\//);
  assert.ok(typeof record.startTime === "string", "startTime is ISO-8601");
  assert.ok(typeof record.emittedAt === "string");
});

test("orphaned queue entries (event deleted) advance the cursor without delivery", async () => {
  const db = createTestDb();
  const consumer = new NoopConsumer("noop");
  const runner = new ExportRunner([consumer], { db: db as any });
  await runner.start();

  const evA = insertNormalizedEvent(db);
  enqueue(db, evA, "created");
  // Simulate cascade-style deletion of the event but leave the queue row.
  // (In production CASCADE removes the queue row too; this guards the
  // defensive path against schema drift.)
  db.delete(schema.normalizedEventSources).run();
  db.delete(schema.normalizedEvents).run();

  const result = await runner.tick(abortNever());
  const summary = (result.consumers as Record<string, { skipped: number; delivered: number }>).noop;
  assert.equal(summary.skipped, 1);
  assert.equal(summary.delivered, 0);

  // Cursor advanced; a new event delivers cleanly.
  const evB = insertNormalizedEvent(db);
  enqueue(db, evB, "created");
  await runner.tick(abortNever());
  assert.equal(consumer.received.length, 1);
  assert.equal(consumer.received[0]!.id, evB);
});
