/**
 * Round-trip tests for SchedulerRunsRepo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { SchedulerRunsRepo } from "../SchedulerRunsRepo";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE scheduler_runs (
      id TEXT PRIMARY KEY,
      task_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error_class TEXT,
      error_message TEXT,
      details TEXT
    );
  `);
  return db;
}

test("start + finish records a completed run with details", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const id = await repo.start("Ingestion", new Date("2026-04-26T10:00:00Z"));
  await repo.finish(id, "completed", { details: { processed: 7, failed: 1 } });

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.status, "completed");
  assert.deepEqual(rows[0]!.details, { processed: 7, failed: 1 });
});

test("finish('failed') captures error class, name, and message", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  class FooError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "FooError";
    }
  }

  const id = await repo.start("Test");
  await repo.finish(id, "failed", { error: new FooError("boom") });

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows[0]!.errorClass, "FooError");
  assert.match(rows[0]!.errorMessage ?? "", /boom/);
});

test("error_message is truncated to 1000 chars", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const longMsg = "x".repeat(2000);
  const id = await repo.start("Test");
  await repo.finish(id, "failed", { error: new Error(longMsg) });

  const rows = await db.select().from(schema.schedulerRuns);
  const stored = rows[0]!.errorMessage ?? "";
  assert.equal(stored.length, 1000);
  assert.ok(stored.endsWith("…"));
});

test("recent() returns runs newest first", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const idA = await repo.start("Ingestion", new Date("2026-04-26T10:00:00Z"));
  await repo.finish(idA, "completed");
  const idB = await repo.start("Extraction", new Date("2026-04-26T10:01:00Z"));
  await repo.finish(idB, "completed");

  const recent = await repo.recent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.taskName, "Extraction");
  assert.equal(recent[1]!.taskName, "Ingestion");
});

test("recentForTask() filters by task name", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const idA = await repo.start("Ingestion", new Date("2026-04-26T10:00:00Z"));
  await repo.finish(idA, "completed");
  const idB = await repo.start("Extraction", new Date("2026-04-26T10:01:00Z"));
  await repo.finish(idB, "completed");

  const ingestion = await repo.recentForTask("Ingestion");
  assert.equal(ingestion.length, 1);
  assert.equal(ingestion[0]!.taskName, "Ingestion");
});

test("deleteOlderThan() prunes ancient runs and returns count", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const old = await repo.start("Old", new Date("2025-01-01T00:00:00Z"));
  await repo.finish(old, "completed");
  const recent = await repo.start("Recent", new Date());
  await repo.finish(recent, "completed");

  const deleted = await repo.deleteOlderThan(new Date("2025-06-01T00:00:00Z"));
  assert.equal(deleted, 1);

  const remaining = await db.select().from(schema.schedulerRuns);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.taskName, "Recent");
});

test("countsSince() groups by (task, status)", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const ago = new Date(Date.now() - 30 * 60 * 1000);
  const a = await repo.start("Ingestion", ago);
  await repo.finish(a, "completed");
  const b = await repo.start("Ingestion", new Date());
  await repo.finish(b, "failed", { error: new Error("e") });
  const c = await repo.start("Extraction", new Date());
  await repo.finish(c, "completed");

  const counts = await repo.countsSince(new Date(Date.now() - 60 * 60 * 1000));
  const ingestionCompleted = counts.find((c) => c.taskName === "Ingestion" && c.status === "completed");
  const ingestionFailed = counts.find((c) => c.taskName === "Ingestion" && c.status === "failed");
  const extractionCompleted = counts.find((c) => c.taskName === "Extraction" && c.status === "completed");
  assert.equal(ingestionCompleted?.count, 1);
  assert.equal(ingestionFailed?.count, 1);
  assert.equal(extractionCompleted?.count, 1);
});
