import { Hono } from "hono";
import { getNormalizedEventDetail } from "../../core/queries/NormalizedEventsQueries";

export const eventsRoute = new Hono();

eventsRoute.get("/events/:id", async (c) => {
  const id = c.req.param("id");
  const detail = await getNormalizedEventDetail(id);
  if (!detail) return c.json({ error: "not_found" }, 404);
  return c.json(detail);
});
