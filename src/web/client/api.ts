/**
 * Client-side API types. Mirror the server DTOs from `src/core/queries/*`
 * but with `Date` fields as ISO strings (JSON.stringify converts them).
 *
 * Kept hand-written rather than auto-derived to keep the client decoupled
 * from server internals; if these drift, a runtime check will surface it
 * faster than a type error would.
 */

export type DashboardPayload = {
  oshis: OshiDTO[];
  activeOshi: string | null;
  nextEvent: NormalizedEventDTO | null;
  streams: StreamDTO[];
  eventFeed: NormalizedEventDTO[];
  timeline: RawItemDTO[];
  serverTime: string;
};

export type OshiDTO = {
  id: string;
  handle: string;
  name: string;
  lastActivityAt: string | null;
};

export type StreamDTO = {
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  isLive: boolean;
  artistId: string | null;
  artistName: string | null;
  venueId: string;
  venueName: string;
  venueUrl: string | null;
  platform: "youtube" | "twitch" | "niconico" | "x" | "other";
};

export type NormalizedEventDTO = {
  id: string;
  title: string;
  description: string;
  type: string;
  tags: string[];
  isCancelled: boolean;
  startTime: string | null;
  endTime: string | null;
  createdAt: string;
  updatedAt: string;

  artistId: string | null;
  artistName: string | null;

  venueId: string | null;
  venueName: string | null;
  venueUrl: string | null;
  venue: { id: string; name: string; kind: string; status: string } | null;

  parentEventId: string | null;
  parentTitle: string | null;
  subEventCount: number;

  sourceCount: number;
  latestDecision: string | null;
  latestReason: string | null;

  operatorOwned: boolean;
  operatorEditedAt: string | null;
};

export type RawItemDTO = {
  id: string;
  sourceName: string;
  sourceId: string;
  sourceUrl: string | null;
  rawData: Record<string, unknown>;
  postedAt: string | null;
  fetchedAt: string;
  status: string;
  watchTargetId: string;
  artistId: string;
  artistName: string;
  artistHandle: string;
};

export async function fetchDashboard(opts: { oshi?: string } = {}): Promise<DashboardPayload> {
  const qs = opts.oshi ? `?oshi=${encodeURIComponent(opts.oshi)}` : "";
  const res = await fetch(`/api/dashboard${qs}`);
  if (!res.ok) throw new Error(`Dashboard fetch failed: ${res.status}`);
  return res.json();
}

export type AnnotationCategoryDTO = "milestone" | "press_coverage" | "recap" | "reminder_repost";

export type AnnotationEntryDTO = {
  extractedEventId: string;
  category: AnnotationCategoryDTO;
  title: string;
  description: string;
  author: string;
  sourceUrl: string;
  publishTime: string;
  rawContent: string;
};

export type EventDetailPayload = NormalizedEventDTO & {
  sources: Array<{
    extractedEventId: string;
    role: string;
    author: string;
    publishTime: string;
    sourceUrl: string;
    rawContent: string;
  }>;
  relatedLinks: Array<{ url: string; title: string | null }>;
  subEvents: Array<{
    id: string;
    title: string;
    startTime: string | null;
    isCancelled: boolean;
  }>;
  annotations: AnnotationEntryDTO[];
};

export async function fetchEventDetail(id: string): Promise<EventDetailPayload> {
  const res = await fetch(`/api/events/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Event fetch failed: ${res.status}`);
  return res.json();
}

// ----- Admin types -----

export type SchedulerRunDTO = {
  id: string;
  taskName: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "aborted";
  errorClass: string | null;
  errorMessage: string | null;
  details: Record<string, unknown> | null;
};

export type TaskCardDTO = {
  name: string;
  lastRun: SchedulerRunDTO | null;
  lastSuccess: SchedulerRunDTO | null;
  lastFailure: SchedulerRunDTO | null;
  countsLastHour: { completed: number; failed: number; aborted: number };
};

export type ExtractionFailureGroupDTO = {
  errorClass: string;
  count: number;
  oldest: string;
  newest: string;
};

export type ExtractionFailureSummaryDTO = {
  total: number;
  groups: ExtractionFailureGroupDTO[];
};

export type ReviewQueueItemDTO = {
  decisionId: string;
  decision: string;
  score: number | null;
  signals: Record<string, unknown>;
  reason: string;
  createdAt: string;

  extractedId: string;
  candidateTitle: string;
  candidateDescription: string;
  candidateStartTime: string | null;
  candidateAuthor: string;
  candidateSourceUrl: string;
  candidateRawContent: string;
  candidateScope: string;
  candidateParentHint: string | null;
  candidateArtistName: string | null;
  candidateVenueName: string | null;

  matchedId: string | null;
  matchedTitle: string | null;
  matchedStartTime: string | null;
  matchedVenueName: string | null;
};

export type AdminDashboardPayload = {
  cards: TaskCardDTO[];
  recentRuns: SchedulerRunDTO[];
  extractionFailures: ExtractionFailureSummaryDTO;
  reviewQueue: ReviewQueueItemDTO[];
  events: NormalizedEventDTO[];
  serverTime: string;
};

export async function fetchAdminDashboard(): Promise<AdminDashboardPayload> {
  const res = await fetch(`/api/admin/dashboard`);
  if (!res.ok) throw new Error(`Admin dashboard fetch failed: ${res.status}`);
  return res.json();
}

export async function adminAcceptMerge(
  decisionId: string,
  extractedEventId: string,
  normalizedEventId: string,
): Promise<void> {
  const res = await fetch(`/api/admin/review/${encodeURIComponent(decisionId)}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extractedEventId, normalizedEventId }),
  });
  if (!res.ok) throw new Error(`Merge failed: ${res.status} ${await res.text()}`);
}

export async function adminAcceptNew(
  decisionId: string,
  extractedEventId: string,
): Promise<void> {
  const res = await fetch(`/api/admin/review/${encodeURIComponent(decisionId)}/new`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extractedEventId }),
  });
  if (!res.ok) throw new Error(`Accept-as-new failed: ${res.status} ${await res.text()}`);
}

export type EventEditFields = {
  title?: string;
  description?: string;
  startTime?: string | null;
  endTime?: string | null;
  isCancelled?: boolean;
  tags?: string[];
  parentEventId?: string | null;
  venueId?: string | null;
  venueName?: string | null;
  venueUrl?: string | null;
  type?: string;
};

export async function adminUpdateEvent(id: string, fields: EventEditFields): Promise<void> {
  const res = await fetch(`/api/admin/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status} ${await res.text()}`);
}

export async function adminReleaseEvent(id: string): Promise<void> {
  const res = await fetch(`/api/admin/events/${encodeURIComponent(id)}/release`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Release failed: ${res.status} ${await res.text()}`);
}
