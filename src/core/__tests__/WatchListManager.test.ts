/**
 * Handle-related behavior on WatchListManager: required, validated, unique.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import {
  HandleInUseError,
  InvalidHandleError,
  WatchListManager,
} from "../WatchListManager";

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
    CREATE TABLE watch_targets (
      id TEXT PRIMARY KEY, artist_id TEXT NOT NULL,
      platform TEXT NOT NULL, source_type TEXT NOT NULL,
      source_config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

test("addArtist persists the supplied handle", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);

  const a = await wlm.addArtist("嵐", "arashi");
  assert.equal(a.handle, "arashi");
  assert.equal(a.name, "嵐");

  const rows = await db.select().from(schema.artists);
  assert.equal(rows[0]!.handle, "arashi");
});

test("addArtist rejects an invalid handle", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);

  await assert.rejects(wlm.addArtist("Foo", "bad name"), InvalidHandleError);
  await assert.rejects(wlm.addArtist("Foo", ""), InvalidHandleError);
  await assert.rejects(wlm.addArtist("Foo", "a/b"), InvalidHandleError);
});

test("addArtist rejects a duplicate handle", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);

  await wlm.addArtist("嵐", "arashi");
  await assert.rejects(wlm.addArtist("Different Artist", "arashi"), HandleInUseError);
});

test("updateArtist can change the handle to a new unique value", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);

  const a = await wlm.addArtist("嵐", "arashi");
  await wlm.updateArtist(a.id, { handle: "arashi-jp" });

  const [row] = await db.select().from(schema.artists);
  assert.equal(row!.handle, "arashi-jp");
});

test("updateArtist rejects taking another artist's handle", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);

  const a = await wlm.addArtist("嵐", "arashi");
  await wlm.addArtist("乃木坂46", "nogizaka46");

  await assert.rejects(wlm.updateArtist(a.id, { handle: "nogizaka46" }), HandleInUseError);
});

test("updateArtist with the same handle is a no-op for the handle field", async () => {
  const db = createTestDb();
  const wlm = new WatchListManager(db as any);
  const a = await wlm.addArtist("嵐", "arashi");
  await wlm.updateArtist(a.id, { handle: "arashi", name: "嵐 (renamed)" });

  const [row] = await db.select().from(schema.artists);
  assert.equal(row!.handle, "arashi");
  assert.equal(row!.name, "嵐 (renamed)");
});
