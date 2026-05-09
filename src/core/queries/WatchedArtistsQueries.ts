import { desc, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { artists, rawItems, watchTargets } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type WatchedArtistEntry = {
  id: string;
  handle: string;
  name: string;
  /** Most recent `raw_items.fetched_at` across the artist's watch targets. */
  lastActivityAt: Date | null;
};

/**
 * List watched (enabled) artists with their most-recent ingestion
 * timestamp. Sidebar source for the dashboard — drives the activity dot
 * and the "filter by oshi" affordance.
 */
export async function listWatchedArtists(
  dbi: DbInstance = defaultDb
): Promise<WatchedArtistEntry[]> {
  const rows = await dbi
    .select({
      id: artists.id,
      handle: artists.handle,
      name: artists.name,
      lastActivitySec: sql<number | null>`MAX(${rawItems.fetchedAt})`,
    })
    .from(artists)
    .leftJoin(watchTargets, eq(watchTargets.artistId, artists.id))
    .leftJoin(rawItems, eq(rawItems.watchTargetId, watchTargets.id))
    .where(eq(artists.enabled, true))
    .groupBy(artists.id, artists.handle, artists.name)
    .orderBy(desc(sql`MAX(${rawItems.fetchedAt})`));

  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    name: r.name,
    lastActivityAt: r.lastActivitySec ? new Date(r.lastActivitySec * 1000) : null,
  }));
}
