import { artists, sourceEntries, rawItems } from "../db/schema";

// Extract TypeScript types directly from Drizzle schemas
export type Artist = typeof artists.$inferSelect;
export type SourceEntry = typeof sourceEntries.$inferSelect;
export type RawItem = typeof rawItems.$inferSelect;

// Export insert types in case we need them for creation payloads
export type NewArtist = typeof artists.$inferInsert;
export type NewSourceEntry = typeof sourceEntries.$inferInsert;
export type NewRawItem = typeof rawItems.$inferInsert;
