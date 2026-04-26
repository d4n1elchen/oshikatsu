import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { getConfig } from "../config";
import * as schema from "./schema";

const config = getConfig();
const sqlite = new Database(config.paths.database);

// WAL mode lets readers and writers proceed concurrently, which matters now
// that we run three loops (ingest/extract/resolve) against the same file.
// better-sqlite3's default 5s busy_timeout handles transient lock contention.
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");

export const db = drizzle(sqlite, { schema });
