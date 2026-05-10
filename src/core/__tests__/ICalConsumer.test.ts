/**
 * ICalConsumer integration: per-artist file rebuild keyed by artists.handle,
 * sub-event prefix, cancellation, atomic write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { ICalConsumer } from "../consumers/ICalConsumer";
import type { ExportRecord } from "../types";

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
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      operator_owned INTEGER NOT NULL DEFAULT 0, operator_edited_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

const NOW = new Date("2026-05-04T12:00:00Z");
type TestDb = ReturnType<typeof createTestDb>;

function insertArtist(db: TestDb, id: string, handle: string, name: string) {
  db.insert(schema.artists).values({
    id, handle, name, categories: [], groups: [],
    enabled: true, createdAt: NOW, updatedAt: NOW,
  }).run();
}

function insertEvent(db: TestDb, opts: {
  id?: string;
  artistId: string | null;
  title: string;
  parentEventId?: string;
  isCancelled?: boolean;
  startTime?: Date;
  venueName?: string;
}): string {
  const id = opts.id ?? randomUUID();
  db.insert(schema.normalizedEvents).values({
    id,
    parentEventId: opts.parentEventId ?? null,
    artistId: opts.artistId,
    title: opts.title, description: "Desc",
    startTime: opts.startTime ?? new Date("2026-06-15T18:00:00Z"),
    endTime: null,
    venueId: null, venueName: opts.venueName ?? null, venueUrl: null,
    type: "concert", isCancelled: opts.isCancelled ?? false, tags: [],
    createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

function makeRecord(id: string, artistId: string | null, artistName: string | null = null, changeType: "created" | "updated" | "cancelled" = "created"): ExportRecord {
  return {
    id, version: 1, changeType,
    parentId: null,
    artist: artistId && artistName ? { id: artistId, name: artistName } : null,
    title: "stub",
    description: "stub",
    startTime: null, endTime: null,
    venue: { id: null, name: null, url: null },
    type: "concert", isCancelled: changeType === "cancelled", tags: [],
    sources: [],
    emittedAt: NOW.toISOString(),
  };
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ical-test-"));
}

test("writes <handle>.ics for each affected artist", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "arashi", "嵐");
  insertArtist(db, "artist-b", "nogizaka46", "乃木坂46");
  const evA = insertEvent(db, { artistId: "artist-a", title: "A's show" });
  const evB = insertEvent(db, { artistId: "artist-b", title: "B's show" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();

  const result = await consumer.deliver([
    makeRecord(evA, "artist-a", "嵐"),
    makeRecord(evB, "artist-b", "乃木坂46"),
  ]);

  assert.deepEqual(result.delivered.sort(), [evA, evB].sort());
  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ["arashi.ics", "nogizaka46.ics"]);

  const aBody = await fs.readFile(path.join(dir, "arashi.ics"), "utf8");
  assert.match(aBody, /SUMMARY:A's show/);
  assert.match(aBody, /X-WR-CALNAME:Oshikatsu — 嵐/);
  assert.doesNotMatch(aBody, /B's show/);
});

test("a single record rewrites the artist's full event set", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "arashi", "嵐");
  const evA1 = insertEvent(db, { artistId: "artist-a", title: "Show 1" });
  insertEvent(db, { artistId: "artist-a", title: "Show 2" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();

  // Even though the batch only mentions evA1, the .ics contains both events.
  await consumer.deliver([makeRecord(evA1, "artist-a", "嵐")]);

  const body = await fs.readFile(path.join(dir, "arashi.ics"), "utf8");
  assert.match(body, /SUMMARY:Show 1/);
  assert.match(body, /SUMMARY:Show 2/);
  assert.equal(body.match(/BEGIN:VEVENT/g)!.length, 2);
});

test("sub-events get [Parent] prefix in SUMMARY", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "arashi", "嵐");
  const main = insertEvent(db, { artistId: "artist-a", title: "Tokyo Dome Concert" });
  insertEvent(db, { artistId: "artist-a", title: "Pre-show meet & greet", parentEventId: main });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(main, "artist-a", "嵐")]);

  const body = await fs.readFile(path.join(dir, "arashi.ics"), "utf8");
  assert.match(body, /SUMMARY:Tokyo Dome Concert/);
  assert.match(body, /SUMMARY:\[Tokyo Dome Concert\] Pre-show meet & greet/);
});

test("cancelled events emit STATUS:CANCELLED", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "arashi", "嵐");
  const evA = insertEvent(db, { artistId: "artist-a", title: "Cancelled Show", isCancelled: true });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(evA, "artist-a", "嵐", "cancelled")]);

  const body = await fs.readFile(path.join(dir, "arashi.ics"), "utf8");
  assert.match(body, /STATUS:CANCELLED/);
  assert.doesNotMatch(body, /STATUS:CONFIRMED/);
});

test("records without an artist are reported delivered but write nothing", async () => {
  const db = createTestDb();
  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();

  const result = await consumer.deliver([makeRecord("orphan-1", null)]);
  assert.deepEqual(result.delivered, ["orphan-1"]);
  const files = await fs.readdir(dir);
  assert.equal(files.length, 0);
});
