import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import {
  artists,
  eventResolutionDecisions,
  normalizedEventSources,
  normalizedEvents,
  venues,
} from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ListNormalizedEventsOptions = {
  /** Default 50. */
  limit?: number;
  /** Filter to a specific artist. */
  artistId?: string;
  /** Default `"startTime"` (TUI). Web feed prefers `"updatedAt"`. */
  orderBy?: "startTime" | "updatedAt";
};

export type NormalizedEventVenue = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export type NormalizedEventListItem = {
  id: string;
  title: string;
  description: string;
  type: string;
  tags: string[];
  isCancelled: boolean;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
  updatedAt: Date;

  artistId: string | null;
  artistName: string | null;

  venueId: string | null;
  venueName: string | null;
  venueUrl: string | null;
  venue: NormalizedEventVenue | null;

  parentEventId: string | null;
  parentTitle: string | null;
  subEventCount: number;

  sourceCount: number;
  latestDecision: string | null;
  latestReason: string | null;
};

/**
 * List canonical normalized events with artist, venue, parent title,
 * sub-event count, source count, and the primary-source resolution
 * decision. Constant number of queries regardless of result size —
 * replaces the per-row N+1 the TUI used to do.
 */
export async function listNormalizedEvents(
  opts: ListNormalizedEventsOptions = {},
  dbi: DbInstance = defaultDb
): Promise<NormalizedEventListItem[]> {
  const limit = opts.limit ?? 50;
  const orderColumn =
    opts.orderBy === "updatedAt" ? normalizedEvents.updatedAt : normalizedEvents.startTime;

  const whereClause = opts.artistId
    ? eq(normalizedEvents.artistId, opts.artistId)
    : undefined;

  // Outer + artist + venue. Parent titles are fetched separately to keep
  // type inference clean (drizzle's aliasedTable + leftJoin trips it).
  const rows = await dbi
    .select({
      id: normalizedEvents.id,
      title: normalizedEvents.title,
      description: normalizedEvents.description,
      type: normalizedEvents.type,
      tags: normalizedEvents.tags,
      isCancelled: normalizedEvents.isCancelled,
      startTime: normalizedEvents.startTime,
      endTime: normalizedEvents.endTime,
      createdAt: normalizedEvents.createdAt,
      updatedAt: normalizedEvents.updatedAt,

      artistId: normalizedEvents.artistId,
      artistName: artists.name,

      venueId: normalizedEvents.venueId,
      venueName: normalizedEvents.venueName,
      venueUrl: normalizedEvents.venueUrl,
      venueCanonicalId: venues.id,
      venueCanonicalName: venues.name,
      venueCanonicalKind: venues.kind,
      venueCanonicalStatus: venues.status,

      parentEventId: normalizedEvents.parentEventId,
    })
    .from(normalizedEvents)
    .leftJoin(artists, eq(normalizedEvents.artistId, artists.id))
    .leftJoin(venues, eq(normalizedEvents.venueId, venues.id))
    .where(whereClause)
    .orderBy(desc(orderColumn))
    .limit(limit);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const parentIds = Array.from(
    new Set(rows.map((r) => r.parentEventId).filter((x): x is string => !!x))
  );

  // Aggregate queries — keyed by event id, fetched once each.
  const [sourceCounts, subEventCounts, primaryDecisions, parentTitles] = await Promise.all([
    dbi
      .select({
        normalizedEventId: normalizedEventSources.normalizedEventId,
        cnt: count(),
      })
      .from(normalizedEventSources)
      .where(inArray(normalizedEventSources.normalizedEventId, ids))
      .groupBy(normalizedEventSources.normalizedEventId),

    dbi
      .select({
        parentEventId: normalizedEvents.parentEventId,
        cnt: count(),
      })
      .from(normalizedEvents)
      .where(inArray(normalizedEvents.parentEventId, ids))
      .groupBy(normalizedEvents.parentEventId),

    dbi
      .select({
        normalizedEventId: normalizedEventSources.normalizedEventId,
        decision: eventResolutionDecisions.decision,
        reason: eventResolutionDecisions.reason,
      })
      .from(normalizedEventSources)
      .innerJoin(
        eventResolutionDecisions,
        eq(normalizedEventSources.extractedEventId, eventResolutionDecisions.candidateExtractedEventId)
      )
      .where(
        and(
          inArray(normalizedEventSources.normalizedEventId, ids),
          eq(normalizedEventSources.role, "primary")
        )
      ),

    parentIds.length > 0
      ? dbi
          .select({ id: normalizedEvents.id, title: normalizedEvents.title })
          .from(normalizedEvents)
          .where(inArray(normalizedEvents.id, parentIds))
      : Promise.resolve([] as Array<{ id: string; title: string }>),
  ]);

  const sourceCountByEvent = new Map<string, number>();
  for (const r of sourceCounts) sourceCountByEvent.set(r.normalizedEventId, r.cnt);

  const subEventCountByParent = new Map<string, number>();
  for (const r of subEventCounts) {
    if (r.parentEventId) subEventCountByParent.set(r.parentEventId, r.cnt);
  }

  const decisionByEvent = new Map<string, { decision: string; reason: string }>();
  for (const r of primaryDecisions) {
    // First match wins. There's at most one primary per normalized event by design.
    if (!decisionByEvent.has(r.normalizedEventId)) {
      decisionByEvent.set(r.normalizedEventId, { decision: r.decision, reason: r.reason });
    }
  }

  const parentTitleById = new Map<string, string>();
  for (const p of parentTitles) parentTitleById.set(p.id, p.title);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    type: r.type,
    tags: r.tags,
    isCancelled: r.isCancelled,
    startTime: r.startTime,
    endTime: r.endTime,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,

    artistId: r.artistId,
    artistName: r.artistName,

    venueId: r.venueId,
    venueName: r.venueName,
    venueUrl: r.venueUrl,
    venue: r.venueCanonicalId
      ? {
          id: r.venueCanonicalId,
          name: r.venueCanonicalName!,
          kind: r.venueCanonicalKind!,
          status: r.venueCanonicalStatus!,
        }
      : null,

    parentEventId: r.parentEventId,
    parentTitle: r.parentEventId ? parentTitleById.get(r.parentEventId) ?? null : null,
    subEventCount: subEventCountByParent.get(r.id) ?? 0,

    sourceCount: sourceCountByEvent.get(r.id) ?? 0,
    latestDecision: decisionByEvent.get(r.id)?.decision ?? null,
    latestReason: decisionByEvent.get(r.id)?.reason ?? null,
  }));
}
