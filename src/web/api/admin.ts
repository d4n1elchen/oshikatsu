import { Hono } from "hono";
import { getConfig } from "../../config";
import { EventResolver } from "../../core/EventResolver";
import { ExportQueueRepo } from "../../core/ExportQueueRepo";
import { NormalizedEventsRepo, type UpdateNormalizedEventFields } from "../../core/NormalizedEventsRepo";
import { SchedulerRunsRepo } from "../../core/SchedulerRunsRepo";
import { listNormalizedEvents } from "../../core/queries/NormalizedEventsQueries";
import { getExtractionFailureSummary } from "../../core/queries/MonitorQueries";
import { listReviewQueue } from "../../core/queries/ReviewQueueQueries";

export const adminRoute = new Hono();

const exportQueue = getConfig().export.enabled ? new ExportQueueRepo() : null;
const resolver = new EventResolver(undefined, undefined, exportQueue);
const eventsRepo = new NormalizedEventsRepo(undefined, exportQueue);
const runsRepo = new SchedulerRunsRepo();

const HOUR_MS = 60 * 60 * 1000;

adminRoute.get("/admin/dashboard", async (c) => {
  const sinceHour = new Date(Date.now() - HOUR_MS);

  const [recent, countsRows, taskNames, failures, reviewQueue, events] = await Promise.all([
    runsRepo.recent(50),
    runsRepo.countsSince(sinceHour),
    runsRepo.distinctTaskNames(),
    getExtractionFailureSummary(),
    listReviewQueue({ limit: 50 }),
    listNormalizedEvents({ orderBy: "updatedAt", limit: 100 }),
  ]);

  const cards = taskNames.map((name) => {
    const taskRecent = recent.filter((r) => r.taskName === name);
    const lastRun = taskRecent[0] ?? null;
    const lastSuccess = taskRecent.find((r) => r.status === "completed") ?? null;
    const lastFailure = taskRecent.find((r) => r.status === "failed") ?? null;
    const counts = { completed: 0, failed: 0, aborted: 0 };
    for (const c of countsRows) {
      if (c.taskName !== name) continue;
      if (c.status in counts) counts[c.status as keyof typeof counts] = c.count;
    }
    return { name, lastRun, lastSuccess, lastFailure, countsLastHour: counts };
  });

  return c.json({
    cards,
    recentRuns: recent,
    extractionFailures: failures,
    reviewQueue,
    events,
    serverTime: new Date().toISOString(),
  });
});

adminRoute.post("/admin/review/:id/merge", async (c) => {
  const decisionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as {
    extractedEventId?: string;
    normalizedEventId?: string;
  };
  const { extractedEventId, normalizedEventId } = body;
  if (!extractedEventId || !normalizedEventId) {
    return c.json({ error: "extractedEventId and normalizedEventId required" }, 400);
  }
  try {
    await resolver.acceptAsMerge(extractedEventId, normalizedEventId);
    return c.json({ ok: true, decisionId });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/review/:id/new", async (c) => {
  const decisionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { extractedEventId?: string };
  const { extractedEventId } = body;
  if (!extractedEventId) return c.json({ error: "extractedEventId required" }, 400);
  try {
    await resolver.acceptAsNew(extractedEventId);
    return c.json({ ok: true, decisionId });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.patch("/admin/events/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "json body required" }, 400);

  const fields: UpdateNormalizedEventFields = {};
  if (typeof body.title === "string") fields.title = body.title;
  if (typeof body.description === "string") fields.description = body.description;
  if ("startTime" in body) fields.startTime = parseDateOrNull(body.startTime);
  if ("endTime" in body) fields.endTime = parseDateOrNull(body.endTime);
  if (typeof body.isCancelled === "boolean") fields.isCancelled = body.isCancelled;
  if (Array.isArray(body.tags)) fields.tags = body.tags.map(String);
  if ("parentEventId" in body) fields.parentEventId = body.parentEventId == null ? null : String(body.parentEventId);
  if ("venueId" in body) fields.venueId = body.venueId == null ? null : String(body.venueId);
  if ("venueName" in body) fields.venueName = body.venueName == null ? null : String(body.venueName);
  if ("venueUrl" in body) fields.venueUrl = body.venueUrl == null ? null : String(body.venueUrl);
  if (typeof body.type === "string") fields.type = body.type;

  try {
    await eventsRepo.updateNormalizedEvent(id, fields);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/events/:id/release", async (c) => {
  const id = c.req.param("id");
  try {
    await eventsRepo.releaseFromOperator(id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function parseDateOrNull(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
