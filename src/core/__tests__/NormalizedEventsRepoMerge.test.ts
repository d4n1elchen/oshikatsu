/**
 * Fixture tests for NormalizedEventsRepo.mergeNormalizedEvents and
 * reparentNormalizedEvent — the operator-driven manual override paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { NormalizedEventsRepo } from "../NormalizedEventsRepo";

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
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY, watch_target_id TEXT NOT NULL, source_name TEXT NOT NULL,
      source_id TEXT NOT NULL UNIQUE, source_url TEXT, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT, not_an_event_category TEXT
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
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY, parent_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      artist_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER, venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, is_cancelled INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL,
      operator_owned INTEGER NOT NULL DEFAULT 0, operator_edited_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_event_sources (
      id TEXT PRIMARY KEY,
      normalized_event_id TEXT NOT NULL REFERENCES normalized_events(id) ON DELETE CASCADE,
      extracted_event_id TEXT NOT NULL REFERENCES extracted_events(id) ON DELETE CASCADE,
      role TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(normalized_event_id, extracted_event_id)
    );
    CREATE TABLE event_resolution_decisions (
      id TEXT PRIMARY KEY,
      candidate_extracted_event_id TEXT NOT NULL REFERENCES extracted_events(id) ON DELETE CASCADE,
      matched_normalized_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      decision TEXT NOT NULL, score REAL, signals TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER, superseded_by_id TEXT, note TEXT
    );
  `);
  return db;
}

type TestDb = ReturnType<typeof createTestDb>;
const NOW = new Date("2026-05-15T12:00:00Z");

function seedArtist(db: TestDb) {
  db.insert(schema.artists).values({
    id: "artist-1", handle: "h", name: "Artist", categories: [], groups: [], enabled: true,
    createdAt: NOW, updatedAt: NOW,
  }).run();
}

function seedExtracted(db: TestDb, title: string) {
  const rawId = randomUUID();
  db.insert(schema.rawItems).values({
    id: rawId, watchTargetId: "wt-1", sourceName: "twitter", sourceId: randomUUID(),
    rawData: {}, fetchedAt: NOW, status: "processed",
  }).run();
  const id = randomUUID();
  db.insert(schema.extractedEvents).values({
    id, rawItemId: rawId, artistId: "artist-1", title, description: "",
    startTime: NOW, endTime: null, venueId: null, venueName: null, venueUrl: null,
    type: "concert", recordKind: "event", eventScope: "main", parentEventHint: null,
    isCancelled: false, tags: [], publishTime: NOW, author: "a", sourceUrl: `https://x/${id}`,
    rawContent: "", createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

function seedNormalized(db: TestDb, opts: { title: string; parentEventId?: string | null } = { title: "E" }) {
  const id = randomUUID();
  db.insert(schema.normalizedEvents).values({
    id, parentEventId: opts.parentEventId ?? null, artistId: "artist-1",
    title: opts.title, description: "", startTime: NOW, endTime: null,
    venueId: null, venueName: null, venueUrl: null,
    type: "concert", isCancelled: false, tags: [], operatorOwned: false, operatorEditedAt: null,
    createdAt: NOW, updatedAt: NOW,
  }).run();
  return id;
}

function linkSource(db: TestDb, normId: string, extractedId: string, role: "primary" | "merged" = "primary") {
  db.insert(schema.normalizedEventSources).values({
    id: randomUUID(), normalizedEventId: normId, extractedEventId: extractedId, role,
    createdAt: NOW,
  }).run();
}

function seedAutoDecision(db: TestDb, candidateId: string, matchedId: string | null, decision: string) {
  const id = randomUUID();
  db.insert(schema.eventResolutionDecisions).values({
    id, candidateExtractedEventId: candidateId, matchedNormalizedEventId: matchedId,
    decision: decision as any, score: 0.8, signals: {}, reason: "auto",
    createdAt: NOW,
  } as any).run();
  return id;
}

// ---- merge ----

test("mergeNormalizedEvents moves sources to winner and deletes loser", async () => {
  const db = createTestDb();
  seedArtist(db);
  const loser = seedNormalized(db, { title: "Loser" });
  const winner = seedNormalized(db, { title: "Winner" });
  const ext1 = seedExtracted(db, "ext1");
  const ext2 = seedExtracted(db, "ext2");
  linkSource(db, loser, ext1, "primary");
  linkSource(db, loser, ext2, "merged");
  seedAutoDecision(db, ext1, loser, "new");
  seedAutoDecision(db, ext2, loser, "merged");

  const repo = new NormalizedEventsRepo(db as any);
  await repo.mergeNormalizedEvents(loser, winner, "duplicate");

  const remaining = db.select().from(schema.normalizedEvents).all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.id, winner);

  const sources = db.select().from(schema.normalizedEventSources).all();
  assert.equal(sources.length, 2, "both sources moved to winner");
  for (const s of sources) {
    assert.equal(s.normalizedEventId, winner);
    assert.equal(s.role, "merged");
  }
});

test("mergeNormalizedEvents writes manual_override decisions and supersedes prior", async () => {
  const db = createTestDb();
  seedArtist(db);
  const loser = seedNormalized(db, { title: "Loser" });
  const winner = seedNormalized(db, { title: "Winner" });
  const ext1 = seedExtracted(db, "ext1");
  linkSource(db, loser, ext1, "primary");
  const autoDecId = seedAutoDecision(db, ext1, loser, "new");

  const repo = new NormalizedEventsRepo(db as any);
  await repo.mergeNormalizedEvents(loser, winner, "operator note");

  const decs = db.select().from(schema.eventResolutionDecisions).all();
  assert.equal(decs.length, 2);

  const original = decs.find((d) => d.id === autoDecId)!;
  const manual = decs.find((d) => d.id !== autoDecId)!;

  assert.ok(original.supersededAt, "auto decision marked superseded");
  assert.equal(original.supersededById, manual.id);

  assert.equal(manual.decision, "merged");
  assert.equal(manual.matchedNormalizedEventId, winner);
  assert.equal(manual.note, "operator note");
  assert.equal((manual.signals as any).manual_override, true);
  assert.equal((manual.signals as any).loser_normalized_event_id, loser);
});

test("mergeNormalizedEvents drops loser-side rows that conflict with winner's existing sources", async () => {
  const db = createTestDb();
  seedArtist(db);
  const loser = seedNormalized(db, { title: "Loser" });
  const winner = seedNormalized(db, { title: "Winner" });
  const shared = seedExtracted(db, "shared");
  linkSource(db, loser, shared, "primary");
  linkSource(db, winner, shared, "primary");

  const repo = new NormalizedEventsRepo(db as any);
  await repo.mergeNormalizedEvents(loser, winner);

  const sources = db.select().from(schema.normalizedEventSources).all();
  assert.equal(sources.length, 1, "duplicate dropped");
  assert.equal(sources[0]!.normalizedEventId, winner);
});

test("mergeNormalizedEvents re-parents sub-events of the loser to the winner", async () => {
  const db = createTestDb();
  seedArtist(db);
  const loser = seedNormalized(db, { title: "Loser" });
  const winner = seedNormalized(db, { title: "Winner" });
  const sub = seedNormalized(db, { title: "Sub of loser", parentEventId: loser });

  const repo = new NormalizedEventsRepo(db as any);
  await repo.mergeNormalizedEvents(loser, winner);

  const subRow = db.select().from(schema.normalizedEvents).where(eq(schema.normalizedEvents.id, sub)).all();
  assert.equal(subRow[0]!.parentEventId, winner);
});

test("mergeNormalizedEvents rejects loser === winner", async () => {
  const db = createTestDb();
  seedArtist(db);
  const id = seedNormalized(db, { title: "Same" });
  const repo = new NormalizedEventsRepo(db as any);
  await assert.rejects(() => repo.mergeNormalizedEvents(id, id), /must differ/);
});

// ---- reparent ----

test("reparentNormalizedEvent sets parent_event_id and writes manual linked_as_sub decisions", async () => {
  const db = createTestDb();
  seedArtist(db);
  const main = seedNormalized(db, { title: "Main" });
  const orphanSub = seedNormalized(db, { title: "Misclassified main" });
  const ext = seedExtracted(db, "ext");
  linkSource(db, orphanSub, ext, "primary");
  const autoId = seedAutoDecision(db, ext, orphanSub, "new");

  const repo = new NormalizedEventsRepo(db as any);
  await repo.reparentNormalizedEvent(orphanSub, main, "actually a sub-event");

  const row = db.select().from(schema.normalizedEvents).where(eq(schema.normalizedEvents.id, orphanSub)).all();
  assert.equal(row[0]!.parentEventId, main);

  const decs = db.select().from(schema.eventResolutionDecisions).all();
  assert.equal(decs.length, 2);
  const manual = decs.find((d) => d.id !== autoId)!;
  assert.equal(manual.decision, "linked_as_sub");
  assert.equal(manual.matchedNormalizedEventId, main);
  assert.equal(manual.note, "actually a sub-event");
  assert.equal((manual.signals as any).manual_override, true);

  const original = decs.find((d) => d.id === autoId)!;
  assert.ok(original.supersededAt);
});

test("reparentNormalizedEvent rejects when target parent is itself a sub-event", async () => {
  const db = createTestDb();
  seedArtist(db);
  const top = seedNormalized(db, { title: "Top" });
  const mid = seedNormalized(db, { title: "Mid", parentEventId: top });
  const candidate = seedNormalized(db, { title: "Candidate" });

  const repo = new NormalizedEventsRepo(db as any);
  await assert.rejects(
    () => repo.reparentNormalizedEvent(candidate, mid),
    /sub-event/
  );
});

test("reparentNormalizedEvent rejects eventId === parentId", async () => {
  const db = createTestDb();
  seedArtist(db);
  const id = seedNormalized(db, { title: "Same" });
  const repo = new NormalizedEventsRepo(db as any);
  await assert.rejects(() => repo.reparentNormalizedEvent(id, id), /must differ/);
});
