import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const artists = sqliteTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  categories: text("categories", { mode: "json" }).$type<string[]>().notNull(),
  groups: text("groups", { mode: "json" }).$type<string[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const sourceEntries = sqliteTable("source_entries", {
  id: text("id").primaryKey(),
  artistId: text("artist_id").notNull().references(() => artists.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  sourceType: text("source_type").notNull(),
  sourceConfig: text("source_config", { mode: "json" }).$type<Record<string, any>>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const rawItems = sqliteTable("raw_items", {
  id: text("id").primaryKey(),
  sourceEntryId: text("source_entry_id").notNull().references(() => sourceEntries.id, { onDelete: "cascade" }),
  sourceName: text("source_name").notNull(),
  sourceId: text("source_id").notNull(),
  rawData: text("raw_data", { mode: "json" }).$type<Record<string, any>>().notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
  status: text("status", { enum: ["new", "processed", "error"] }).notNull().default("new"),
  errorMessage: text("error_message"),
}, (table) => [
  uniqueIndex("idx_source_dedup").on(table.sourceName, table.sourceId),
]);
