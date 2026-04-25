import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const venues = sqliteTable("venues", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["physical", "virtual", "unknown"] }).notNull().default("unknown"),
  status: text("status", { enum: ["discovered", "verified", "ignored"] }).notNull().default("discovered"),
  url: text("url"),
  address: text("address"),
  city: text("city"),
  region: text("region"),
  country: text("country"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_venues_name").on(table.name),
  index("idx_venues_url").on(table.url),
  index("idx_venues_kind").on(table.kind),
  index("idx_venues_status").on(table.status),
]);

export const venueAliases = sqliteTable("venue_aliases", {
  id: text("id").primaryKey(),
  venueId: text("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  locale: text("locale"),
  source: text("source"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_venue_alias_dedup").on(table.venueId, table.alias),
  index("idx_venue_alias").on(table.alias),
]);

export const normalizedEvents = sqliteTable("normalized_events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  eventTime: integer("event_time", { mode: "timestamp" }).notNull(),
  venueId: text("venue_id").references(() => venues.id, { onDelete: "set null" }),
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
  venueName: text("venue_name"),
  venueUrl: text("venue_url"),
  rawContent: text("raw_content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
