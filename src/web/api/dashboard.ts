import { Hono } from "hono";
import { listNormalizedEvents } from "../../core/queries/NormalizedEventsQueries";
import { listRecentRawItems } from "../../core/queries/RawItemsQueries";

export const dashboardRoute = new Hono();

/**
 * Aggregated dashboard payload. Composes the existing query modules so
 * the front-end can render the whole page from a single round-trip.
 *
 * Optional `oshi` query param scopes every panel to one artist.
 */
dashboardRoute.get("/dashboard", async (c) => {
  const artistId = c.req.query("oshi") || undefined;

  const [events, timeline] = await Promise.all([
    listNormalizedEvents({ orderBy: "updatedAt", limit: 50, artistId }),
    listRecentRawItems({ limit: 30, artistId }),
  ]);

  const now = Date.now();
  const upcoming = events
    .filter((e) => e.startTime && e.startTime.getTime() >= now)
    .sort((a, b) => a.startTime!.getTime() - b.startTime!.getTime());

  const nextEvent = upcoming[0] ?? null;

  return c.json({
    nextEvent,
    eventFeed: events,
    timeline,
    serverTime: new Date().toISOString(),
  });
});
