import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { getConfig } from "../config";
import * as schema from "./schema";

const config = getConfig();
const sqlite = new Database(config.paths.database);
export const db = drizzle(sqlite, { schema });
