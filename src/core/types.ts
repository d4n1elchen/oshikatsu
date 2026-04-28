import { artists, watchTargets, rawItems, venues, venueAliases, extractedEvents, extractedEventRelatedLinks, normalizedEvents, normalizedEventSources, eventResolutionDecisions, schedulerRuns } from "../db/schema";

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

export type ExtractedEvent = typeof extractedEvents.$inferSelect;
export type NewExtractedEvent = typeof extractedEvents.$inferInsert;

export type ExtractedEventRelatedLink = typeof extractedEventRelatedLinks.$inferSelect;
export type NewExtractedEventRelatedLink = typeof extractedEventRelatedLinks.$inferInsert;

export type NormalizedEvent = typeof normalizedEvents.$inferSelect;
export type NewNormalizedEvent = typeof normalizedEvents.$inferInsert;

export type NormalizedEventSource = typeof normalizedEventSources.$inferSelect;
export type NewNormalizedEventSource = typeof normalizedEventSources.$inferInsert;

export type EventResolutionDecision = typeof eventResolutionDecisions.$inferSelect;
export type NewEventResolutionDecision = typeof eventResolutionDecisions.$inferInsert;

export type ResolutionDecisionType = "new" | "merged" | "linked_as_sub" | "needs_review" | "no_match" | "ignored";

export type ResolutionSignals = {
  time_window?: string;
  related_link_overlap?: boolean;
  venue_id_match?: boolean;
  title_similarity?: number;
  source_identity_overlap?: boolean;
  event_scope?: string;
  parent_event_hint_matched?: boolean;
  same_source_url?: boolean;
  same_source_id?: boolean;
  manual_override?: boolean;
};

export type SchedulerRun = typeof schedulerRuns.$inferSelect;
export type NewSchedulerRun = typeof schedulerRuns.$inferInsert;
export type SchedulerRunStatus = "running" | "completed" | "failed" | "aborted";
export type RunDetails = Record<string, unknown>;
