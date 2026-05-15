import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import {
  artists,
  eventResolutionDecisions,
  extractedEventRelatedLinks,
  extractedEvents,
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
  /** Filter to a single event by id. Used by the detail query. */
  id?: string;
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

  operatorOwned: boolean;
  operatorEditedAt: Date | null;
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

  const whereParts = [
    opts.artistId ? eq(normalizedEvents.artistId, opts.artistId) : undefined,
    opts.id ? eq(normalizedEvents.id, opts.id) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const whereClause = whereParts.length === 0 ? undefined : and(...whereParts);

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

      operatorOwned: normalizedEvents.operatorOwned,
      operatorEditedAt: normalizedEvents.operatorEditedAt,
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
      .where(
        and(
          inArray(normalizedEventSources.normalizedEventId, ids),
          ne(normalizedEventSources.role, "annotation")
        )
      )
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

    operatorOwned: r.operatorOwned,
    operatorEditedAt: r.operatorEditedAt,
  }));
}

export type EventSourceEntry = {
  extractedEventId: string;
  role: string;
  author: string;
  publishTime: Date;
  sourceUrl: string;
  rawContent: string;
};

export type EventRelatedLink = {
  url: string;
  title: string | null;
};

export type EventSubEntry = {
  id: string;
  title: string;
  startTime: Date | null;
  isCancelled: boolean;
};

export type AnnotationCategory = "milestone" | "press_coverage" | "recap" | "reminder_repost";

export type AnnotationEntry = {
  extractedEventId: string;
  category: AnnotationCategory;
  title: string;
  description: string;
  author: string;
  sourceUrl: string;
  publishTime: Date;
  rawContent: string;
};

export type NormalizedEventDetail = NormalizedEventListItem & {
  sources: EventSourceEntry[];
  relatedLinks: EventRelatedLink[];
  subEvents: EventSubEntry[];
  annotations: AnnotationEntry[];
};

/**
 * Full detail for one canonical event, used by the dashboard modal.
 * Composes the same enrichment as `listNormalizedEvents` and adds
 * source raw items (via extracted_events), de-duplicated related
 * links, and direct sub-events (one level).
 */
export async function getNormalizedEventDetail(
  id: string,
  dbi: DbInstance = defaultDb
): Promise<NormalizedEventDetail | null> {
  const [event] = await listNormalizedEvents({ id, limit: 1 }, dbi);
  if (!event) return null;

  const [sources, links, subs, annotations] = await Promise.all([
    dbi
      .select({
        extractedEventId: normalizedEventSources.extractedEventId,
        role: normalizedEventSources.role,
        author: extractedEvents.author,
        publishTime: extractedEvents.publishTime,
        sourceUrl: extractedEvents.sourceUrl,
        rawContent: extractedEvents.rawContent,
      })
      .from(normalizedEventSources)
      .innerJoin(extractedEvents, eq(normalizedEventSources.extractedEventId, extractedEvents.id))
      .where(
        and(
          eq(normalizedEventSources.normalizedEventId, id),
          ne(normalizedEventSources.role, "annotation")
        )
      )
      .orderBy(desc(extractedEvents.publishTime)),

    dbi
      .select({
        url: extractedEventRelatedLinks.url,
        title: extractedEventRelatedLinks.title,
        extractedEventId: extractedEventRelatedLinks.extractedEventId,
      })
      .from(extractedEventRelatedLinks)
      .innerJoin(
        normalizedEventSources,
        eq(normalizedEventSources.extractedEventId, extractedEventRelatedLinks.extractedEventId)
      )
      .where(
        and(
          eq(normalizedEventSources.normalizedEventId, id),
          ne(normalizedEventSources.role, "annotation")
        )
      ),

    dbi
      .select({
        id: normalizedEvents.id,
        title: normalizedEvents.title,
        startTime: normalizedEvents.startTime,
        isCancelled: normalizedEvents.isCancelled,
      })
      .from(normalizedEvents)
      .where(eq(normalizedEvents.parentEventId, id))
      .orderBy(asc(normalizedEvents.startTime)),

    listAnnotationsForEvent(id, dbi),
  ]);

  // Dedupe related links by URL.
  const linkByUrl = new Map<string, EventRelatedLink>();
  for (const l of links) {
    if (!linkByUrl.has(l.url)) linkByUrl.set(l.url, { url: l.url, title: l.title });
  }

  return {
    ...event,
    sources: sources.map((s) => ({
      extractedEventId: s.extractedEventId,
      role: s.role,
      author: s.author,
      publishTime: s.publishTime,
      sourceUrl: s.sourceUrl,
      rawContent: s.rawContent,
    })),
    relatedLinks: [...linkByUrl.values()],
    subEvents: subs.map((s) => ({
      id: s.id,
      title: s.title,
      startTime: s.startTime,
      isCancelled: s.isCancelled,
    })),
    annotations,
  };
}

/**
 * Annotations attached to a normalized event by `AnnotationReconciler`.
 * Reads `normalized_event_sources` rows with `role='annotation'` joined
 * through to the source extracted_event for the displayable fields.
 * Ordered newest-first by post time.
 */
export async function listAnnotationsForEvent(
  normalizedEventId: string,
  dbi: DbInstance = defaultDb
): Promise<AnnotationEntry[]> {
  const rows = await dbi
    .select({
      extractedEventId: normalizedEventSources.extractedEventId,
      category: extractedEvents.type,
      title: extractedEvents.title,
      description: extractedEvents.description,
      author: extractedEvents.author,
      sourceUrl: extractedEvents.sourceUrl,
      publishTime: extractedEvents.publishTime,
      rawContent: extractedEvents.rawContent,
    })
    .from(normalizedEventSources)
    .innerJoin(extractedEvents, eq(normalizedEventSources.extractedEventId, extractedEvents.id))
    .where(
      and(
        eq(normalizedEventSources.normalizedEventId, normalizedEventId),
        eq(normalizedEventSources.role, "annotation")
      )
    )
    .orderBy(desc(extractedEvents.publishTime));

  return rows.map((r) => ({
    extractedEventId: r.extractedEventId,
    category: r.category as AnnotationCategory,
    title: r.title,
    description: r.description,
    author: r.author,
    sourceUrl: r.sourceUrl,
    publishTime: r.publishTime,
    rawContent: r.rawContent,
  }));
}
