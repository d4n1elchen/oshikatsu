import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { extractedEvents, venueAliases, venues } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type VenueListItem = {
  id: string;
  name: string;
  kind: "physical" | "virtual" | "unknown";
  status: "discovered" | "verified" | "ignored";
  url: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  aliasCount: number;
  eventMentionCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ListVenuesOptions = {
  /** Default 200. */
  limit?: number;
  /** Filter to one status. Omit for all. */
  status?: "discovered" | "verified" | "ignored";
};

/**
 * Browse the `venues` table for the admin curation surface. Pairs each
 * venue with its alias count and event mention count (how many
 * extracted_events reference this venue_id), so the operator can
 * prioritize curating venues that show up most often.
 *
 * Ordered: `discovered` first (need attention), then `verified`, then
 * `ignored`; within each status, by mention count desc.
 */
export async function listVenues(
  opts: ListVenuesOptions = {},
  dbi: DbInstance = defaultDb,
): Promise<VenueListItem[]> {
  const limit = opts.limit ?? 200;

  const aliasCounts = dbi
    .select({
      venueId: venueAliases.venueId,
      count: sql<number>`count(*)`.as("alias_count"),
    })
    .from(venueAliases)
    .groupBy(venueAliases.venueId)
    .as("alias_counts");

  const mentionCounts = dbi
    .select({
      venueId: extractedEvents.venueId,
      count: sql<number>`count(*)`.as("mention_count"),
    })
    .from(extractedEvents)
    .where(sql`${extractedEvents.venueId} IS NOT NULL`)
    .groupBy(extractedEvents.venueId)
    .as("mention_counts");

  let query = dbi
    .select({
      id: venues.id,
      name: venues.name,
      kind: venues.kind,
      status: venues.status,
      url: venues.url,
      address: venues.address,
      city: venues.city,
      region: venues.region,
      country: venues.country,
      latitude: venues.latitude,
      longitude: venues.longitude,
      aliasCount: sql<number>`coalesce(${aliasCounts.count}, 0)`,
      eventMentionCount: sql<number>`coalesce(${mentionCounts.count}, 0)`,
      createdAt: venues.createdAt,
      updatedAt: venues.updatedAt,
    })
    .from(venues)
    .leftJoin(aliasCounts, eq(aliasCounts.venueId, venues.id))
    .leftJoin(mentionCounts, eq(mentionCounts.venueId, venues.id))
    .$dynamic();

  if (opts.status) {
    query = query.where(eq(venues.status, opts.status));
  }

  const rows = await query
    .orderBy(
      // discovered (0) → verified (1) → ignored (2); within each, mention count desc.
      sql`CASE ${venues.status} WHEN 'discovered' THEN 0 WHEN 'verified' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END`,
      sql`coalesce(${mentionCounts.count}, 0) DESC`,
      venues.name,
    )
    .limit(limit);

  return rows as VenueListItem[];
}

export type UpdateVenueFields = Partial<{
  name: string;
  kind: "physical" | "virtual" | "unknown";
  status: "discovered" | "verified" | "ignored";
  url: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
}>;

/**
 * Operator-driven update of a venue row. Used by the admin curation
 * surface to fill in URLs / addresses on `discovered` venues and to
 * verify or ignore them. Touches `updated_at` on every write.
 */
export async function updateVenue(
  id: string,
  fields: UpdateVenueFields,
  dbi: DbInstance = defaultDb,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await dbi
    .update(venues)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(venues.id, id));
}
