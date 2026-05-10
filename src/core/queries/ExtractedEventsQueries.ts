import { desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import {
  artists,
  extractedEventRelatedLinks,
  extractedEvents,
  rawItems,
  venues,
} from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ListExtractedEventsOptions = {
  /** Default 50. */
  limit?: number;
  /**
   * Which record_kind to return. Defaults to "event" so existing TUI/web
   * consumers continue to see only event rows, not annotations.
   */
  recordKind?: "event" | "annotation";
};

export type ExtractedEventRelatedLink = {
  id: string;
  url: string;
  title: string | null;
};

export type ExtractedEventVenue = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export type ExtractedEventListItem = {
  id: string;
  rawItemId: string;
  artistId: string | null;
  artistName: string | null;
  title: string;
  description: string;
  startTime: Date | null;
  endTime: Date | null;
  type: string;
  tags: string[];
  isCancelled: boolean;
  eventScope: string;
  parentEventHint: string | null;
  venueId: string | null;
  venueName: string | null;
  venueUrl: string | null;
  venue: ExtractedEventVenue | null;
  publishTime: Date;
  author: string;
  sourceUrl: string;
  sourceName: string | null;
  rawContent: string;
  links: ExtractedEventRelatedLink[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * List recent extracted events with their venue (canonical), artist,
 * source raw_item name, and related links. Joins do the per-row work
 * in a single statement; related links are fetched in one follow-up
 * query keyed by event id.
 */
export async function listExtractedEvents(
  opts: ListExtractedEventsOptions = {},
  dbi: DbInstance = defaultDb
): Promise<ExtractedEventListItem[]> {
  const limit = opts.limit ?? 50;
  const recordKind = opts.recordKind ?? "event";

  const rows = await dbi
    .select({
      // extracted
      id: extractedEvents.id,
      rawItemId: extractedEvents.rawItemId,
      artistId: extractedEvents.artistId,
      title: extractedEvents.title,
      description: extractedEvents.description,
      startTime: extractedEvents.startTime,
      endTime: extractedEvents.endTime,
      type: extractedEvents.type,
      tags: extractedEvents.tags,
      isCancelled: extractedEvents.isCancelled,
      eventScope: extractedEvents.eventScope,
      parentEventHint: extractedEvents.parentEventHint,
      venueId: extractedEvents.venueId,
      venueName: extractedEvents.venueName,
      venueUrl: extractedEvents.venueUrl,
      publishTime: extractedEvents.publishTime,
      author: extractedEvents.author,
      sourceUrl: extractedEvents.sourceUrl,
      rawContent: extractedEvents.rawContent,
      createdAt: extractedEvents.createdAt,
      updatedAt: extractedEvents.updatedAt,
      // joined
      artistName: artists.name,
      venueCanonicalId: venues.id,
      venueCanonicalName: venues.name,
      venueCanonicalKind: venues.kind,
      venueCanonicalStatus: venues.status,
      sourceName: rawItems.sourceName,
    })
    .from(extractedEvents)
    .leftJoin(artists, eq(extractedEvents.artistId, artists.id))
    .leftJoin(venues, eq(extractedEvents.venueId, venues.id))
    .leftJoin(rawItems, eq(extractedEvents.rawItemId, rawItems.id))
    .where(eq(extractedEvents.recordKind, recordKind))
    .orderBy(desc(extractedEvents.startTime))
    .limit(limit);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const links = await dbi
    .select({
      id: extractedEventRelatedLinks.id,
      extractedEventId: extractedEventRelatedLinks.extractedEventId,
      url: extractedEventRelatedLinks.url,
      title: extractedEventRelatedLinks.title,
    })
    .from(extractedEventRelatedLinks)
    .where(inArray(extractedEventRelatedLinks.extractedEventId, ids));

  const linksByEvent = new Map<string, ExtractedEventRelatedLink[]>();
  for (const l of links) {
    const list = linksByEvent.get(l.extractedEventId) ?? [];
    list.push({ id: l.id, url: l.url, title: l.title });
    linksByEvent.set(l.extractedEventId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    rawItemId: r.rawItemId,
    artistId: r.artistId,
    artistName: r.artistName,
    title: r.title,
    description: r.description,
    startTime: r.startTime,
    endTime: r.endTime,
    type: r.type,
    tags: r.tags,
    isCancelled: r.isCancelled,
    eventScope: r.eventScope,
    parentEventHint: r.parentEventHint,
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
    publishTime: r.publishTime,
    author: r.author,
    sourceUrl: r.sourceUrl,
    sourceName: r.sourceName,
    rawContent: r.rawContent,
    links: linksByEvent.get(r.id) ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
