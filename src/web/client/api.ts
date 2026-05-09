/**
 * Client-side API types. Mirror the server DTOs from `src/core/queries/*`
 * but with `Date` fields as ISO strings (JSON.stringify converts them).
 *
 * Kept hand-written rather than auto-derived to keep the client decoupled
 * from server internals; if these drift, a runtime check will surface it
 * faster than a type error would.
 */

export type DashboardPayload = {
  nextEvent: NormalizedEventDTO | null;
  eventFeed: NormalizedEventDTO[];
  timeline: RawItemDTO[];
  serverTime: string;
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
};

export type RawItemDTO = {
  id: string;
  sourceName: string;
  sourceId: string;
  rawData: Record<string, unknown>;
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
