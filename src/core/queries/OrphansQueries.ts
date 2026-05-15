import { and, count, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { artists, rawItems, watchTargets } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type OrphanCategory = "mood" | "fan_engagement" | "other";

export type OrphanListItem = {
  id: string;
  category: OrphanCategory | null;
  reason: string | null;
  sourceName: string;
  sourceUrl: string | null;
  postedAt: Date | null;
  fetchedAt: Date;
  artistId: string | null;
  artistName: string | null;
  artistHandle: string | null;
  rawData: Record<string, unknown>;
};

export type OrphanCategoryCount = {
  category: OrphanCategory | "uncategorized";
  count: number;
};

export type OrphansSummary = {
  total: number;
  byCategory: OrphanCategoryCount[];
  items: OrphanListItem[];
};

export type ListOrphansOptions = {
  /** Default 100. */
  limit?: number;
  /** Filter to one category. Omit for all. */
  category?: OrphanCategory;
};

/**
 * Browse `raw_items` rows that the extractor classified as orphan posts
 * (`status='not_an_event'`). Used by the admin orphan-inspection panel
 * to group, spot-check, and (eventually) requeue misclassifications.
 *
 * Returns both per-category counts and a page of recent rows.
 */
export async function listOrphans(
  opts: ListOrphansOptions = {},
  dbi: DbInstance = defaultDb
): Promise<OrphansSummary> {
  const limit = opts.limit ?? 100;

  const baseConditions = [eq(rawItems.status, "not_an_event")];
  const itemConditions = [...baseConditions];
  if (opts.category) itemConditions.push(eq(rawItems.notAnEventCategory, opts.category));

  const [items, byCategoryRows] = await Promise.all([
    dbi
      .select({
        id: rawItems.id,
        category: rawItems.notAnEventCategory,
        reason: rawItems.errorMessage,
        sourceName: rawItems.sourceName,
        sourceUrl: rawItems.sourceUrl,
        postedAt: rawItems.postedAt,
        fetchedAt: rawItems.fetchedAt,
        artistId: watchTargets.artistId,
        artistName: artists.name,
        artistHandle: artists.handle,
        rawData: rawItems.rawData,
      })
      .from(rawItems)
      .leftJoin(watchTargets, eq(rawItems.watchTargetId, watchTargets.id))
      .leftJoin(artists, eq(watchTargets.artistId, artists.id))
      .where(and(...itemConditions))
      .orderBy(desc(rawItems.fetchedAt))
      .limit(limit),

    dbi
      .select({
        category: rawItems.notAnEventCategory,
        cnt: count(),
      })
      .from(rawItems)
      .where(and(...baseConditions))
      .groupBy(rawItems.notAnEventCategory),
  ]);

  // Counts including an "uncategorized" bucket for legacy rows written
  // before migration 0025 (null notAnEventCategory).
  let total = 0;
  const byCategory: OrphanCategoryCount[] = [];
  for (const r of byCategoryRows) {
    total += r.cnt;
    byCategory.push({
      category: (r.category ?? "uncategorized") as OrphanCategoryCount["category"],
      count: r.cnt,
    });
  }

  return {
    total,
    byCategory,
    items: items.map((r) => ({
      id: r.id,
      category: r.category as OrphanCategory | null,
      reason: r.reason,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      postedAt: r.postedAt,
      fetchedAt: r.fetchedAt,
      artistId: r.artistId,
      artistName: r.artistName,
      artistHandle: r.artistHandle,
      rawData: r.rawData,
    })),
  };
}

/**
 * Put an orphan raw item back on the extraction queue. The caller is the
 * admin "requeue" action; clears the orphan-specific columns so the next
 * extraction pass treats the row as fresh.
 */
export async function requeueOrphan(itemId: string, dbi: DbInstance = defaultDb): Promise<void> {
  await dbi
    .update(rawItems)
    .set({
      status: "new",
      errorMessage: null,
      errorClass: null,
      notAnEventCategory: null,
    })
    .where(and(eq(rawItems.id, itemId), eq(rawItems.status, "not_an_event")));
}

