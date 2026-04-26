import { artists, watchTargets, rawItems, venues, venueAliases, preprocessedEvents, preprocessedEventRelatedLinks, sourceReferences } from "../db/schema";

// Extract TypeScript types directly from Drizzle schemas
export type Artist = typeof artists.$inferSelect;
export type WatchTarget = typeof watchTargets.$inferSelect;
export type RawItem = typeof rawItems.$inferSelect;

// Export insert types in case we need them for creation payloads
export type NewArtist = typeof artists.$inferInsert;
export type NewWatchTarget = typeof watchTargets.$inferInsert;
export type NewRawItem = typeof rawItems.$inferInsert;

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;

export type VenueAlias = typeof venueAliases.$inferSelect;
export type NewVenueAlias = typeof venueAliases.$inferInsert;

export type PreprocessedEvent = typeof preprocessedEvents.$inferSelect;
export type NewPreprocessedEvent = typeof preprocessedEvents.$inferInsert;

export type PreprocessedEventRelatedLink = typeof preprocessedEventRelatedLinks.$inferSelect;
export type NewPreprocessedEventRelatedLink = typeof preprocessedEventRelatedLinks.$inferInsert;

export type SourceReference = typeof sourceReferences.$inferSelect;
export type NewSourceReference = typeof sourceReferences.$inferInsert;
