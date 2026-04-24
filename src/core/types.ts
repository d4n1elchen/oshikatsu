import { artists, watchTargets, rawItems } from "../db/schema";

// Extract TypeScript types directly from Drizzle schemas
export type Artist = typeof artists.$inferSelect;
export type WatchTarget = typeof watchTargets.$inferSelect;
export type RawItem = typeof rawItems.$inferSelect;

// Export insert types in case we need them for creation payloads
export type NewArtist = typeof artists.$inferInsert;
export type NewWatchTarget = typeof watchTargets.$inferInsert;
export type NewRawItem = typeof rawItems.$inferInsert;
