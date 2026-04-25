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

export const watchTargets = sqliteTable("watch_targets", {
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
  watchTargetId: text("watch_target_id").notNull().references(() => watchTargets.id, { onDelete: "cascade" }),
  sourceName: text("source_name").notNull(),
  sourceId: text("source_id").notNull(),
  rawData: text("raw_data", { mode: "json" }).$type<Record<string, any>>().notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
  status: text("status", { enum: ["new", "processed", "error"] }).notNull().default("new"),
  errorMessage: text("error_message"),
}, (table) => [
  uniqueIndex("idx_source_dedup").on(table.sourceName, table.sourceId),
]);

export const normalizedEvents = sqliteTable("normalized_events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  eventTime: integer("event_time", { mode: "timestamp" }).notNull(),
  venueName: text("venue_name"),
  venueUrl: text("venue_url"),
  type: text("type").notNull(),
  isCancelled: integer("is_cancelled", { mode: "boolean" }).notNull().default(false),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const eventRelatedLinks = sqliteTable("event_related_links", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => normalizedEvents.id, { onDelete: "cascade" }),
  rawItemId: text("raw_item_id").references(() => rawItems.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_event_related_link_dedup").on(table.eventId, table.url),
]);

export const sourceReferences = sqliteTable("source_references", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => normalizedEvents.id, { onDelete: "cascade" }),
  rawItemId: text("raw_item_id").notNull().references(() => rawItems.id, { onDelete: "cascade" }),
  sourceName: text("source_name").notNull(),
  sourceId: text("source_id").notNull(),
  publishTime: integer("publish_time", { mode: "timestamp" }).notNull(),
  url: text("url").notNull(),
  author: text("author").notNull(),
  rawContent: text("raw_content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
