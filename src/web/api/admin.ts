import { Hono } from "hono";
import { getConfig } from "../../config";
import { EventResolver } from "../../core/EventResolver";
import { ExportQueueRepo } from "../../core/ExportQueueRepo";
import { EmbeddingsRepo } from "../../core/EmbeddingsRepo";
import { OllamaEmbeddingService } from "../../core/EmbeddingService";
import { db } from "../../db";
import { NormalizedEventsRepo, type UpdateNormalizedEventFields } from "../../core/NormalizedEventsRepo";
import { SchedulerRunsRepo } from "../../core/SchedulerRunsRepo";
import { listNormalizedEvents } from "../../core/queries/NormalizedEventsQueries";
import { getExtractionFailureSummary } from "../../core/queries/MonitorQueries";
import { listReviewQueue } from "../../core/queries/ReviewQueueQueries";
import { listOrphans, requeueOrphan, type OrphanCategory } from "../../core/queries/OrphansQueries";
import { listVenues, updateVenue, type UpdateVenueFields } from "../../core/queries/VenuesQueries";

export const adminRoute = new Hono();

const exportQueue = getConfig().export.enabled ? new ExportQueueRepo() : null;
const embeddingsRepo = getConfig().embeddings.enabled
  ? new EmbeddingsRepo(db, new OllamaEmbeddingService())
  : null;
const resolver = new EventResolver(undefined, undefined, exportQueue, embeddingsRepo);
const eventsRepo = new NormalizedEventsRepo(undefined, exportQueue, embeddingsRepo);
const runsRepo = new SchedulerRunsRepo();

const HOUR_MS = 60 * 60 * 1000;

adminRoute.get("/admin/dashboard", async (c) => {
  const sinceHour = new Date(Date.now() - HOUR_MS);

  const [recent, countsRows, taskNames, failures, reviewQueue, events, orphans] = await Promise.all([
    runsRepo.recent(50),
    runsRepo.countsSince(sinceHour),
    runsRepo.distinctTaskNames(),
    getExtractionFailureSummary(),
    listReviewQueue({ limit: 50 }),
    listNormalizedEvents({ orderBy: "updatedAt", limit: 100 }),
    listOrphans({ limit: 50 }),
  ]);

  const cards = sortByPipelineOrder(taskNames).map((name) => {
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
    orphans,
    serverTime: new Date().toISOString(),
  });
});

adminRoute.get("/admin/orphans", async (c) => {
  const categoryParam = c.req.query("category");
  const allowed: OrphanCategory[] = ["mood", "fan_engagement", "other"];
  const category = allowed.includes(categoryParam as OrphanCategory)
    ? (categoryParam as OrphanCategory)
    : undefined;
  const summary = await listOrphans({ limit: 100, category });
  return c.json(summary);
});

adminRoute.post("/admin/orphans/:id/requeue", async (c) => {
  const id = c.req.param("id");
  try {
    await requeueOrphan(id);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/review/:id/merge", async (c) => {
  const decisionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as {
    extractedEventId?: string;
    normalizedEventId?: string;
    note?: string;
  };
  const { extractedEventId, normalizedEventId, note } = body;
  if (!extractedEventId || !normalizedEventId) {
    return c.json({ error: "extractedEventId and normalizedEventId required" }, 400);
  }
  try {
    await resolver.acceptAsMerge(extractedEventId, normalizedEventId, note ?? null);
    return c.json({ ok: true, decisionId });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/review/:id/new", async (c) => {
  const decisionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { extractedEventId?: string; note?: string };
  const { extractedEventId, note } = body;
  if (!extractedEventId) return c.json({ error: "extractedEventId required" }, 400);
  try {
    await resolver.acceptAsNew(extractedEventId, note ?? null);
    return c.json({ ok: true, decisionId });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/events/:id/merge-into", async (c) => {
  const loserId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { targetId?: string; note?: string };
  if (!body.targetId) return c.json({ error: "targetId required" }, 400);
  try {
    await eventsRepo.mergeNormalizedEvents(loserId, body.targetId, body.note ?? null);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

adminRoute.post("/admin/events/:id/attach-to-parent", async (c) => {
  const eventId = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { parentId?: string; note?: string };
  if (!body.parentId) return c.json({ error: "parentId required" }, 400);
  try {
    await eventsRepo.reparentNormalizedEvent(eventId, body.parentId, body.note ?? null);
    return c.json({ ok: true });
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

adminRoute.get("/admin/venues", async (c) => {
  const statusParam = c.req.query("status");
  const allowed = ["discovered", "verified", "ignored"] as const;
  const status = allowed.includes(statusParam as typeof allowed[number])
    ? (statusParam as typeof allowed[number])
    : undefined;
  const items = await listVenues({ status });
  return c.json({ items });
});

adminRoute.patch("/admin/venues/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "json body required" }, 400);

  const fields: UpdateVenueFields = {};
  if (typeof body.name === "string") fields.name = body.name;
  if (typeof body.kind === "string" && ["physical", "virtual", "unknown"].includes(body.kind)) {
    fields.kind = body.kind as UpdateVenueFields["kind"];
  }
  if (typeof body.status === "string" && ["discovered", "verified", "ignored"].includes(body.status)) {
    fields.status = body.status as UpdateVenueFields["status"];
  }
  if ("url" in body) fields.url = body.url == null || body.url === "" ? null : String(body.url);
  if ("address" in body) fields.address = body.address == null || body.address === "" ? null : String(body.address);
  if ("city" in body) fields.city = body.city == null || body.city === "" ? null : String(body.city);
  if ("region" in body) fields.region = body.region == null || body.region === "" ? null : String(body.region);
  if ("country" in body) fields.country = body.country == null || body.country === "" ? null : String(body.country);
  if ("latitude" in body) fields.latitude = body.latitude == null ? null : Number(body.latitude);
  if ("longitude" in body) fields.longitude = body.longitude == null ? null : Number(body.longitude);

  try {
    await updateVenue(id, fields);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Order the Pipeline health cards by the actual data flow (Ingestion →
// Extraction → Resolution → Export). Unknown task names sort alphabetically
// after the known order so future tasks surface in a stable spot.
const PIPELINE_ORDER = ["Ingestion", "Extraction", "Resolution", "Export"];
function sortByPipelineOrder(names: string[]): string[] {
  const rank = (n: string) => {
    const i = PIPELINE_ORDER.indexOf(n);
    return i === -1 ? PIPELINE_ORDER.length : i;
  };
  return [...names].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

function parseDateOrNull(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
