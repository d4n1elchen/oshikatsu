/**
 * Fixture tests for EventResolver's annotation branch (record_kind='annotation').
 * The event branch is covered in EventResolver.test.ts.
 * Uses an in-memory SQLite database mirroring the production schema.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { EventResolver } from "../EventResolver";

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
    CREATE TABLE extracted_event_related_links (
      id TEXT PRIMARY KEY,
      extracted_event_id TEXT NOT NULL,
      raw_item_id TEXT,
      url TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(extracted_event_id, url)
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY,
      raw_item_id TEXT NOT NULL,
      artist_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      venue_id TEXT,
      venue_name TEXT,
      venue_url TEXT,
      type TEXT NOT NULL,
      record_kind TEXT NOT NULL DEFAULT 'event',
      event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT,
      series_name TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      publish_time INTEGER NOT NULL,
      author TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT,
      artist_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      venue_id TEXT,
      venue_name TEXT,
      venue_url TEXT,
      type TEXT NOT NULL,
      series_name TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      operator_owned INTEGER NOT NULL DEFAULT 0,
      operator_edited_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_event_sources (
      id TEXT PRIMARY KEY,
      normalized_event_id TEXT NOT NULL,
      extracted_event_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(normalized_event_id, extracted_event_id)
    );
    CREATE TABLE event_resolution_decisions (
      id TEXT PRIMARY KEY,
      candidate_extracted_event_id TEXT NOT NULL,
      matched_normalized_event_id TEXT,
      decision TEXT NOT NULL,
      score REAL,
      signals TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER,
      superseded_by_id TEXT,
      note TEXT
    );
  `);
  return db;
}

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2026-05-14T12:00:00Z");

function insertArtist(db: TestDb, id = "artist-1") {
  db.insert(schema.artists).values({
    id,
    handle: id,
    name: "Test Artist",
    categories: [],
    groups: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return id;
}

function insertNormalizedEvent(db: TestDb, opts: { artistId?: string; title: string; id?: string; seriesName?: string; startTime?: Date }) {
  const id = opts.id ?? randomUUID();
  db.insert(schema.normalizedEvents).values({
    id,
    parentEventId: null,
    artistId: opts.artistId ?? null,
    title: opts.title,
    description: "",
    startTime: opts.startTime ?? NOW,
    endTime: null,
    venueId: null,
    venueName: null,
    venueUrl: null,
    type: "concert",
    seriesName: opts.seriesName ?? null,
    isCancelled: false,
    tags: [],
    operatorOwned: false,
    operatorEditedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return id;
}

function insertAnnotation(
  db: TestDb,
  opts: { artistId?: string | null; parentHint: string; title?: string; category?: string; id?: string }
) {
  const rawId = randomUUID();
  db.insert(schema.rawItems).values({
    id: rawId,
    watchTargetId: "wt-1",
    sourceName: "twitter",
    sourceId: randomUUID(),
    rawData: {},
    fetchedAt: NOW,
    status: "processed",
  }).run();

  const id = opts.id ?? randomUUID();
  db.insert(schema.extractedEvents).values({
    id,
    rawItemId: rawId,
    artistId: opts.artistId ?? null,
    title: opts.title ?? "Annotation post",
    description: "Annotation description",
    startTime: null,
    endTime: null,
    venueId: null,
    venueName: null,
    venueUrl: null,
    type: opts.category ?? "milestone",
    recordKind: "annotation",
    eventScope: "unknown",
    parentEventHint: opts.parentHint,
    isCancelled: false,
    tags: [],
    publishTime: NOW,
    author: "fan",
    sourceUrl: `https://example.com/${id}`,
    rawContent: "raw",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return id;
}

function getSources(db: TestDb) {
  return db.select().from(schema.normalizedEventSources).all();
}
function getDecisions(db: TestDb) {
  return db.select().from(schema.eventResolutionDecisions).all();
}

test("attaches annotation when hint matches a normalized event title", async () => {
  const db = createTestDb();
  insertArtist(db);
  const normId = insertNormalizedEvent(db, { artistId: "artist-1", title: "Spring Tour 2026" });
  const annId = insertAnnotation(db, { artistId: "artist-1", parentHint: "Spring Tour 2026" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 1);
  assert.equal(result.annotationsNoMatch, 0);
  assert.equal(result.annotationsDeferred, 0);

  const sources = getSources(db);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.role, "annotation");
  assert.equal(sources[0]!.normalizedEventId, normId);
  assert.equal(sources[0]!.extractedEventId, annId);

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision, "annotation_attached");
});

test("records annotation_no_match when candidate set is non-empty but nothing scores above threshold", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Summer Concert Tokyo" });
  const annId = insertAnnotation(db, { artistId: "artist-1", parentHint: "Unrelated Stuff Over Here" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 0);
  assert.equal(result.annotationsNoMatch, 1);

  const sources = getSources(db);
  assert.equal(sources.length, 0);

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision, "annotation_no_match");
  assert.equal(decisions[0]!.candidateExtractedEventId, annId);
});

test("defers annotation when artist has no normalized events yet", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Future Event" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 0);
  assert.equal(result.annotationsNoMatch, 0);
  assert.equal(result.annotationsDeferred, 1);
  assert.equal(getSources(db).length, 0);
  assert.equal(getDecisions(db).length, 0);
});

test("defers when top two candidates are within the ambiguity margin", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Tour 2026 Day 1" });
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Tour 2026 Day 2" });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Tour 2026" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 0);
  assert.equal(result.annotationsDeferred, 1);
  assert.equal(getSources(db).length, 0);
});

test("does not re-process annotations already attached", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Spring Tour 2026" });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Spring Tour 2026" });

  const resolver = new EventResolver(db as any);
  await resolver.processBatch(10);
  const result2 = await resolver.processBatch(10);

  assert.equal(result2.annotationsAttached, 0);
  assert.equal(result2.annotationsDeferred, 0);
  assert.equal(result2.annotationsNoMatch, 0);
  assert.equal(getSources(db).length, 1);
});

test("does not retry annotations with a persisted no_match decision", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Summer Concert" });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Wildly Different Thing" });

  const resolver = new EventResolver(db as any);
  await resolver.processBatch(10);
  // Add another normalized event; the no_match decision should still hold.
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Wildly Different Thing" });
  const result2 = await resolver.processBatch(10);

  assert.equal(result2.annotationsAttached, 0);
  assert.equal(result2.annotationsNoMatch, 0);
  assert.equal(result2.annotationsDeferred, 0);
});

test("only matches against normalized events for the same artist", async () => {
  const db = createTestDb();
  insertArtist(db, "artist-1");
  insertArtist(db, "artist-2");
  // The good candidate exists under a different artist.
  insertNormalizedEvent(db, { artistId: "artist-2", title: "Spring Tour 2026" });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Spring Tour 2026" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  // No same-artist candidate → deferred (candidate set empty for artist-1).
  assert.equal(result.annotationsAttached, 0);
  assert.equal(result.annotationsDeferred, 1);
});

test("skips annotation with no artist id (defensive)", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Spring Tour 2026" });
  insertAnnotation(db, { artistId: null, parentHint: "Spring Tour 2026" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsDeferred, 1);
  assert.equal(getSources(db).length, 0);
});

test("dispatches by record_kind: events run through event resolution, annotations through annotation matching", async () => {
  // The merged resolver handles both record_kinds. This test verifies the
  // dispatch boundary: an event row creates a normalized event with
  // role='primary'; an annotation row referencing the same title attaches
  // to it via role='annotation' — in the same processBatch tick, because
  // events run first.
  const db = createTestDb();
  insertArtist(db);

  const rawId = randomUUID();
  db.insert(schema.rawItems).values({
    id: rawId,
    watchTargetId: "wt-1",
    sourceName: "twitter",
    sourceId: randomUUID(),
    rawData: {},
    fetchedAt: NOW,
    status: "processed",
  }).run();
  const evId = randomUUID();
  db.insert(schema.extractedEvents).values({
    id: evId,
    rawItemId: rawId,
    artistId: "artist-1",
    title: "Spring Tour 2026",
    description: "",
    startTime: NOW,
    endTime: null,
    venueId: null,
    venueName: null,
    venueUrl: null,
    type: "concert",
    recordKind: "event",
    eventScope: "main",
    parentEventHint: null,
    isCancelled: false,
    tags: [],
    publishTime: NOW,
    author: "fan",
    sourceUrl: "https://example.com/event",
    rawContent: "raw",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();

  const annId = insertAnnotation(db, { artistId: "artist-1", parentHint: "Spring Tour 2026" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.resolved, 1);
  assert.equal(result.annotationsAttached, 1);

  const sources = getSources(db);
  // Two source rows: role='primary' for the event, role='annotation' for the
  // annotation. Both pointing at the same normalized event.
  assert.equal(sources.length, 2);
  const roles = sources.map((s) => s.role).sort();
  assert.deepEqual(roles, ["annotation", "primary"]);
  assert.equal(sources[0]!.normalizedEventId, sources[1]!.normalizedEventId);

  // Event decision is 'new', annotation decision is 'annotation_attached'.
  const eventDec = db
    .select()
    .from(schema.eventResolutionDecisions)
    .where(eq(schema.eventResolutionDecisions.candidateExtractedEventId, evId))
    .all();
  assert.equal(eventDec.length, 1);
  assert.equal(eventDec[0]!.decision, "new");

  const annDec = db
    .select()
    .from(schema.eventResolutionDecisions)
    .where(eq(schema.eventResolutionDecisions.candidateExtractedEventId, annId))
    .all();
  assert.equal(annDec.length, 1);
  assert.equal(annDec[0]!.decision, "annotation_attached");
});

// ---- Series-name fallback ----
//
// Per the 2026-05-17 audit, F3: 5 of 11 annotations failed because their
// parent_event_hint pointed at a series umbrella ("GW特別投稿") that has
// no event row of its own. P3a added series_name to extracted/normalized
// events; this fallback path attaches such annotations to the most recent
// episode in the matching series.

test("series fallback: hint matches series_name when no title matches", async () => {
  const db = createTestDb();
  insertArtist(db);

  // Three episodes of "GW特別投稿" — none of them title-matches the hint
  // "GW特別投稿ラスト", but all carry series_name="GW特別投稿".
  insertNormalizedEvent(db, {
    artistId: "artist-1",
    title: "「私論理」━「宿声 / 深愛」Live Ver.━",
    seriesName: "GW特別投稿",
    startTime: new Date("2026-05-01T03:00:00Z"),
  });
  insertNormalizedEvent(db, {
    artistId: "artist-1",
    title: "「景色」 Live Ver. Limited-Time Release",
    seriesName: "GW特別投稿",
    startTime: new Date("2026-05-03T03:00:00Z"),
  });
  const lastEpisode = insertNormalizedEvent(db, {
    artistId: "artist-1",
    title: "「それを世界と言うんだね」Live Ver.",
    seriesName: "GW特別投稿",
    startTime: new Date("2026-05-07T03:00:00Z"),
  });

  insertAnnotation(db, { artistId: "artist-1", parentHint: "GW特別投稿" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 1);
  assert.equal(result.annotationsNoMatch, 0);

  // Attached to the LATEST episode (May 7), not the earlier ones.
  const sources = getSources(db);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.normalizedEventId, lastEpisode);

  const decisions = getDecisions(db);
  assert.equal(decisions[0]!.decision, "annotation_attached");
  assert.ok(
    decisions[0]!.reason.includes("series"),
    `reason should mention series fallback, got: ${decisions[0]!.reason}`,
  );
});

test("series fallback: title match still takes precedence over series_name", async () => {
  const db = createTestDb();
  insertArtist(db);

  // Both a perfect title match AND a series-name match exist. Title wins.
  const titleMatch = insertNormalizedEvent(db, {
    artistId: "artist-1",
    title: "Spring Tour Final Show",
    seriesName: undefined,
  });
  insertNormalizedEvent(db, {
    artistId: "artist-1",
    title: "「景色」 Live Ver.",
    seriesName: "Spring Tour Final Show",
  });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Spring Tour Final Show" });

  const resolver = new EventResolver(db as any);
  await resolver.processBatch(10);

  const sources = getSources(db);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.normalizedEventId, titleMatch);
});

test("series fallback: no series_name candidates → still annotation_no_match", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertNormalizedEvent(db, { artistId: "artist-1", title: "Summer Concert" });
  insertAnnotation(db, { artistId: "artist-1", parentHint: "Some Unrelated Umbrella" });

  const resolver = new EventResolver(db as any);
  const result = await resolver.processBatch(10);

  assert.equal(result.annotationsAttached, 0);
  assert.equal(result.annotationsNoMatch, 1);
});
