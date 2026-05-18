/**
 * Integration tests for ExtractionEngine.processItem.
 *
 * Uses an in-memory SQLite + a fake LLMProvider so the round trip can be
 * exercised without hitting Ollama or the on-disk database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { z, type ZodType } from "zod";
import * as schema from "../../db/schema";
import { ExtractionEngine } from "../ExtractionEngine";
import { RawStorage } from "../RawStorage";
import type { LLMProvider } from "../LLMProvider";
import type { EventExtractionResult, ExtractionOutput, SingleEventResult } from "../ExtractionStrategy";

// ---- in-memory DB ----

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE artists (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      categories TEXT NOT NULL, groups TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE watch_targets (
      id TEXT PRIMARY KEY, artist_id TEXT NOT NULL,
      platform TEXT NOT NULL, source_type TEXT NOT NULL,
      source_config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE raw_items (
      id TEXT PRIMARY KEY, watch_target_id TEXT NOT NULL,
      source_name TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
      source_url TEXT, raw_data TEXT NOT NULL, posted_at INTEGER, fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', error_message TEXT,
      error_class TEXT, not_an_event_category TEXT
    );
    CREATE TABLE venues (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'discovered',
      url TEXT, address TEXT, city TEXT, region TEXT, country TEXT,
      latitude REAL, longitude REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE venue_aliases (
      id TEXT PRIMARY KEY, venue_id TEXT NOT NULL,
      alias TEXT NOT NULL, locale TEXT, source TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(venue_id, alias)
    );
    CREATE TABLE extracted_events (
      id TEXT PRIMARY KEY, raw_item_id TEXT NOT NULL UNIQUE,
      artist_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
      start_time INTEGER, end_time INTEGER,
      venue_id TEXT, venue_name TEXT, venue_url TEXT,
      type TEXT NOT NULL,
      record_kind TEXT NOT NULL DEFAULT 'event',
      event_scope TEXT NOT NULL DEFAULT 'unknown',
      parent_event_hint TEXT,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
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
  `);

  return db;
}

// ---- helpers ----

type TestDb = ReturnType<typeof createTestDb>;
const NOW = new Date("2025-06-01T12:00:00Z");

class FakeLLM implements LLMProvider {
  constructor(private behavior: () => Promise<ExtractionOutput> | ExtractionOutput) {}
  async extract<T>(_text: string, _schema: ZodType<T>, _systemPrompt: string): Promise<T> {
    return (await this.behavior()) as unknown as T;
  }
}

function insertRawTwitterItem(db: TestDb, opts: {
  id?: string;
  sourceId?: string;
  watchTargetId?: string;
  fullText?: string;
  screenName?: string;
  urls?: Array<{ url: string; expanded_url: string }>;
} = {}): string {
  const sourceId = opts.sourceId ?? "1234567890";
  const id = opts.id ?? `twitter_${sourceId}`;
  const rawData = {
    rest_id: sourceId,
    core: {
      user_results: {
        result: {
          legacy: { screen_name: opts.screenName ?? "test_user" },
        },
      },
    },
    legacy: {
      full_text: opts.fullText ?? "Tokyo Dome live tonight!",
      created_at: "Wed Apr 23 10:00:00 +0000 2025",
      entities: { urls: opts.urls ?? [] },
    },
  };

  db.insert(schema.rawItems).values({
    id,
    watchTargetId: opts.watchTargetId ?? "wt-1",
    sourceName: "twitter",
    sourceId,
    rawData,
    fetchedAt: NOW,
    status: "new",
  }).run();

  return id;
}

function defaultExtraction(overrides: Partial<SingleEventResult> = {}): EventExtractionResult {
  // Most existing tests pass per-event overrides (title, venue_name, etc.).
  // Keep that ergonomics by wrapping the single event into the array shape
  // the LLM contract now expects. Tests that need true multi-event output
  // construct the array literal themselves.
  return {
    kind: "event",
    events: [{
      title: "Tokyo Dome Concert",
      description: "Live show tonight",
      type: "concert",
      event_scope: "main",
      related_links: [],
      tags: [],
      ...overrides,
    }],
  };
}

// ---- 1. Twitter strategy round-trip persistence ----

test("processItem extracts a Twitter item and persists it with source provenance", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db, {
    sourceId: "111",
    fullText: "Tokyo Dome tonight!",
    screenName: "artist_official",
  });

  const llm = new FakeLLM(() => defaultExtraction());
  const engine = new ExtractionEngine(llm, { db: db as any });

  const item = await db
    .select()
    .from(schema.rawItems)
    .where(eq(schema.rawItems.id, id))
    .then((r) => r[0]!);

  const ok = await engine.processItem(item);
  assert.equal(ok, true);

  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.rawItemId, id);
  assert.equal(ev.title, "Tokyo Dome Concert");
  assert.equal(ev.author, "artist_official");
  assert.equal(ev.sourceUrl, "https://x.com/artist_official/status/111");
  assert.equal(ev.rawContent, "Tokyo Dome tonight!");

  // Raw item is marked processed.
  const updated = await db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id));
  assert.equal(updated[0]!.status, "processed");
});

// ---- 2. Related link extraction and persistence ----

test("related_links from the LLM and from the t.co entities both persist", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db, {
    urls: [{ url: "https://t.co/x", expanded_url: "https://event.com/from-context" }],
  });

  const llm = new FakeLLM(() =>
    defaultExtraction({
      related_links: [{ url: "https://example.com/from-llm" }],
    })
  );
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  await engine.processItem(item);

  const links = await db.select().from(schema.extractedEventRelatedLinks);
  const urls = new Set(links.map((l) => l.url));
  assert.ok(urls.has("https://example.com/from-llm"));
  assert.ok(urls.has("https://event.com/from-context"));
  assert.equal(links.length, 2);
});

test("duplicate URLs are deduped on persistence (via unique index)", async () => {
  const db = createTestDb();
  insertRawTwitterItem(db, {
    urls: [{ url: "https://t.co/x", expanded_url: "https://event.com/same" }],
  });

  const llm = new FakeLLM(() =>
    defaultExtraction({
      related_links: [{ url: "https://event.com/same" }, { url: "https://event.com/same" }],
    })
  );
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  await engine.processItem(item);

  const links = await db.select().from(schema.extractedEventRelatedLinks);
  assert.equal(links.length, 1, "URL should appear only once across LLM + context dedup");
});

// ---- 3. LLM failure marks raw item as 'error' ----

test("LLM failure marks the raw item as 'error' with the error message", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db);

  const llm = new FakeLLM(() => {
    throw new Error("ollama is down");
  });
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  const ok = await engine.processItem(item);
  assert.equal(ok, false);

  const updated = await db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id));
  assert.equal(updated[0]!.status, "error");
  assert.match(updated[0]!.errorMessage ?? "", /ollama is down/);
  assert.equal(updated[0]!.errorClass, "Error", "error_class is captured from error.name");

  // No extracted event created.
  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events.length, 0);
});

test("typed error names are captured into raw_items.error_class", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db);

  class LLMTimeoutError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "LLMTimeoutError";
    }
  }

  const llm = new FakeLLM(() => {
    throw new LLMTimeoutError("ollama hung");
  });
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;
  await engine.processItem(item);

  const updated = await db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id));
  assert.equal(updated[0]!.errorClass, "LLMTimeoutError");
});

test("sanitization failure (empty title) also marks raw item as 'error'", async () => {
  const db = createTestDb();
  insertRawTwitterItem(db);

  const llm = new FakeLLM(() => defaultExtraction({ title: "   " }));
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  const ok = await engine.processItem(item);
  assert.equal(ok, false);

  const updated = await db.select().from(schema.rawItems);
  assert.equal(updated[0]!.status, "error");
});

// ---- 4. Idempotency: raw item already has an extracted event ----

test("processing a raw item that already has an extracted event is a no-op", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db);

  let llmCalls = 0;
  const llm = new FakeLLM(() => {
    llmCalls++;
    return defaultExtraction();
  });
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  // First pass — extracts.
  await engine.processItem(item);
  assert.equal(llmCalls, 1);

  // Reset raw item back to 'new' to simulate a re-run scenario.
  const storage = new RawStorage(db as any);
  await storage.markNew(id);

  // Second pass — short-circuits via hasExistingExtraction; LLM is NOT called.
  const item2 = (await db.select().from(schema.rawItems))[0]!;
  const ok = await engine.processItem(item2);
  assert.equal(ok, true);
  assert.equal(llmCalls, 1, "LLM should not be called when extraction already exists");

  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events.length, 1, "no duplicate extracted event");

  // Raw item is marked processed again.
  const updated = await db.select().from(schema.rawItems);
  assert.equal(updated[0]!.status, "processed");
});

// ---- 5. Database persistence consistency between events and links ----

test("extracted event row and related_links share the same extracted_event_id", async () => {
  const db = createTestDb();
  insertRawTwitterItem(db);

  const llm = new FakeLLM(() =>
    defaultExtraction({
      related_links: [
        { url: "https://event.com/a", title: "Tickets" },
        { url: "https://event.com/b" },
      ],
    })
  );
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  await engine.processItem(item);

  const events = await db.select().from(schema.extractedEvents);
  const links = await db.select().from(schema.extractedEventRelatedLinks);
  assert.equal(events.length, 1);
  assert.equal(links.length, 2);

  for (const link of links) {
    assert.equal(link.extractedEventId, events[0]!.id, "every link references the extracted event");
    assert.equal(link.rawItemId, events[0]!.rawItemId, "every link references the source raw item");
  }
});

test("artist_id is populated when the raw item's watch target has an artist", async () => {
  const db = createTestDb();
  // Seed an artist + watch target.
  db.insert(schema.artists).values({
    id: "artist-1",
    handle: "artist-1",
    name: "Test Artist",
    categories: [],
    groups: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  db.insert(schema.watchTargets).values({
    id: "wt-1",
    artistId: "artist-1",
    platform: "twitter",
    sourceType: "user",
    sourceConfig: { username: "test_user" },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();

  insertRawTwitterItem(db, { watchTargetId: "wt-1" });

  const llm = new FakeLLM(() => defaultExtraction());
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;
  await engine.processItem(item);

  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events[0]!.artistId, "artist-1");
});

// ---- 6. Bonus: venue resolution integrates ----

test("venue is auto-discovered when extraction provides venue_name + venue_url", async () => {
  const db = createTestDb();
  insertRawTwitterItem(db);

  const llm = new FakeLLM(() =>
    defaultExtraction({
      venue_name: "Tokyo Dome",
      venue_url: "https://tokyo-dome.co.jp/",
    })
  );
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;
  await engine.processItem(item);

  const venues = await db.select().from(schema.venues);
  assert.equal(venues.length, 1);
  assert.equal(venues[0]!.name, "Tokyo Dome");

  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events[0]!.venueId, venues[0]!.id);
  assert.equal(events[0]!.venueName, "Tokyo Dome");
});

test("venue is NOT auto-created when extraction has bare 'YouTube' name and no URL", async () => {
  const db = createTestDb();
  insertRawTwitterItem(db);

  const llm = new FakeLLM(() =>
    defaultExtraction({
      venue_name: "YouTube",
      venue_url: undefined,
    })
  );
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;
  await engine.processItem(item);

  const venues = await db.select().from(schema.venues);
  assert.equal(venues.length, 0, "virtual platform name without URL should not create a venue");

  // Extracted event still saves; venueId is null but the original venue_name text is preserved.
  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events[0]!.venueId, null);
  assert.equal(events[0]!.venueName, "YouTube");
});

// ---- 7. Annotation and orphan classification ----

test("annotation response writes an extracted_events row with record_kind='annotation' and parent_event_hint", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db);

  const llm = new FakeLLM(() => ({
    kind: "annotation" as const,
    category: "milestone" as const,
    title: "1M streams milestone",
    description: "Post celebrates the song crossing 1M streams.",
    parent_event_hint: "放課後ボーダーライン",
    related_links: [],
    tags: ["streaming"],
  }));
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  const ok = await engine.processItem(item);
  assert.equal(ok, true);

  const records = await db.select().from(schema.extractedEvents);
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal((r as any).recordKind, "annotation");
  assert.equal(r.type, "milestone", "annotation category lives in `type` and is disambiguated by record_kind");
  assert.equal(r.parentEventHint, "放課後ボーダーライン");
  assert.equal(r.startTime, null);
  assert.equal(r.endTime, null);
  assert.equal(r.venueId, null);

  const updated = await db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id));
  assert.equal(updated[0]!.status, "processed");
});

test("not_an_event response moves the raw item to status='not_an_event' without creating an extracted_events row", async () => {
  const db = createTestDb();
  const id = insertRawTwitterItem(db);

  const llm = new FakeLLM(() => ({
    kind: "not_an_event" as const,
    category: "mood" as const,
    reason: "morning greeting, no activity announced",
  }));
  const engine = new ExtractionEngine(llm, { db: db as any });
  const item = (await db.select().from(schema.rawItems))[0]!;

  const ok = await engine.processItem(item);
  // processItem returns true on a deliberate non-event; counts as `processed`
  // in the batch summary, not as `failed`.
  assert.equal(ok, true);

  const events = await db.select().from(schema.extractedEvents);
  assert.equal(events.length, 0, "no extracted_events row for orphan posts");

  const updated = await db.select().from(schema.rawItems).where(eq(schema.rawItems.id, id));
  assert.equal(updated[0]!.status, "not_an_event");
  assert.equal(updated[0]!.errorClass, null);
  assert.match(updated[0]!.errorMessage ?? "", /morning greeting/);
});
