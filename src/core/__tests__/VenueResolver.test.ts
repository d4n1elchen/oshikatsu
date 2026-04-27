/**
 * Resolver tests for the virtual-venue-granularity rules
 * (design_docs/2026-04-25-virtual-venue-granularity).
 *
 * Uses an in-memory SQLite DB so no real database is required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { VenueResolver } from "../VenueResolver";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });

  // Minimal schema — only tables the resolver touches.
  sqlite.exec(`
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
    CREATE TABLE venue_aliases (
      id TEXT PRIMARY KEY,
      venue_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      locale TEXT,
      source TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(venue_id, alias)
    );
  `);

  return db;
}

// ---- Six tests from the design doc ----

test("returns null when virtual platform name has no URL", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  const result = await resolver.resolve({ venueName: "YouTube", venueUrl: null });
  assert.equal(result, null, "should not auto-create a venue for bare platform name");

  const venuesRows = await db.select().from(schema.venues);
  assert.equal(venuesRows.length, 0, "no venue should be created");
});

test("auto-discovers a virtual venue when given a channel URL", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  const result = await resolver.resolve({
    venueName: "YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });

  assert.ok(result, "should resolve");
  assert.equal(result!.method, "discovered");
  assert.equal(result!.venue.kind, "virtual");
  assert.equal(result!.venue.url, "https://youtube.com/@channel_a");

  const venuesRows = await db.select().from(schema.venues);
  assert.equal(venuesRows.length, 1);
});

test("returns the existing venue when the same channel URL is seen again", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  const first = await resolver.resolve({
    venueName: "YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });
  assert.ok(first);

  const second = await resolver.resolve({
    venueName: "YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });
  assert.ok(second);

  assert.equal(second!.venue.id, first!.venue.id, "should return the same venue id");
  assert.equal(second!.method, "url");

  const venuesRows = await db.select().from(schema.venues);
  assert.equal(venuesRows.length, 1, "no duplicate venue created");
});

test("creates a different venue for a different channel URL on the same platform", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  // Under the new LLM prompt rule, distinct channels should be extracted with
  // distinct names (the channel name, not the bare platform name). This test
  // verifies that different channel URLs produce different venue rows.
  const a = await resolver.resolve({
    venueName: "Channel A's YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });
  const b = await resolver.resolve({
    venueName: "Channel B's YouTube",
    venueUrl: "https://youtube.com/@channel_b",
  });

  assert.ok(a && b);
  assert.notEqual(a!.venue.id, b!.venue.id, "different channels should be different venues");

  const venuesRows = await db.select().from(schema.venues);
  assert.equal(venuesRows.length, 2);
});

test("same channel URL with a different venue_name resolves to same venue and adds alias", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  const first = await resolver.resolve({
    venueName: "YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });
  const second = await resolver.resolve({
    venueName: "Channel A's official YouTube",
    venueUrl: "https://youtube.com/@channel_a",
  });

  assert.ok(first && second);
  assert.equal(second!.venue.id, first!.venue.id);

  const aliasRows = await db
    .select()
    .from(schema.venueAliases)
    .where((schema.venueAliases.venueId as any).eq?.(first!.venue.id) ?? undefined);

  // simpler: just read all aliases for this venue
  const allAliases = await db.select().from(schema.venueAliases);
  const aliasesForVenue = allAliases.filter((a) => a.venueId === first!.venue.id);
  const aliasTexts = new Set(aliasesForVenue.map((a) => a.alias));

  assert.ok(aliasTexts.has("YouTube"), "original name should be an alias");
  assert.ok(aliasTexts.has("Channel A's official YouTube"), "second name should be added as alias");
});

test("physical venue auto-discovery without URL still works (regression guard)", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  // "Tokyo Dome" has no URL; the kind heuristic returns "unknown" (not virtual),
  // so name-only auto-discovery should still apply.
  const result = await resolver.resolve({
    venueName: "Tokyo Dome",
    venueUrl: null,
  });

  assert.ok(result, "physical/unknown name should still auto-discover");
  assert.equal(result!.method, "discovered");
  assert.equal(result!.venue.url, null);
  // kind = "unknown" because the inferVenueKind heuristic only flags known
  // virtual platform substrings; other names default to unknown until
  // curated. This matches the venue-database design.
  assert.equal(result!.venue.kind, "unknown");
});

// ---- Bonus: end-to-end check that URL canonicalization actually collapses forms ----

test("different URL forms for the same channel resolve to the same venue", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);

  const variants = [
    "https://youtube.com/@channel_a",
    "https://www.youtube.com/@channel_a",
    "http://youtube.com/@channel_a",
    "https://m.youtube.com/@channel_a",
    "https://youtube.com/@channel_a/videos",
    "https://youtube.com/@channel_a?si=track",
    "youtube.com/@channel_a",
  ];

  const ids = new Set<string>();
  for (const url of variants) {
    const result = await resolver.resolve({ venueName: "YouTube", venueUrl: url });
    assert.ok(result, `should resolve for ${url}`);
    ids.add(result!.venue.id);
  }

  assert.equal(ids.size, 1, "all URL variants should resolve to the same venue id");

  const venuesRows = await db.select().from(schema.venues);
  assert.equal(venuesRows.length, 1, "only one venue row should be created across all variants");
});

// ---- Edge: ignored names propagate ----

test("returns null when the venue name matches an ignored venue (no URL)", async () => {
  const db = createTestDb();
  const resolver = new VenueResolver(db as any);
  const now = new Date();

  // Pre-seed an ignored venue named "online".
  db.insert(schema.venues).values({
    id: "ignored-1",
    name: "online",
    kind: "unknown",
    status: "ignored",
    createdAt: now,
    updatedAt: now,
  }).run();

  const result = await resolver.resolve({ venueName: "online", venueUrl: null });
  assert.equal(result, null);
});
