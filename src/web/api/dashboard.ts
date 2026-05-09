import { Hono } from "hono";
import { listNormalizedEvents } from "../../core/queries/NormalizedEventsQueries";
import { listRecentRawItems } from "../../core/queries/RawItemsQueries";
import { listLiveAndUpcomingStreams } from "../../core/queries/StreamsQueries";
import { listWatchedArtists } from "../../core/queries/WatchedArtistsQueries";

export const dashboardRoute = new Hono();

/**
 * Aggregated dashboard payload. Composes the existing query modules so
 * the front-end can render the whole page from a single round-trip.
 *
 * Optional `oshi` query param scopes the event/timeline panels to one
 * artist. The value is the artist's handle (URL-friendly); the route
 * resolves it to an id internally.
 */
dashboardRoute.get("/dashboard", async (c) => {
  const oshiHandle = c.req.query("oshi") || null;
  const oshis = await listWatchedArtists();
  const activeOshi = oshiHandle ? oshis.find((o) => o.handle === oshiHandle) ?? null : null;
  const artistId = activeOshi?.id;

  const [events, timeline, streams] = await Promise.all([
    listNormalizedEvents({ orderBy: "updatedAt", limit: 50, artistId }),
    listRecentRawItems({ limit: 30, artistId }),
    listLiveAndUpcomingStreams({ limit: 12, artistId }),
  ]);

  const now = Date.now();
  const upcoming = events
    .filter((e) => e.startTime && e.startTime.getTime() >= now)
    .sort((a, b) => a.startTime!.getTime() - b.startTime!.getTime());
  const nextEvent = upcoming[0] ?? null;

  return c.json({
    oshis,
    activeOshi: activeOshi?.handle ?? null,
    nextEvent,
    streams,
    eventFeed: events,
    timeline,
    serverTime: new Date().toISOString(),
  });
});
