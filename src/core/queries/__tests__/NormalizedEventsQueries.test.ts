import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { listNormalizedEvents } from "../NormalizedEventsQueries";

function createTestDb(opts: { logger?: { logQuery: () => void } } = {}) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema, logger: opts.logger });
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
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT, error_class TEXT, not_an_event_category TEXT
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY, raw_item_id TEXT NOT NULL UNIQUE, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, record_kind TEXT NOT NULL DEFAULT 'event', event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT, series_name TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL, publish_time INTEGER NOT NULL,
      author TEXT NOT NULL, source_url TEXT NOT NULL, raw_content TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_events (
      id TEXT PRIMARY KEY, parent_event_id TEXT, artist_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL, series_name TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL,
      operator_owned INTEGER NOT NULL DEFAULT 0, operator_edited_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE normalized_event_sources (
      id TEXT PRIMARY KEY, normalized_event_id TEXT NOT NULL,
      extracted_event_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE event_resolution_decisions (
      id TEXT PRIMARY KEY, candidate_extracted_event_id TEXT NOT NULL,
      matched_normalized_event_id TEXT, decision TEXT NOT NULL,
      score REAL, signals TEXT NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER, superseded_by_id TEXT, note TEXT
    );
  `);
  return db;
}

type Db = ReturnType<typeof createTestDb>;

async function seedNormalized(db: Db, args: {
  id: string;
  title?: string;
  startTime?: Date;
  artistId?: string | null;
  venueId?: string | null;
  parentEventId?: string | null;
  isCancelled?: boolean;
}) {
  const now = new Date();
  await db.insert(schema.normalizedEvents).values({
    id: args.id,
    parentEventId: args.parentEventId ?? null,
    artistId: args.artistId ?? null,
    title: args.title ?? `Event ${args.id}`,
    description: "desc",
    startTime: args.startTime ?? new Date("2026-06-01T10:00:00Z"),
    endTime: null,
    venueId: args.venueId ?? null,
    venueName: null, venueUrl: null,
    type: "concert", isCancelled: args.isCancelled ?? false, tags: [],
    createdAt: now, updatedAt: now,
  });
}

async function seedExtractedAndSource(db: Db, args: {
  extractedId: string;
  normalizedEventId: string;
  role?: "primary" | "merged" | "review_candidate" | "ignored";
  decision?: "new" | "merged" | "linked_as_sub" | "needs_review" | "no_match" | "ignored";
  reason?: string;
}) {
  await db.insert(schema.rawItems).values({
    id: `raw-${args.extractedId}`, watchTargetId: "wt-1", sourceName: "twitter",
    sourceId: `raw-${args.extractedId}`, rawData: {}, fetchedAt: new Date(),
    status: "processed", errorMessage: null, errorClass: null,
  });
  await db.insert(schema.extractedEvents).values({
    id: args.extractedId, rawItemId: `raw-${args.extractedId}`, artistId: null,
    title: "ext", description: "", startTime: new Date(), endTime: null,
    venueId: null, venueName: null, venueUrl: null,
    type: "concert", eventScope: "unknown", parentEventHint: null,
    isCancelled: false, tags: [], publishTime: new Date(),
    author: "a", sourceUrl: "https://x.test", rawContent: "",
    createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.normalizedEventSources).values({
    id: `nes-${args.extractedId}`,
    normalizedEventId: args.normalizedEventId,
    extractedEventId: args.extractedId,
    role: args.role ?? "primary",
    createdAt: new Date(),
  });
  if (args.decision) {
    await db.insert(schema.eventResolutionDecisions).values({
      id: `dec-${args.extractedId}`,
      candidateExtractedEventId: args.extractedId,
      matchedNormalizedEventId: null,
      decision: args.decision,
      score: 1.0,
      signals: {},
      reason: args.reason ?? "auto",
      createdAt: new Date(),
    });
  }
}

test("returns empty list when no normalized events exist", async () => {
  const db = createTestDb();
  const items = await listNormalizedEvents({}, db as any);
  assert.deepEqual(items, []);
});

test("joins artist, venue, source count, decision, and parent title", async () => {
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

  await seedNormalized(db, { id: "parent-1", title: "Birthday Live" });
  await seedNormalized(db, {
    id: "child-1", title: "Merch booth",
    parentEventId: "parent-1", artistId: "art-1", venueId: "ven-1",
  });
  await seedExtractedAndSource(db, {
    extractedId: "ext-1", normalizedEventId: "child-1",
    role: "primary", decision: "linked_as_sub", reason: "scope=sub",
  });
  await seedExtractedAndSource(db, {
    extractedId: "ext-2", normalizedEventId: "child-1",
    role: "merged",
  });

  const items = await listNormalizedEvents({}, db as any);
  // Two events total (parent + child); child should appear with full enrichment.
  const child = items.find((i) => i.id === "child-1");
  assert.ok(child, "child event present");
  assert.equal(child.artistName, "Hoshino Aoi");
  assert.equal(child.venue?.name, "Zepp DiverCity");
  assert.equal(child.sourceCount, 2);
  assert.equal(child.latestDecision, "linked_as_sub");
  assert.equal(child.latestReason, "scope=sub");
  assert.equal(child.parentTitle, "Birthday Live");

  const parent = items.find((i) => i.id === "parent-1")!;
  assert.equal(parent.subEventCount, 1);
  assert.equal(parent.parentTitle, null);
});

test("filters by artistId when provided", async () => {
  const db = createTestDb();
  await db.insert(schema.artists).values([
    {
      id: "art-1", handle: "a1", name: "A1", categories: [], groups: [], enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: "art-2", handle: "a2", name: "A2", categories: [], groups: [], enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
  ]);
  await seedNormalized(db, { id: "n1", artistId: "art-1" });
  await seedNormalized(db, { id: "n2", artistId: "art-2" });

  const items = await listNormalizedEvents({ artistId: "art-1" }, db as any);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "n1");
});

test("orderBy 'updatedAt' returns newest-updated first", async () => {
  const db = createTestDb();
  // Insert with controlled updated_at via raw to set distinct timestamps
  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  await db.insert(schema.normalizedEvents).values({
    id: "n-old", parentEventId: null, artistId: null,
    title: "Old", description: "",
    startTime: new Date("2026-12-01"), endTime: null,
    venueId: null, venueName: null, venueUrl: null,
    type: "concert", isCancelled: false, tags: [],
    createdAt: earlier, updatedAt: earlier,
  });
  await db.insert(schema.normalizedEvents).values({
    id: "n-new", parentEventId: null, artistId: null,
    title: "New", description: "",
    startTime: new Date("2026-01-01"), endTime: null,
    venueId: null, venueName: null, venueUrl: null,
    type: "concert", isCancelled: false, tags: [],
    createdAt: now, updatedAt: now,
  });

  const byStart = await listNormalizedEvents({}, db as any);
  assert.equal(byStart[0]!.id, "n-old", "default order is start_time desc");

  const byUpdated = await listNormalizedEvents({ orderBy: "updatedAt" }, db as any);
  assert.equal(byUpdated[0]!.id, "n-new", "updatedAt order surfaces newest update first");
});

test("query count is constant regardless of result size (N+1 regression guard)", async () => {
  let count1 = 0;
  const db1 = createTestDb({ logger: { logQuery: () => count1++ } });
  await seedNormalized(db1, { id: "n-1" });
  count1 = 0; // reset after seeding so we only count the listNormalizedEvents calls
  await listNormalizedEvents({}, db1 as any);

  let count20 = 0;
  const db20 = createTestDb({ logger: { logQuery: () => count20++ } });
  for (let i = 0; i < 20; i++) {
    await seedNormalized(db20, { id: `n-${i}` });
  }
  count20 = 0; // reset after seeding
  await listNormalizedEvents({}, db20 as any);

  assert.equal(count1, count20, `expected constant query count, got ${count1} vs ${count20}`);
});
