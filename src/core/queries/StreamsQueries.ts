import { and, asc, eq, gte } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { artists, normalizedEvents, venues } from "../../db/schema";

type DbInstance = typeof defaultDb;

export type ListStreamsOptions = {
  /** Default 12. */
  limit?: number;
  artistId?: string;
  /** Hours after `start_time` an event is still considered ongoing
   *  when `end_time` is null. Default 4. */
  graceHours?: number;
};

export type StreamEntry = {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date | null;
  isLive: boolean;
  artistId: string | null;
  artistName: string | null;
  venueId: string;
  venueName: string;
  venueUrl: string | null;
  /** Hint for the platform thumbnail/icon based on the venue URL. */
  platform: "youtube" | "twitch" | "niconico" | "x" | "other";
};

/**
 * Live & upcoming virtual-venue events for the dashboard streams rail.
 * Ongoing items first (LIVE), then upcoming by start_time asc.
 *
 * Ongoing definition: start_time <= now AND (end_time >= now,
 * or end_time IS NULL AND start_time + graceHours > now). The grace
 * window covers events without an explicit end_time.
 */
export async function listLiveAndUpcomingStreams(
  opts: ListStreamsOptions = {},
  dbi: DbInstance = defaultDb
): Promise<StreamEntry[]> {
  const limit = opts.limit ?? 12;
  const graceMs = (opts.graceHours ?? 4) * 60 * 60 * 1000;
  const now = Date.now();
  // Pull anything still potentially ongoing (start within the grace window
  // back from now) plus everything upcoming. The TS-side filter prunes
  // ended items.
  const sinceForOngoing = new Date(now - graceMs);

  const conditions = [
    eq(venues.kind, "virtual"),
    gte(normalizedEvents.startTime, sinceForOngoing),
  ];
  if (opts.artistId) conditions.push(eq(normalizedEvents.artistId, opts.artistId));

  const rows = await dbi
    .select({
      id: normalizedEvents.id,
      title: normalizedEvents.title,
      startTime: normalizedEvents.startTime,
      endTime: normalizedEvents.endTime,
      artistId: normalizedEvents.artistId,
      artistName: artists.name,
      venueId: venues.id,
      venueName: venues.name,
      venueUrl: venues.url,
    })
    .from(normalizedEvents)
    .innerJoin(venues, eq(normalizedEvents.venueId, venues.id))
    .leftJoin(artists, eq(normalizedEvents.artistId, artists.id))
    .where(and(...conditions))
    .orderBy(asc(normalizedEvents.startTime));

  const entries: StreamEntry[] = [];
  for (const r of rows) {
    if (!r.startTime) continue;
    const start = r.startTime.getTime();
    const end = r.endTime ? r.endTime.getTime() : start + graceMs;
    if (end < now) continue; // ended

    entries.push({
      id: r.id,
      title: r.title,
      startTime: r.startTime,
      endTime: r.endTime,
      isLive: start <= now && now <= end,
      artistId: r.artistId,
      artistName: r.artistName,
      venueId: r.venueId,
      venueName: r.venueName,
      venueUrl: r.venueUrl,
      platform: detectPlatform(r.venueUrl),
    });
  }

  // Stable order: live first (each subgroup already sorted by start asc),
  // then upcoming.
  entries.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.startTime.getTime() - b.startTime.getTime();
  });

  return entries.slice(0, limit);
}

function detectPlatform(url: string | null): StreamEntry["platform"] {
  if (!url) return "other";
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  if (lower.includes("twitch.tv")) return "twitch";
  if (lower.includes("nicovideo.jp") || lower.includes("nicodouga")) return "niconico";
  if (lower.includes("x.com") || lower.includes("twitter.com")) return "x";
  return "other";
}
