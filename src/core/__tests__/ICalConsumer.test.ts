/**
 * ICalConsumer integration: per-artist file rebuild, sub-event prefix,
 * cancellation, atomic write.
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
import { ICalConsumer, slugifyArtistName } from "../consumers/ICalConsumer";
import type { ExportRecord } from "../types";

test("slugifyArtistName replaces whitespace runs with hyphen", () => {
  assert.equal(slugifyArtistName("Artist A"), "Artist-A");
  assert.equal(slugifyArtistName("  trim  me  "), "trim-me");
  assert.equal(slugifyArtistName("multi\t\twhite space"), "multi-white-space");
});

test("slugifyArtistName replaces filesystem-unsafe chars with underscore", () => {
  assert.equal(slugifyArtistName("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
});

test("slugifyArtistName preserves unicode", () => {
  assert.equal(slugifyArtistName("嵐"), "嵐");
  assert.equal(slugifyArtistName("乃木坂46"), "乃木坂46");
});

test("slugifyArtistName trims leading/trailing dots, hyphens, underscores", () => {
  assert.equal(slugifyArtistName("...foo..."), "foo");
  assert.equal(slugifyArtistName("--bar--"), "bar");
  assert.equal(slugifyArtistName("__baz__"), "baz");
});

test("slugifyArtistName returns empty string when nothing usable remains", () => {
  assert.equal(slugifyArtistName("..."), "");
  assert.equal(slugifyArtistName("   "), "");
  assert.equal(slugifyArtistName(""), "");
});

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
  `);
  return db;
}

const NOW = new Date("2026-05-04T12:00:00Z");
type TestDb = ReturnType<typeof createTestDb>;

function insertArtist(db: TestDb, id: string, name: string) {
  db.insert(schema.artists).values({
    id, name, categories: [], groups: [],
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

test("writes one .ics per affected artist with slugified names", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "Artist A");
  insertArtist(db, "artist-b", "Artist B");
  const evA = insertEvent(db, { artistId: "artist-a", title: "A's show" });
  const evB = insertEvent(db, { artistId: "artist-b", title: "B's show" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();

  const result = await consumer.deliver([
    makeRecord(evA, "artist-a", "Artist A"),
    makeRecord(evB, "artist-b", "Artist B"),
  ]);

  assert.deepEqual(result.delivered.sort(), [evA, evB].sort());
  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ["Artist-A.ics", "Artist-B.ics"]);

  const aBody = await fs.readFile(path.join(dir, "Artist-A.ics"), "utf8");
  assert.match(aBody, /SUMMARY:A's show/);
  assert.match(aBody, /X-WR-CALNAME:Oshikatsu — Artist A/);
  assert.doesNotMatch(aBody, /B's show/);
});

test("a single record rewrites the artist's full event set", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "Artist A");
  const evA1 = insertEvent(db, { artistId: "artist-a", title: "Show 1" });
  const evA2 = insertEvent(db, { artistId: "artist-a", title: "Show 2" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();

  // Even though the batch only mentions evA1, the .ics contains both events.
  await consumer.deliver([makeRecord(evA1, "artist-a", "Artist A")]);

  const body = await fs.readFile(path.join(dir, "Artist-A.ics"), "utf8");
  assert.match(body, /SUMMARY:Show 1/);
  assert.match(body, /SUMMARY:Show 2/);
  assert.equal(body.match(/BEGIN:VEVENT/g)!.length, 2);
});

test("sub-events get [Parent] prefix in SUMMARY", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "Artist A");
  const main = insertEvent(db, { artistId: "artist-a", title: "Tokyo Dome Concert" });
  insertEvent(db, { artistId: "artist-a", title: "Pre-show meet & greet", parentEventId: main });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(main, "artist-a", "Artist A")]);

  const body = await fs.readFile(path.join(dir, "Artist-A.ics"), "utf8");
  assert.match(body, /SUMMARY:Tokyo Dome Concert/);
  assert.match(body, /SUMMARY:\[Tokyo Dome Concert\] Pre-show meet & greet/);
});

test("cancelled events emit STATUS:CANCELLED", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-a", "Artist A");
  const evA = insertEvent(db, { artistId: "artist-a", title: "Cancelled Show", isCancelled: true });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(evA, "artist-a", "Artist A", "cancelled")]);

  const body = await fs.readFile(path.join(dir, "Artist-A.ics"), "utf8");
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

test("collisions get a stable -<short-id> suffix; non-colliding artists keep bare slug", async () => {
  const db = createTestDb();
  insertArtist(db, "11111111-aaaa", "Same Name");
  insertArtist(db, "22222222-bbbb", "Same Name");
  insertArtist(db, "33333333-cccc", "Unique");
  const ev1 = insertEvent(db, { artistId: "11111111-aaaa", title: "show 1" });
  const ev2 = insertEvent(db, { artistId: "22222222-bbbb", title: "show 2" });
  const ev3 = insertEvent(db, { artistId: "33333333-cccc", title: "show 3" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([
    makeRecord(ev1, "11111111-aaaa", "Same Name"),
    makeRecord(ev2, "22222222-bbbb", "Same Name"),
    makeRecord(ev3, "33333333-cccc", "Unique"),
  ]);

  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, [
    "Same-Name-11111111.ics",
    "Same-Name-22222222.ics",
    "Unique.ics",
  ]);
});

test("unicode artist names are preserved in filenames", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-jp", "嵐");
  const evA = insertEvent(db, { artistId: "artist-jp", title: "コンサート" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(evA, "artist-jp", "嵐")]);

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["嵐.ics"]);
});

test("filesystem-unsafe characters are replaced with underscores", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-bad", "A/B:C");
  const evA = insertEvent(db, { artistId: "artist-bad", title: "show" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(evA, "artist-bad", "A/B:C")]);

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["A_B_C.ics"]);
});

test("artist with name that slugifies to empty falls back to id-based filename", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-empty", "...");
  const evA = insertEvent(db, { artistId: "artist-empty", title: "show" });

  const dir = await tempDir();
  const consumer = new ICalConsumer({ outputDir: dir, db: db as any });
  await consumer.start();
  await consumer.deliver([makeRecord(evA, "artist-empty", "...")]);

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ["artist-empty.ics"]);
});
