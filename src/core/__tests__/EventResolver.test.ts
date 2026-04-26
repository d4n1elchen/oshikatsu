/**
 * Fixture tests for EventResolver (Phase 3.0).
 * Uses an in-memory SQLite database so no real database is required.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { EventResolver } from "../EventResolver";

// ---- in-memory DB setup ----

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });

  // Create tables (minimal DDL matching the generated migration)
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
      address TEXT,
      city TEXT,
      region TEXT,
      country TEXT,
      latitude REAL,
      longitude REAL,
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
      raw_data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      error_message TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY,
      raw_item_id TEXT NOT NULL UNIQUE,
      artist_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      venue_id TEXT,
      venue_name TEXT,
      venue_url TEXT,
      type TEXT NOT NULL,
      event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      publish_time INTEGER NOT NULL,
      author TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY,
      parent_event_id TEXT REFERENCES normalized_events(id) ON DELETE SET NULL,
      artist_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      venue_id TEXT,
      venue_name TEXT,
      venue_url TEXT,
      type TEXT NOT NULL,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
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
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

// ---- helpers ----

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date("2025-06-01T12:00:00Z");

function insertArtist(db: TestDb, id = "artist-1") {
  db.insert(schema.artists).values({
    id,
    name: "Test Artist",
    categories: [],
    groups: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return id;
}

function insertVenue(db: TestDb, id = "venue-1") {
  db.insert(schema.venues).values({
    id,
    name: "Test Venue",
    kind: "physical",
    status: "verified",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return id;
}

function insertExtractedEvent(
  db: TestDb,
  opts: {
    id?: string;
    artistId?: string;
    venueId?: string;
    startTime?: Date;
    title?: string;
    sourceUrl?: string;
    isCancelled?: boolean;
    eventScope?: "main" | "sub" | "unknown";
    parentEventHint?: string;
    type?: string;
  } = {}
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
    title: opts.title ?? "Test Concert",
    description: "A test concert.",
    startTime: opts.startTime ?? NOW,
    endTime: null,
    venueId: opts.venueId ?? null,
    venueName: null,
    venueUrl: null,
    type: opts.type ?? "concert",
    eventScope: opts.eventScope ?? "main",
    parentEventHint: opts.parentEventHint ?? null,
    isCancelled: opts.isCancelled ?? false,
    tags: [],
    publishTime: NOW,
    author: "testuser",
    sourceUrl: opts.sourceUrl ?? `https://example.com/${id}`,
    rawContent: "Raw content",
    createdAt: NOW,
    updatedAt: NOW,
  }).run();

  return id;
}

function addLink(db: TestDb, extractedEventId: string, url: string) {
  db.insert(schema.extractedEventRelatedLinks).values({
    id: randomUUID(),
    extractedEventId,
    rawItemId: null,
    url,
    title: null,
    createdAt: NOW,
  }).run();
}

function getNormalizedEvents(db: TestDb) {
  return db.select().from(schema.normalizedEvents).all();
}

function getDecisions(db: TestDb) {
  return db.select().from(schema.eventResolutionDecisions).all();
}

// ---- tests ----

test("first extracted event creates a new normalized event", async () => {
  const db = createTestDb();
  insertArtist(db);
  // No watch_targets row needed for this test — artistId set directly
  const evId = insertExtractedEvent(db, { artistId: "artist-1" });

  const resolver = new EventResolver(db as any);
  await resolver.resolve(evId);

  const normalized = getNormalizedEvents(db);
  assert.equal(normalized.length, 1);

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision, "new");
});

test("same source URL triggers merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedUrl = "https://example.com/tweet/123";

  const firstId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: sharedUrl });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: sharedUrl });
  await resolver.resolve(secondId);

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 2);

  const mergeDecision = decisions.find((d) => d.decision === "merged");
  assert.ok(mergeDecision, "should have a merged decision");
});

test("shared related link + close time triggers merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedLink = "https://event.example.com/tickets";

  const firstId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: "https://src/1" });
  addLink(db, firstId, sharedLink);
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: "https://src/2" });
  addLink(db, secondId, sharedLink);
  await resolver.resolve(secondId);

  const decisions = getDecisions(db);
  const mergeDecision = decisions.find((d) => d.decision === "merged");
  assert.ok(mergeDecision, "should merge on shared related link + close time");
});

test("shared related link but time diff > 48h triggers needs_review, not merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedLink = "https://event.example.com/tickets";
  const farTime = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days later

  const firstId = insertExtractedEvent(db, { artistId: "artist-1", startTime: NOW });
  addLink(db, firstId, sharedLink);
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, { artistId: "artist-1", startTime: farTime });
  addLink(db, secondId, sharedLink);
  await resolver.resolve(secondId);

  const decisions = getDecisions(db);
  const reviewDecision = decisions.find((d) => d.decision === "needs_review");
  assert.ok(reviewDecision, "should flag needs_review for far-apart times");
});

test("same venue + close time + similar title triggers merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertVenue(db);

  const firstId = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "venue-1",
    title: "Tokyo Dome Concert",
    startTime: NOW,
    sourceUrl: "https://src/a",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "venue-1",
    title: "Tokyo Dome Concert",
    startTime: new Date(NOW.getTime() + 3600_000), // 1 hour later
    sourceUrl: "https://src/b",
  });
  await resolver.resolve(secondId);

  const decisions = getDecisions(db);
  const mergeDecision = decisions.find((d) => d.decision === "merged");
  assert.ok(mergeDecision, "should merge: same venue + close time + similar title");
});

test("same generic virtual venue only — no merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertVenue(db, "youtube");

  // Two events at "YouTube" with different titles and no shared links
  const firstId = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "youtube",
    title: "Morning Talk",
    startTime: NOW,
    sourceUrl: "https://yt/1",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "youtube",
    title: "Evening Gaming",
    startTime: new Date(NOW.getTime() + 3600_000 * 6),
    sourceUrl: "https://yt/2",
  });
  await resolver.resolve(secondId);

  // Both should become separate normalized events (no merge)
  const normalized = getNormalizedEvents(db);
  assert.equal(normalized.length, 2, "should create two separate normalized events");
});

test("cancellation flag is propagated on merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedLink = "https://event.example.com/tickets";

  const firstId = insertExtractedEvent(db, { artistId: "artist-1", isCancelled: false });
  addLink(db, firstId, sharedLink);
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const normBefore = getNormalizedEvents(db);
  assert.equal(normBefore[0]!.isCancelled, false);

  // Second source announces cancellation
  const secondId = insertExtractedEvent(db, { artistId: "artist-1", isCancelled: true });
  addLink(db, secondId, sharedLink);
  await resolver.resolve(secondId);

  const normAfter = getNormalizedEvents(db);
  assert.equal(normAfter.length, 1, "should still be one normalized event");
  assert.equal(normAfter[0]!.isCancelled, true, "cancellation should be propagated");
});

test("re-running resolve on an already-resolved event is idempotent", async () => {
  const db = createTestDb();
  insertArtist(db);
  const evId = insertExtractedEvent(db, { artistId: "artist-1" });

  const resolver = new EventResolver(db as any);
  await resolver.resolve(evId);
  await resolver.resolve(evId); // second call should be a no-op

  const normalized = getNormalizedEvents(db);
  assert.equal(normalized.length, 1, "should still have exactly one normalized event");

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 1, "should still have exactly one decision");
});

test("related links are accessible via normalized_event_sources join after merge", async () => {
  const db = createTestDb();
  insertArtist(db);
  const sharedLink = "https://event.example.com/tickets";
  const extraLink = "https://event.example.com/stream";

  const firstId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: "https://src/1" });
  addLink(db, firstId, sharedLink);
  const resolver = new EventResolver(db as any);
  await resolver.resolve(firstId);

  const secondId = insertExtractedEvent(db, { artistId: "artist-1", sourceUrl: "https://src/2" });
  addLink(db, secondId, sharedLink);
  addLink(db, secondId, extraLink);
  await resolver.resolve(secondId);

  const normId = getNormalizedEvents(db)[0]!.id;

  // Query links via the join
  const { eq, inArray } = await import("drizzle-orm");
  const sources = await db
    .select({ extractedEventId: schema.normalizedEventSources.extractedEventId })
    .from(schema.normalizedEventSources)
    .where(eq(schema.normalizedEventSources.normalizedEventId, normId));

  const extractedIds = sources.map((s) => s.extractedEventId);
  const links = await db
    .select({ url: schema.extractedEventRelatedLinks.url })
    .from(schema.extractedEventRelatedLinks)
    .where(inArray(schema.extractedEventRelatedLinks.extractedEventId, extractedIds));

  const urls = new Set(links.map((l) => l.url));
  assert.ok(urls.has(sharedLink), "shared link should be accessible");
  assert.ok(urls.has(extraLink), "extra link from second source should be accessible");
});

// ---- Phase 3.1 hierarchy tests ----

test("event_scope=sub with matching parent_event_hint links as sub-event", async () => {
  const db = createTestDb();
  insertArtist(db);

  // First, create a main event
  const mainEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Tokyo Dome Concert 2025",
    type: "concert",
    eventScope: "main",
    sourceUrl: "https://src/main",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(mainEv);

  // Then, a sub-event hinting at the main event
  const subEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Pre-show meet & greet",
    type: "side_event",
    eventScope: "sub",
    parentEventHint: "Tokyo Dome Concert 2025",
    sourceUrl: "https://src/sub",
  });
  await resolver.resolve(subEv);

  const decisions = getDecisions(db);
  const subDecision = decisions.find((d) => d.decision === "linked_as_sub");
  assert.ok(subDecision, "should link as sub-event");

  const norm = getNormalizedEvents(db);
  assert.equal(norm.length, 2, "should have main + sub normalized events");
  const subNorm = norm.find((n) => n.title === "Pre-show meet & greet")!;
  const mainNorm = norm.find((n) => n.title === "Tokyo Dome Concert 2025")!;
  assert.equal(subNorm.parentEventId, mainNorm.id, "sub should reference main as parent");
  assert.equal(mainNorm.parentEventId, null, "main should have no parent");
});

test("event_scope=sub with no matching main event flags needs_review (does not invent parent)", async () => {
  const db = createTestDb();
  insertArtist(db);

  // No main events exist yet
  const subEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Merch booth",
    eventScope: "sub",
    parentEventHint: "Some Concert That Doesn't Exist",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(subEv);

  const decisions = getDecisions(db);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.decision, "needs_review", "should flag for review");

  const norm = getNormalizedEvents(db);
  assert.equal(norm.length, 0, "should NOT create a canonical event");
});

test("sub-event resolution does not edit parent's canonical fields", async () => {
  const db = createTestDb();
  insertArtist(db);

  const mainEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Tokyo Dome Concert",
    sourceUrl: "https://src/main",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(mainEv);

  const mainBefore = getNormalizedEvents(db)[0]!;

  // Sub-event with cancellation flag — should NOT cancel the parent.
  const subEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Pre-show talk",
    eventScope: "sub",
    parentEventHint: "Tokyo Dome Concert",
    isCancelled: true,
    sourceUrl: "https://src/sub",
  });
  await resolver.resolve(subEv);

  const allNorm = await db.select().from(schema.normalizedEvents);
  const mainRow = allNorm.find((n) => n.id === mainBefore.id)!;
  assert.equal(mainRow.isCancelled, false, "parent must not be cancelled by sub-event");
  assert.equal(mainRow.title, "Tokyo Dome Concert", "parent title must not change");

  const subRow = allNorm.find((n) => n.parentEventId === mainBefore.id);
  assert.ok(subRow, "sub-event should exist");
  assert.equal(subRow!.isCancelled, true, "sub-event itself carries its own cancellation");
});

test("event_scope=sub with same artist+venue+close time but no hint links as sub", async () => {
  const db = createTestDb();
  insertArtist(db);
  insertVenue(db);

  const mainEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "venue-1",
    title: "Tokyo Dome Concert",
    startTime: NOW,
    sourceUrl: "https://src/main",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(mainEv);

  // Sub-event with venue + time but no hint — strong contextual attachment via the
  // hint path requires the hint match. Without it, we expect needs_review.
  const subEv = insertExtractedEvent(db, {
    artistId: "artist-1",
    venueId: "venue-1",
    title: "Backstage tour",
    startTime: new Date(NOW.getTime() + 3600_000),
    eventScope: "sub",
    sourceUrl: "https://src/sub",
  });
  await resolver.resolve(subEv);

  // Without a hint, signals are weak — should be needs_review or new, but NOT auto-linked.
  const decisions = getDecisions(db);
  const subDecision = decisions.find((d) => d.candidateExtractedEventId === subEv);
  assert.ok(subDecision);
  assert.notEqual(subDecision!.decision, "linked_as_sub", "should not auto-link without hint or strong signal");
});

test("hierarchy resolution does not run for event_scope=main", async () => {
  const db = createTestDb();
  insertArtist(db);

  const ev1 = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Concert A",
    sourceUrl: "https://src/1",
  });
  const resolver = new EventResolver(db as any);
  await resolver.resolve(ev1);

  // A second main event with a hint pointing at the first should NOT be auto-linked.
  const ev2 = insertExtractedEvent(db, {
    artistId: "artist-1",
    title: "Concert B",
    eventScope: "main",
    parentEventHint: "Concert A",
    sourceUrl: "https://src/2",
    startTime: new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000), // 10 days later
  });
  await resolver.resolve(ev2);

  const decisions = getDecisions(db);
  const ev2Decision = decisions.find((d) => d.candidateExtractedEventId === ev2);
  assert.ok(ev2Decision);
  assert.notEqual(ev2Decision!.decision, "linked_as_sub", "main events should not be linked as sub");
});
