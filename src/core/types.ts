import { artists, watchTargets, rawItems, venues, venueAliases, extractedEvents, extractedEventRelatedLinks, normalizedEvents, normalizedEventSources, eventResolutionDecisions, schedulerRuns, exportQueue, exportCursors } from "../db/schema";

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

export type ExportQueueEntry = typeof exportQueue.$inferSelect;
export type NewExportQueueEntry = typeof exportQueue.$inferInsert;
export type ExportChangeType = "created" | "updated" | "cancelled";

export type ExportCursor = typeof exportCursors.$inferSelect;
export type NewExportCursor = typeof exportCursors.$inferInsert;

/**
 * Consumer-facing projection of a canonical event. Plain-serializable: this
 * shape crosses any boundary (process, network, language) cleanly, which is a
 * deliberate choice for forward-compatibility with a future plugin system.
 *
 * Additive evolution only — never remove or rename a field. Consumers may
 * ignore fields they don't care about.
 */
export type ExportRecord = {
  id: string;
  version: number;
  changeType: ExportChangeType;
  parentId: string | null;
  artist: { id: string; name: string } | null;
  title: string;
  description: string;
  startTime: string | null;
  endTime: string | null;
  venue: {
    id: string | null;
    name: string | null;
    url: string | null;
  };
  type: string;
  isCancelled: boolean;
  tags: string[];
  sources: {
    sourceUrl: string;
    publishTime: string;
    author: string;
  }[];
  emittedAt: string;
};

export type DeliveryResult = {
  /** IDs the consumer durably accepted; cursor advances past these. */
  delivered: string[];
  /** IDs the consumer rejected permanently (will not be retried). */
  rejected?: { id: string; reason: string }[];
  /** IDs the consumer wants retried next tick. Anything not in delivered/rejected is implicitly retried. */
  retry?: string[];
};
