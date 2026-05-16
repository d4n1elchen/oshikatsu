import React, { useCallback, useEffect, useState } from "react";
import {
  adminAcceptMerge,
  adminAcceptNew,
  adminAttachAsSubEvent,
  adminMergeEvent,
  adminRequeueOrphan,
  fetchAdminDashboard,
  fetchOrphans,
  type AdminDashboardPayload,
  type ExtractionFailureSummaryDTO,
  type NormalizedEventDTO,
  type OrphanCategoryDTO,
  type OrphanItemDTO,
  type OrphansSummaryDTO,
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
  const [picker, setPicker] = useState<{ source: NormalizedEventDTO; mode: "merge" | "attach" } | null>(null);

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

        <OrphansPanel initialSummary={data.orphans} />

        <CanonicalEventsPanel
          events={data.events}
          onEdit={(id) => setEditingEventId(id)}
          onMerge={(ev) => setPicker({ source: ev, mode: "merge" })}
          onAttach={(ev) => setPicker({ source: ev, mode: "attach" })}
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

      {picker && (
        <EventTargetPicker
          source={picker.source}
          mode={picker.mode}
          events={data.events}
          onClose={() => setPicker(null)}
          onSubmit={async (targetId, note) => {
            try {
              if (picker.mode === "merge") {
                await adminMergeEvent(picker.source.id, targetId, note);
              } else {
                await adminAttachAsSubEvent(picker.source.id, targetId, note);
              }
              setPicker(null);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
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
  onMerge,
  onAttach,
}: {
  events: NormalizedEventDTO[];
  onEdit: (id: string) => void;
  onMerge: (ev: NormalizedEventDTO) => void;
  onAttach: (ev: NormalizedEventDTO) => void;
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
              <div className="event-row-main">
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
              </div>
              <div className="event-row-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => { e.stopPropagation(); onMerge(ev); }}
                  title="Fold this event into another (this row is deleted)."
                >
                  Merge…
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => { e.stopPropagation(); onAttach(ev); }}
                  title="Attach this event as a sub-event of another (this row is kept)."
                >
                  Sub-of…
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventTargetPicker({
  source,
  mode,
  events,
  onClose,
  onSubmit,
}: {
  source: NormalizedEventDTO;
  mode: "merge" | "attach";
  events: NormalizedEventDTO[];
  onClose: () => void;
  onSubmit: (targetId: string, note?: string) => void | Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const lower = filter.trim().toLowerCase();

  const candidates = events.filter((e) => {
    if (e.id === source.id) return false;
    // For attach mode, only top-level events can be parents.
    if (mode === "attach" && e.parentEventId) return false;
    if (!lower) return true;
    return (
      e.title.toLowerCase().includes(lower) ||
      (e.artistName ?? "").toLowerCase().includes(lower)
    );
  });

  const submit = async () => {
    if (!targetId) return;
    setPending(true);
    try {
      await onSubmit(targetId, note.trim() || undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <header className="modal-header">
          <h2 className="modal-title">
            {mode === "merge" ? "Merge into…" : "Attach as sub-event of…"}
          </h2>
          <div className="modal-meta">
            <span className="dim">{mode === "merge" ? "this event will be deleted" : "this event will keep its own row"}</span>
          </div>
        </header>

        <section className="modal-section">
          <h3 className="modal-section-title">Source</h3>
          <div>{source.title}</div>
          <div className="dim">{source.artistName ?? "—"}</div>
        </section>

        <section className="modal-section">
          <h3 className="modal-section-title">Target</h3>
          <input
            type="search"
            placeholder="Filter by title or artist…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="admin-search"
            autoFocus
          />
          <ul className="target-list">
            {candidates.slice(0, 50).map((ev) => (
              <li
                key={ev.id}
                className={`target-row ${targetId === ev.id ? "selected" : ""}`}
                onClick={() => setTargetId(ev.id)}
              >
                <div className="event-title">{ev.title}</div>
                <div className="event-meta">
                  {ev.artistName ?? "—"}
                  {ev.startTime && ` · ${new Date(ev.startTime).toLocaleString()}`}
                </div>
              </li>
            ))}
            {candidates.length === 0 && <li className="admin-empty">No eligible targets.</li>}
          </ul>
        </section>

        <section className="modal-section">
          <h3 className="modal-section-title">Note (optional)</h3>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why are you doing this? (logged for future resolver tuning)"
            className="admin-search"
          />
        </section>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!targetId || pending}
            onClick={submit}
          >
            {mode === "merge" ? "Merge" : "Attach"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrphansPanel({ initialSummary }: { initialSummary: OrphansSummaryDTO }) {
  const [summary, setSummary] = useState(initialSummary);
  const [filter, setFilter] = useState<OrphanCategoryDTO | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(initialSummary.total > 0);

  useEffect(() => {
    setSummary(initialSummary);
  }, [initialSummary]);

  const reload = async (next: OrphanCategoryDTO | null) => {
    try {
      const s = await fetchOrphans(next ?? undefined);
      setSummary(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFilter = (next: OrphanCategoryDTO | null) => {
    setFilter(next);
    void reload(next);
  };

  const onRequeue = async (id: string) => {
    setPendingId(id);
    try {
      await adminRequeueOrphan(id);
      await reload(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  };

  const counts = new Map<string, number>();
  for (const c of summary.byCategory) counts.set(c.category, c.count);
  const visible = summary.items;

  return (
    <section className="admin-section">
      <button
        type="button"
        className="admin-collapse-head"
        onClick={() => setOpen(!open)}
      >
        <span>{open ? "▾" : "▸"}</span>
        <h2 className="section-title">
          Orphan posts{" "}
          <span className={`count ${summary.total > 0 ? "" : "dim"}`}>· {summary.total}</span>
        </h2>
      </button>
      {open && (
        <>
          <div className="orphan-filter-bar">
            <OrphanFilterChip label="All" count={summary.total} active={filter === null} onClick={() => onFilter(null)} />
            <OrphanFilterChip label="Mood" count={counts.get("mood") ?? 0} active={filter === "mood"} onClick={() => onFilter("mood")} />
            <OrphanFilterChip label="Fan engagement" count={counts.get("fan_engagement") ?? 0} active={filter === "fan_engagement"} onClick={() => onFilter("fan_engagement")} />
            <OrphanFilterChip label="Other" count={counts.get("other") ?? 0} active={filter === "other"} onClick={() => onFilter("other")} />
            {(counts.get("uncategorized") ?? 0) > 0 && (
              <span className="orphan-filter-chip dim" title="Rows from before the category column was added">
                Uncategorized · {counts.get("uncategorized")}
              </span>
            )}
          </div>
          {error && <div className="admin-error-pill">{error}</div>}
          {visible.length === 0 ? (
            <div className="admin-empty">No orphan posts in this bucket.</div>
          ) : (
            <ul className="orphan-list">
              {visible.map((o) => (
                <OrphanRow
                  key={o.id}
                  item={o}
                  pending={pendingId === o.id}
                  onRequeue={() => onRequeue(o.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function OrphanFilterChip({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`orphan-filter-chip ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {label} <span className="dim">· {count}</span>
    </button>
  );
}

function OrphanRow({
  item, pending, onRequeue,
}: { item: OrphanItemDTO; pending: boolean; onRequeue: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const postedIso = item.postedAt ?? item.fetchedAt;
  const text = orphanPreview(item.rawData);
  const authorHandle = extractAuthorHandle(item.rawData);

  return (
    <li className={`orphan-item category-${item.category ?? "uncategorized"}`}>
      <div className="orphan-head" onClick={() => setExpanded(!expanded)}>
        <div className="orphan-meta">
          <span className={`badge orphan ${item.category ?? "uncategorized"}`}>
            {formatOrphanCategory(item.category)}
          </span>
          {item.artistName && <span>{item.artistName}</span>}
          {authorHandle && item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="orphan-author"
              onClick={(e) => e.stopPropagation()}
            >
              @{authorHandle}
            </a>
          )}
          <span className="source-time">{formatRelative(postedIso)}</span>
        </div>
        <div className="orphan-actions">
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={(e) => { e.stopPropagation(); onRequeue(); }}
          >
            Requeue
          </button>
        </div>
      </div>
      <div className={`orphan-text ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)}>{text}</div>
      {expanded && item.reason && (
        <div className="orphan-reason">
          <span className="dim">LLM reason:</span> {item.reason}
        </div>
      )}
    </li>
  );
}

function formatOrphanCategory(c: OrphanCategoryDTO | null): string {
  switch (c) {
    case "mood": return "Mood";
    case "fan_engagement": return "Fan";
    case "other": return "Other";
    default: return "—";
  }
}

function orphanPreview(rawData: Record<string, unknown>): string {
  const legacy = (rawData as any).legacy;
  if (legacy?.full_text) return String(legacy.full_text);
  const top = (rawData?.text ?? rawData?.content ?? rawData?.full_text) as string | undefined;
  if (typeof top === "string" && top.length > 0) return top;
  return JSON.stringify(rawData).slice(0, 200);
}

function extractAuthorHandle(rawData: Record<string, unknown>): string | null {
  // X's GraphQL moved screen_name from `result.legacy` to `result.core` for
  // newer payloads; check both so we cover historical and current rows.
  const user = (rawData as any)?.core?.user_results?.result;
  const handle = user?.core?.screen_name ?? user?.legacy?.screen_name;
  return typeof handle === "string" && handle.length > 0 ? handle : null;
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
