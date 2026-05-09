import React, { useEffect, useState } from "react";
import { fetchDashboard, type DashboardPayload } from "./api";
import { EventModal } from "./EventModal";
import { Sidebar } from "./Sidebar";
import { StreamsRail } from "./StreamsRail";
import { WeekStrip } from "./WeekStrip";
import { useUrlParam } from "./useUrlState";

const POLL_INTERVAL_MS = 30_000;

export function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oshi, setOshi] = useUrlParam("oshi");
  const [eventId, setEventId] = useUrlParam("event");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const payload = await fetchDashboard({ oshi: oshi ?? undefined });
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [oshi]);

  if (error && !data) return <div className="state state-error">Error: {error}</div>;
  if (!data) return <div className="state">Loading…</div>;

  const activeName =
    data.activeOshi ? data.oshis.find((o) => o.handle === data.activeOshi)?.name ?? data.activeOshi : "All oshis";

  return (
    <div className="shell">
      <Sidebar oshis={data.oshis} activeOshi={data.activeOshi} onSelect={setOshi} />

      <main className="main">
        <header className="header">
          <div className="filter-pill">
            Showing <strong>{activeName}</strong>
          </div>
          <div className="server-time">Updated {formatRelative(data.serverTime)}</div>
        </header>

        <section
          className={`hero ${data.nextEvent ? "clickable" : ""}`}
          onClick={data.nextEvent ? () => setEventId(data.nextEvent!.id) : undefined}
        >
          <div className="hero-label">Next event</div>
          {data.nextEvent ? (
            <>
              <h1 className="hero-title">{data.nextEvent.title}</h1>
              <div className="hero-meta">
                {data.nextEvent.artistName && <span>{data.nextEvent.artistName}</span>}
                {data.nextEvent.venue && (
                  <>
                    <span className="dot">·</span>
                    <span>{data.nextEvent.venue.name}</span>
                  </>
                )}
                {data.nextEvent.startTime && (
                  <>
                    <span className="dot">·</span>
                    <span>{new Date(data.nextEvent.startTime).toLocaleString()}</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="hero-empty">Nothing on the horizon.</div>
          )}
        </section>

        <StreamsRail streams={data.streams} />

        <WeekStrip events={data.eventFeed} onEventClick={setEventId} />

        <section>
          <h2 className="section-title">
            Latest <span className="count">· {data.eventFeed.length}</span>
          </h2>
          <ul className="event-list">
            {data.eventFeed.slice(0, 20).map((ev) => (
              <li
                key={ev.id}
                className="event-row clickable"
                onClick={() => setEventId(ev.id)}
              >
                <div className="event-title">
                  {ev.isCancelled ? <s>{ev.title}</s> : ev.title}
                </div>
                <div className="event-meta">
                  {ev.artistName ?? "—"}
                  {ev.startTime && ` · ${new Date(ev.startTime).toLocaleString()}`}
                  {ev.venue?.name && ` · ${ev.venue.name}`}
                  {` · ${ev.sourceCount} source${ev.sourceCount === 1 ? "" : "s"}`}
                  {ev.parentEventId && (
                    <button
                      type="button"
                      className="parent-chip"
                      onClick={(e) => { e.stopPropagation(); setEventId(ev.parentEventId!); }}
                    >
                      ↑ parent
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <aside className="timeline-rail">
        <h2 className="section-title">Timeline</h2>
        <ul className="timeline-list">
          {data.timeline.map((post) => (
            <li key={post.id} className="timeline-post">
              <div className="timeline-head">
                <span className="timeline-name">{post.artistName}</span>
                <span className="timeline-time">{formatRelative(post.fetchedAt)}</span>
              </div>
              <div className="timeline-text">{extractText(post.rawData)}</div>
            </li>
          ))}
        </ul>
      </aside>

      {eventId && (
        <EventModal
          eventId={eventId}
          onClose={() => setEventId(null)}
          onOpenEvent={(id) => setEventId(id)}
        />
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function extractText(rawData: Record<string, unknown>): string {
  const legacy = (rawData as any).legacy;
  if (legacy?.full_text) return String(legacy.full_text);
  return JSON.stringify(rawData).slice(0, 120);
}
