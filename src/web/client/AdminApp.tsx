import React, { useCallback, useEffect, useState } from "react";
import {
  adminAcceptMerge,
  adminAcceptNew,
  fetchAdminDashboard,
  type AdminDashboardPayload,
  type ExtractionFailureSummaryDTO,
  type NormalizedEventDTO,
  type ReviewQueueItemDTO,
  type SchedulerRunDTO,
  type TaskCardDTO,
} from "./api";
import { EditEventModal } from "./EditEventModal";
import { Sidebar } from "./Sidebar";

const POLL_INTERVAL_MS = 30_000;

export function AdminApp() {
  const [data, setData] = useState<AdminDashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchAdminDashboard();
      setData(payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const onMerge = async (item: ReviewQueueItemDTO) => {
    if (!item.matchedId) return;
    setActionPending(item.decisionId);
    try {
      await adminAcceptMerge(item.decisionId, item.extractedId, item.matchedId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionPending(null);
    }
  };

  const onAcceptNew = async (item: ReviewQueueItemDTO) => {
    setActionPending(item.decisionId);
    try {
      await adminAcceptNew(item.decisionId, item.extractedId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionPending(null);
    }
  };

  if (error && !data) return <div className="state state-error">Error: {error}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <div className="shell admin-shell">
      <Sidebar surface="admin" />

      <main className="main">
        <header className="header">
          <div className="filter-pill">
            Admin <strong>console</strong>
          </div>
          <div className="server-time">
            {error && <span className="admin-error-pill">{error}</span>}
            Updated {formatRelative(data.serverTime)}
          </div>
        </header>

        <PipelineHealth cards={data.cards} />

        <ReviewQueuePanel
          items={data.reviewQueue}
          actionPending={actionPending}
          onMerge={onMerge}
          onAcceptNew={onAcceptNew}
        />

        <CanonicalEventsPanel
          events={data.events}
          onEdit={(id) => setEditingEventId(id)}
        />

        <ExtractionFailuresPanel summary={data.extractionFailures} />
      </main>

      <RecentRunsRail runs={data.recentRuns} />

      {editingEventId && (
        <EditEventModal
          eventId={editingEventId}
          onClose={() => setEditingEventId(null)}
          onSaved={() => {
            setEditingEventId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------- Panels ----------

function PipelineHealth({ cards }: { cards: TaskCardDTO[] }) {
  return (
    <section className="admin-section">
      <h2 className="section-title">Pipeline health</h2>
      {cards.length === 0 ? (
        <div className="admin-empty">No scheduler runs recorded yet.</div>
      ) : (
        <div className="admin-cards">
          {cards.map((c) => <TaskCard key={c.name} card={c} />)}
        </div>
      )}
    </section>
  );
}

function TaskCard({ card }: { card: TaskCardDTO }) {
  const dotClass = cardDotClass(card);
  const last = card.lastRun;
  const c = card.countsLastHour;
  const total = c.completed + c.failed + c.aborted;
  const ratio = total > 0 ? `${c.completed}/${total} ok in 1h` : "no runs in 1h";

  return (
    <div className={`admin-card ${dotClass}`}>
      <div className="admin-card-head">
        <span className={`status-dot ${dotClass}`} aria-hidden />
        <strong>{card.name}</strong>
        {last && (
          <span className={`status-tag status-${last.status}`}>{last.status}</span>
        )}
      </div>
      <div className="admin-card-meta">
        <div>
          <span className="dim">last ok</span>{" "}
          {card.lastSuccess ? formatRelative(card.lastSuccess.startedAt) : "—"}
        </div>
        <div>
          <span className="dim">last fail</span>{" "}
          {card.lastFailure ? formatRelative(card.lastFailure.startedAt) : "—"}
        </div>
        <div className="dim">{ratio}</div>
      </div>
    </div>
  );
}

function cardDotClass(card: TaskCardDTO): string {
  if (!card.lastRun) return "gray";
  if (card.lastRun.status === "failed") return "red";
  if (card.lastRun.status === "aborted") return "yellow";
  if (card.countsLastHour.failed > 0) return "yellow";
  return "green";
}

function ReviewQueuePanel({
  items,
  actionPending,
  onMerge,
  onAcceptNew,
}: {
  items: ReviewQueueItemDTO[];
  actionPending: string | null;
  onMerge: (item: ReviewQueueItemDTO) => void;
  onAcceptNew: (item: ReviewQueueItemDTO) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <section className="admin-section">
      <h2 className="section-title">
        Review queue <span className="count">· {items.length}</span>
      </h2>
      {items.length === 0 ? (
        <div className="admin-empty">Resolver is happy.</div>
      ) : (
        <ul className="review-list">
          {items.map((item) => {
            const isExpanded = expandedId === item.decisionId;
            const isPending = actionPending === item.decisionId;
            return (
              <li key={item.decisionId} className="review-item">
                <div
                  className="review-head"
                  onClick={() => setExpandedId(isExpanded ? null : item.decisionId)}
                >
                  <div className="review-title">
                    {item.candidateTitle}
                    {item.candidateScope === "sub" && <span className="badge sub">sub</span>}
                  </div>
                  <div className="review-meta">
                    {item.candidateArtistName && <span>{item.candidateArtistName}</span>}
                    {item.score != null && (
                      <>
                        <span className="dot">·</span>
                        <span>score {item.score.toFixed(2)}</span>
                      </>
                    )}
                    {item.candidateStartTime && (
                      <>
                        <span className="dot">·</span>
                        <span>{new Date(item.candidateStartTime).toLocaleString()}</span>
                      </>
                    )}
                  </div>
                  <div className="review-actions">
                    {item.matchedId && (
                      <button
                        type="button"
                        className="btn primary"
                        disabled={isPending}
                        onClick={(e) => { e.stopPropagation(); onMerge(item); }}
                      >
                        Merge
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={isPending}
                      onClick={(e) => { e.stopPropagation(); onAcceptNew(item); }}
                    >
                      New
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="review-detail">
                    <div className="review-reason">{item.reason}</div>
                    {item.matchedTitle && (
                      <div className="review-matched">
                        <span className="dim">matched →</span> {item.matchedTitle}
                        {item.matchedStartTime &&
                          <span className="dim"> · {new Date(item.matchedStartTime).toLocaleString()}</span>
                        }
                        {item.matchedVenueName && <span className="dim"> · {item.matchedVenueName}</span>}
                      </div>
                    )}
                    <div className="review-raw">
                      <div className="dim">@{item.candidateAuthor}</div>
                      <div className="review-raw-text">{item.candidateRawContent}</div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CanonicalEventsPanel({
  events,
  onEdit,
}: {
  events: NormalizedEventDTO[];
  onEdit: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const lower = filter.trim().toLowerCase();
  const filtered = lower
    ? events.filter((e) =>
        e.title.toLowerCase().includes(lower) ||
        (e.artistName ?? "").toLowerCase().includes(lower) ||
        (e.venue?.name ?? e.venueName ?? "").toLowerCase().includes(lower)
      )
    : events;

  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <h2 className="section-title">
          Canonical events <span className="count">· {events.length}</span>
        </h2>
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="admin-search"
        />
      </div>
      {filtered.length === 0 ? (
        <div className="admin-empty">{lower ? "No matches." : "No events yet."}</div>
      ) : (
        <ul className="event-list admin-events">
          {filtered.slice(0, 50).map((ev) => (
            <li key={ev.id} className="event-row clickable" onClick={() => onEdit(ev.id)}>
              <div className="event-title">
                {ev.isCancelled ? <s>{ev.title}</s> : ev.title}
                {ev.operatorOwned && <span className="badge owned">owned</span>}
              </div>
              <div className="event-meta">
                {ev.artistName ?? "—"}
                {ev.startTime && ` · ${new Date(ev.startTime).toLocaleString()}`}
                {(ev.venue?.name ?? ev.venueName) && ` · ${ev.venue?.name ?? ev.venueName}`}
                {` · ${ev.sourceCount} source${ev.sourceCount === 1 ? "" : "s"}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExtractionFailuresPanel({ summary }: { summary: ExtractionFailureSummaryDTO }) {
  const [open, setOpen] = useState(summary.total > 0);
  return (
    <section className="admin-section">
      <button
        type="button"
        className="admin-collapse-head"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <h2 className="section-title">
          Extraction failures{" "}
          <span className={`count ${summary.total > 0 ? "warn" : ""}`}>· {summary.total}</span>
        </h2>
      </button>
      {open && (
        summary.total === 0 ? (
          <div className="admin-empty">No errored items.</div>
        ) : (
          <ul className="failure-list">
            {summary.groups.map((g) => (
              <li key={g.errorClass} className="failure-row">
                <span className="failure-class">{g.errorClass}</span>
                <span className="failure-count">{g.count}</span>
                <span className="dim">
                  oldest {formatRelative(g.oldest)} · newest {formatRelative(g.newest)}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function RecentRunsRail({ runs }: { runs: SchedulerRunDTO[] }) {
  const [selected, setSelected] = useState<SchedulerRunDTO | null>(null);
  return (
    <aside className="runs-rail">
      <h2 className="section-title">Recent runs</h2>
      <ul className="runs-list">
        {runs.map((run) => (
          <li
            key={run.id}
            className={`run-row run-${run.status}`}
            onClick={() => setSelected(run)}
          >
            <div className="run-head">
              <span className="run-task">{run.taskName}</span>
              <span className="run-time">{formatRelative(run.startedAt)}</span>
            </div>
            <div className="run-meta">
              <span className={`status-tag status-${run.status}`}>{run.status}</span>
              <span className="dim">{formatDuration(run)}</span>
            </div>
          </li>
        ))}
      </ul>
      {selected && <RunDetailModal run={selected} onClose={() => setSelected(null)} />}
    </aside>
  );
}

function RunDetailModal({ run, onClose }: { run: SchedulerRunDTO; onClose: () => void }) {
  return (
    <div className="modal-backdrop open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <header className="modal-header">
          <h2 className="modal-title">{run.taskName}</h2>
          <div className="modal-meta">
            <span className={`status-tag status-${run.status}`}>{run.status}</span>
            <span className="dot">·</span>
            <span>{new Date(run.startedAt).toLocaleString()}</span>
            <span className="dot">·</span>
            <span>{formatDuration(run)}</span>
          </div>
        </header>
        {run.errorMessage && (
          <section className="modal-section">
            <h3 className="modal-section-title">{run.errorClass ?? "Error"}</h3>
            <pre className="run-error">{run.errorMessage}</pre>
          </section>
        )}
        {run.details && Object.keys(run.details).length > 0 && (
          <section className="modal-section">
            <h3 className="modal-section-title">Details</h3>
            <pre className="run-details">{JSON.stringify(run.details, null, 2)}</pre>
          </section>
        )}
      </div>
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

function formatDuration(run: SchedulerRunDTO): string {
  if (!run.finishedAt) return "running…";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}
