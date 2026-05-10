import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../db/schema";
import { getExtractionFailureSummary } from "../MonitorQueries";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
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
      error_class TEXT
    );
  `);
  return db;
}

async function insertItem(
  db: ReturnType<typeof createTestDb>,
  args: { id: string; status: "new" | "processed" | "error"; errorClass: string | null; fetchedAt: Date }
) {
  await db.insert(schema.rawItems).values({
    id: args.id,
    watchTargetId: "wt-1",
    sourceName: "twitter",
    sourceId: args.id,
    rawData: {},
    fetchedAt: args.fetchedAt,
    status: args.status,
    errorClass: args.errorClass,
    errorMessage: args.errorClass ? "boom" : null,
  });
}

test("returns empty summary when no errored rows exist", async () => {
  const db = createTestDb();
  await insertItem(db, { id: "ok-1", status: "processed", errorClass: null, fetchedAt: new Date() });

  const summary = await getExtractionFailureSummary(db as any);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.groups, []);
});

test("groups errored rows by error_class with count, oldest, newest", async () => {
  const db = createTestDb();
  const t1 = new Date("2026-04-01T10:00:00Z");
  const t2 = new Date("2026-04-02T10:00:00Z");
  const t3 = new Date("2026-04-03T10:00:00Z");

  await insertItem(db, { id: "a1", status: "error", errorClass: "ValidationError", fetchedAt: t1 });
  await insertItem(db, { id: "a2", status: "error", errorClass: "ValidationError", fetchedAt: t3 });
  await insertItem(db, { id: "a3", status: "error", errorClass: "ValidationError", fetchedAt: t2 });
  await insertItem(db, { id: "b1", status: "error", errorClass: "TimeoutError", fetchedAt: t2 });
  // non-error rows must be excluded
  await insertItem(db, { id: "ok", status: "processed", errorClass: null, fetchedAt: t1 });

  const summary = await getExtractionFailureSummary(db as any);
  assert.equal(summary.total, 4);
  assert.equal(summary.groups.length, 2);

  // Groups sorted by count desc — ValidationError (3) before TimeoutError (1)
  assert.equal(summary.groups[0]!.errorClass, "ValidationError");
  assert.equal(summary.groups[0]!.count, 3);
  assert.equal(summary.groups[0]!.oldest.getTime(), t1.getTime());
  assert.equal(summary.groups[0]!.newest.getTime(), t3.getTime());

  assert.equal(summary.groups[1]!.errorClass, "TimeoutError");
  assert.equal(summary.groups[1]!.count, 1);
  assert.equal(summary.groups[1]!.oldest.getTime(), t2.getTime());
  assert.equal(summary.groups[1]!.newest.getTime(), t2.getTime());
});

test("rows with null error_class are bucketed as 'Error'", async () => {
  const db = createTestDb();
  const t = new Date("2026-04-01T10:00:00Z");

  await insertItem(db, { id: "x1", status: "error", errorClass: null, fetchedAt: t });
  await insertItem(db, { id: "x2", status: "error", errorClass: null, fetchedAt: t });

  const summary = await getExtractionFailureSummary(db as any);
  assert.equal(summary.total, 2);
  assert.equal(summary.groups[0]!.errorClass, "Error");
  assert.equal(summary.groups[0]!.count, 2);
});
