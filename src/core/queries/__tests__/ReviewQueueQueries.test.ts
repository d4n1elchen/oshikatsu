import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listReviewQueue } from "../ReviewQueueQueries";

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
      source_id TEXT NOT NULL UNIQUE, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY, raw_item_id TEXT NOT NULL UNIQUE, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL, publish_time INTEGER NOT NULL,
      author TEXT NOT NULL, source_url TEXT NOT NULL, raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY, parent_event_id TEXT, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE event_resolution_decisions (
      id TEXT PRIMARY KEY, candidate_extracted_event_id TEXT NOT NULL,
      matched_normalized_event_id TEXT, decision TEXT NOT NULL,
      score REAL, signals TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedExtracted(db: Db, args: {
  id: string;
  title?: string;
  artistId?: string | null;
  venueId?: string | null;
  venueName?: string | null;
}) {
  await db.insert(schema.extractedEvents).values({
    id: args.id,
    rawItemId: `raw-${args.id}`,
    artistId: args.artistId ?? null,
    title: args.title ?? "Candidate event",
    description: "desc",
    startTime: new Date("2026-06-01T10:00:00Z"),
    endTime: null,
    venueId: args.venueId ?? null,
    venueName: args.venueName ?? null,
    venueUrl: null,
    type: "concert",
    eventScope: "unknown",
    parentEventHint: null,
    isCancelled: false,
    tags: [],
    publishTime: new Date("2026-05-30T10:00:00Z"),
    author: "test_author",
    sourceUrl: "https://example.com/post",
    rawContent: "raw text",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedDecision(db: Db, args: {
  id: string;
  candidateExtractedEventId: string;
  matchedNormalizedEventId?: string | null;
  decision?: "new" | "merged" | "linked_as_sub" | "needs_review" | "no_match" | "ignored";
  reason?: string;
  createdAt?: Date;
}) {
  await db.insert(schema.eventResolutionDecisions).values({
    id: args.id,
    candidateExtractedEventId: args.candidateExtractedEventId,
    matchedNormalizedEventId: args.matchedNormalizedEventId ?? null,
    decision: args.decision ?? "needs_review",
    score: 0.55,
    signals: { titleSim: 0.6 },
    reason: args.reason ?? "title sim above floor",
    createdAt: args.createdAt ?? new Date(),
  });
}

test("returns empty list when no needs_review decisions exist", async () => {
  const db = createTestDb();
  const items = await listReviewQueue({}, db as any);
  assert.deepEqual(items, []);
});

test("filters out decisions other than needs_review", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1" });
  await seedExtracted(db, { id: "e2" });
  await seedDecision(db, { id: "d1", candidateExtractedEventId: "e1", decision: "needs_review" });
  await seedDecision(db, { id: "d2", candidateExtractedEventId: "e2", decision: "merged" });

  const items = await listReviewQueue({}, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.decisionId, "d1");
});

test("joins candidate artist + venue and matched event + venue", async () => {
  const db = createTestDb();

  await db.insert(schema.artists).values({
    id: "art-1", handle: "h", name: "Hoshino Aoi",
    categories: [], groups: [], enabled: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.venues).values({
    id: "ven-cand", name: "Zepp DiverCity", kind: "physical", status: "verified",
    url: null, address: null, city: null, region: null, country: null,
    latitude: null, longitude: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.venues).values({
    id: "ven-match", name: "Tokyo Dome", kind: "physical", status: "verified",
    url: null, address: null, city: null, region: null, country: null,
    latitude: null, longitude: null,
    createdAt: new Date(), updatedAt: new Date(),
  });

  await seedExtracted(db, {
    id: "e1", title: "Birthday Live",
    artistId: "art-1", venueId: "ven-cand",
  });

  await db.insert(schema.normalizedEvents).values({
    id: "n1", parentEventId: null, artistId: "art-1",
    title: "Existing canonical", description: "",
    startTime: new Date("2026-06-01T11:00:00Z"), endTime: null,
    venueId: "ven-match", venueName: null, venueUrl: null,
    type: "concert", isCancelled: false, tags: [],
    createdAt: new Date(), updatedAt: new Date(),
  });

  await seedDecision(db, {
    id: "d1",
    candidateExtractedEventId: "e1",
    matchedNormalizedEventId: "n1",
  });

  const items = await listReviewQueue({}, db as any);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.candidateArtistName, "Hoshino Aoi");
  assert.equal(item.candidateVenueName, "Zepp DiverCity");
  assert.equal(item.matchedId, "n1");
  assert.equal(item.matchedTitle, "Existing canonical");
  assert.equal(item.matchedVenueName, "Tokyo Dome");
});

test("matched fields are null when matched_normalized_event_id is null", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1" });
  await seedDecision(db, { id: "d1", candidateExtractedEventId: "e1", matchedNormalizedEventId: null });

  const items = await listReviewQueue({}, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.matchedId, null);
  assert.equal(items[0]!.matchedTitle, null);
  assert.equal(items[0]!.matchedVenueName, null);
});

test("orders by createdAt desc and respects limit", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1" });
  await seedExtracted(db, { id: "e2" });
  await seedExtracted(db, { id: "e3" });
  await seedDecision(db, { id: "d1", candidateExtractedEventId: "e1", createdAt: new Date("2026-04-01") });
  await seedDecision(db, { id: "d2", candidateExtractedEventId: "e2", createdAt: new Date("2026-04-03") });
  await seedDecision(db, { id: "d3", candidateExtractedEventId: "e3", createdAt: new Date("2026-04-02") });

  const items = await listReviewQueue({ limit: 2 }, db as any);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.decisionId, "d2");
  assert.equal(items[1]!.decisionId, "d3");
});

test("falls back to extracted venue_name when no canonical venue is linked", async () => {
  const db = createTestDb();
  await seedExtracted(db, { id: "e1", venueId: null, venueName: "Some Hall" });
  await seedDecision(db, { id: "d1", candidateExtractedEventId: "e1" });

  const items = await listReviewQueue({}, db as any);
  assert.equal(items[0]!.candidateVenueName, "Some Hall");
});
