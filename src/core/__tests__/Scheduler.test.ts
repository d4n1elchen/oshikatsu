/**
 * Tests for the generic Scheduler — focused on AbortSignal-driven graceful
 * shutdown and scheduler_runs persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { Scheduler } from "../Scheduler";
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

function makeRepo() {
  return new SchedulerRunsRepo(createTestDb() as any);
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---- AbortSignal-driven shutdown ----

test("stop() aborts the in-flight task signal", async () => {
  const observed = deferred<AbortSignal>();
  const finished = deferred<void>();

  const scheduler = new Scheduler(makeRepo()).add({
    name: "Test",
    intervalMinutes: 60,
    run: async (signal) => {
      observed.resolve(signal);
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      finished.resolve();
    },
  });

  scheduler.start();
  const signal = await observed.promise;
  assert.equal(signal.aborted, false);

  await scheduler.stop();
  assert.equal(signal.aborted, true);
  await finished.promise;
});

test("stop() awaits the in-flight task to drain", async () => {
  const drained = { yes: false };
  const started = deferred<void>();

  const scheduler = new Scheduler(makeRepo()).add({
    name: "Test",
    intervalMinutes: 60,
    run: async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            drained.yes = true;
            resolve();
          }, 50);
        }, { once: true });
      });
    },
  });

  scheduler.start();
  await started.promise;

  await scheduler.stop();
  assert.equal(drained.yes, true);
});

test("add() throws after start()", () => {
  const scheduler = new Scheduler(makeRepo()).add({
    name: "First",
    intervalMinutes: 60,
    run: async () => {},
  });
  scheduler.start();

  assert.throws(() =>
    scheduler.add({ name: "Late", intervalMinutes: 60, run: async () => {} })
  );

  return scheduler.stop();
});

// ---- scheduler_runs persistence ----

test("a successful run writes one completed scheduler_runs row with returned details", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);
  const scheduler = new Scheduler(repo).add({
    name: "Successful",
    intervalMinutes: 60,
    run: async () => ({ processed: 5, failed: 0 }),
  });

  scheduler.start();
  // Give it a tick to complete.
  await new Promise((r) => setTimeout(r, 50));
  await scheduler.stop();

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.taskName, "Successful");
  assert.equal(rows[0]!.status, "completed");
  assert.deepEqual(rows[0]!.details, { processed: 5, failed: 0 });
  assert.equal(rows[0]!.errorClass, null);
});

test("a thrown Error writes status='failed' with error_class and error_message", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  class CustomError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "CustomError";
    }
  }

  const scheduler = new Scheduler(repo).add({
    name: "Failing",
    intervalMinutes: 60,
    run: async () => {
      throw new CustomError("something went wrong");
    },
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 50));
  await scheduler.stop();

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows[0]!.errorClass, "CustomError");
  assert.match(rows[0]!.errorMessage ?? "", /something went wrong/);
});

test("an aborted run writes status='aborted' with no error_class", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const scheduler = new Scheduler(repo).add({
    name: "Aborted",
    intervalMinutes: 60,
    run: async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    },
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 10));
  await scheduler.stop();

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "aborted");
  assert.equal(rows[0]!.errorClass, null);
});

test("a task returning void still gets a row with details=null", async () => {
  const db = createTestDb();
  const repo = new SchedulerRunsRepo(db as any);

  const scheduler = new Scheduler(repo).add({
    name: "VoidReturn",
    intervalMinutes: 60,
    run: async () => {},
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 50));
  await scheduler.stop();

  const rows = await db.select().from(schema.schedulerRuns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "completed");
  assert.equal(rows[0]!.details, null);
});
