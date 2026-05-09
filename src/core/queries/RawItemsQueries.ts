import { and, desc, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { artists, rawItems, watchTargets } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ListRecentRawItemsOptions = {
  /** Default 100. */
  limit?: number;
  /** `fetched_at` exclusive upper bound; pass the last item's `fetchedAt` to page back. */
  cursor?: Date;
  /** Filter to a specific artist (web UI sidebar selection). */
  artistId?: string;
};

export type RawItemTimelineEntry = {
  id: string;
  sourceName: string;
  sourceId: string;
  /** Source-specific payload (e.g. tweet shape for Twitter). The web UI's
   *  render layer is responsible for extracting fields per `sourceName`. */
  rawData: Record<string, unknown>;
  /** When the post was published on the source platform, when derivable
   *  from `rawData`. Falls back to null for sources we haven't taught
   *  the extractor about. Use `postedAt ?? fetchedAt` for display. */
  postedAt: Date | null;
  /** When the scheduler fetched the post into raw_items. */
  fetchedAt: Date;
  status: string;
  watchTargetId: string;
  artistId: string;
  artistName: string;
  artistHandle: string;
};

/**
 * Recent raw items joined with their watch target's artist. Source for
 * the web UI timeline rail. Sorted newest first; supports a cursor and
 * an optional artist filter.
 */
export async function listRecentRawItems(
  opts: ListRecentRawItemsOptions = {},
  dbi: DbInstance = defaultDb
): Promise<RawItemTimelineEntry[]> {
  const limit = opts.limit ?? 100;

  const conditions = [];
  if (opts.cursor) conditions.push(lt(rawItems.fetchedAt, opts.cursor));
  if (opts.artistId) conditions.push(eq(watchTargets.artistId, opts.artistId));

  const finalWhere = conditions.length === 0 ? undefined : and(...conditions);

  const rows = await dbi
    .select({
      id: rawItems.id,
      sourceName: rawItems.sourceName,
      sourceId: rawItems.sourceId,
      rawData: rawItems.rawData,
      postedAt: rawItems.postedAt,
      fetchedAt: rawItems.fetchedAt,
      status: rawItems.status,
      watchTargetId: rawItems.watchTargetId,
      artistId: watchTargets.artistId,
      artistName: artists.name,
      artistHandle: artists.handle,
    })
    .from(rawItems)
    .innerJoin(watchTargets, eq(rawItems.watchTargetId, watchTargets.id))
    .innerJoin(artists, eq(watchTargets.artistId, artists.id))
    .where(finalWhere)
    .orderBy(desc(rawItems.fetchedAt))
    .limit(limit);

  return rows;
}
