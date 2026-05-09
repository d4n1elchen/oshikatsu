import { aliasedTable, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import {
  artists,
  eventResolutionDecisions,
  extractedEvents,
  normalizedEvents,
  venues,
} from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ListReviewQueueOptions = {
  /** Default 100. */
  limit?: number;
};

export type ReviewQueueItem = {
  decisionId: string;
  decision: string;
  score: number | null;
  signals: Record<string, unknown>;
  reason: string;
  createdAt: Date;

  // Candidate (extracted event being reviewed)
  extractedId: string;
  candidateTitle: string;
  candidateDescription: string;
  candidateStartTime: Date | null;
  candidateAuthor: string;
  candidateSourceUrl: string;
  candidateRawContent: string;
  candidateScope: string;
  candidateParentHint: string | null;
  candidateArtistName: string | null;
  candidateVenueName: string | null;

  // Matched normalized event (null when decision was made without a candidate)
  matchedId: string | null;
  matchedTitle: string | null;
  matchedStartTime: Date | null;
  matchedVenueName: string | null;
};

/**
 * List `needs_review` resolution decisions joined with their candidate
 * extracted event, the candidate's artist/venue, and the matched
 * normalized event (if any) plus its venue. Single statement, no N+1.
 */
export async function listReviewQueue(
  opts: ListReviewQueueOptions = {},
  dbi: DbInstance = defaultDb
): Promise<ReviewQueueItem[]> {
  const limit = opts.limit ?? 100;

  const candidateVenue = aliasedTable(venues, "candidate_venue");
  const matchedVenue = aliasedTable(venues, "matched_venue");

  const rows = await dbi
    .select({
      decisionId: eventResolutionDecisions.id,
      decision: eventResolutionDecisions.decision,
      score: eventResolutionDecisions.score,
      signals: eventResolutionDecisions.signals,
      reason: eventResolutionDecisions.reason,
      createdAt: eventResolutionDecisions.createdAt,

      extractedId: extractedEvents.id,
      candidateTitle: extractedEvents.title,
      candidateDescription: extractedEvents.description,
      candidateStartTime: extractedEvents.startTime,
      candidateAuthor: extractedEvents.author,
      candidateSourceUrl: extractedEvents.sourceUrl,
      candidateRawContent: extractedEvents.rawContent,
      candidateScope: extractedEvents.eventScope,
      candidateParentHint: extractedEvents.parentEventHint,
      candidateArtistName: artists.name,
      candidateVenueExtracted: extractedEvents.venueName,
      candidateVenueCanonical: candidateVenue.name,

      matchedId: normalizedEvents.id,
      matchedTitle: normalizedEvents.title,
      matchedStartTime: normalizedEvents.startTime,
      matchedVenueExtracted: normalizedEvents.venueName,
      matchedVenueCanonical: matchedVenue.name,
    })
    .from(eventResolutionDecisions)
    .innerJoin(extractedEvents, eq(eventResolutionDecisions.candidateExtractedEventId, extractedEvents.id))
    .leftJoin(artists, eq(extractedEvents.artistId, artists.id))
    .leftJoin(candidateVenue, eq(extractedEvents.venueId, candidateVenue.id))
    .leftJoin(normalizedEvents, eq(eventResolutionDecisions.matchedNormalizedEventId, normalizedEvents.id))
    .leftJoin(matchedVenue, eq(normalizedEvents.venueId, matchedVenue.id))
    .where(eq(eventResolutionDecisions.decision, "needs_review"))
    .orderBy(desc(eventResolutionDecisions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    decisionId: r.decisionId,
    decision: r.decision,
    score: r.score,
    signals: (r.signals as Record<string, unknown>) ?? {},
    reason: r.reason,
    createdAt: r.createdAt,

    extractedId: r.extractedId,
    candidateTitle: r.candidateTitle,
    candidateDescription: r.candidateDescription,
    candidateStartTime: r.candidateStartTime,
    candidateAuthor: r.candidateAuthor,
    candidateSourceUrl: r.candidateSourceUrl,
    candidateRawContent: r.candidateRawContent,
    candidateScope: r.candidateScope,
    candidateParentHint: r.candidateParentHint,
    candidateArtistName: r.candidateArtistName,
    candidateVenueName: r.candidateVenueCanonical ?? r.candidateVenueExtracted ?? null,

    matchedId: r.matchedId,
    matchedTitle: r.matchedTitle,
    matchedStartTime: r.matchedStartTime,
    matchedVenueName: r.matchedVenueCanonical ?? r.matchedVenueExtracted ?? null,
  }));
}
