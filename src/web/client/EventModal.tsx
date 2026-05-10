import React, { useEffect, useState } from "react";
import { fetchEventDetail, type EventDetailPayload } from "./api";
import { formatEventType } from "./format";

type Props = {
  eventId: string;
  onClose: () => void;
  onOpenEvent: (id: string) => void;
};

export function EventModal({ eventId, onClose, onOpenEvent }: Props) {
  const [detail, setDetail] = useState<EventDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchEventDetail(eventId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>

        {error && <div className="modal-error">Error: {error}</div>}
        {!detail && !error && <div className="modal-loading">Loading…</div>}

        {detail && (
          <>
            <header className="modal-header">
              <h2 className="modal-title">{detail.isCancelled ? <s>{detail.title}</s> : detail.title}</h2>
              <div className="modal-meta">
                {detail.type && <span className="badge type">{formatEventType(detail.type)}</span>}
                {detail.artistName && <span>{detail.artistName}</span>}
                {detail.venue && (
                  <>
                    <span className="dot">·</span>
                    <span>{detail.venue.name}</span>
                  </>
                )}
                {detail.startTime && (
                  <>
                    <span className="dot">·</span>
                    <span>{formatDateTime(detail.startTime, detail.endTime)}</span>
                  </>
                )}
                {detail.isCancelled && <span className="badge cancelled">Cancelled</span>}
              </div>
            </header>

            {detail.parentEventId && detail.parentTitle && (
              <button
                className="parent-link"
                type="button"
                onClick={() => onOpenEvent(detail.parentEventId!)}
              >
                ↑ Parent event: {detail.parentTitle}
              </button>
            )}

            {detail.description && (
              <section className="modal-section">
                <h3 className="modal-section-title">Description</h3>
                <p className="modal-description">{detail.description}</p>
              </section>
            )}

            {detail.tags && detail.tags.length > 0 && (
              <section className="modal-section">
                <h3 className="modal-section-title">Tags</h3>
                <div className="tag-list">
                  {detail.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
              </section>
            )}

            {detail.relatedLinks.length > 0 && (
              <section className="modal-section">
                <h3 className="modal-section-title">Related links</h3>
                <ul className="related-links">
                  {detail.relatedLinks.map((l) => (
                    <li key={l.url}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer">
                        ↗ {l.title ?? l.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.subEvents.length > 0 && (
              <section className="modal-section">
                <h3 className="modal-section-title">Sub-events</h3>
                <ul className="sub-event-list">
                  {detail.subEvents.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="sub-event-row"
                        onClick={() => onOpenEvent(s.id)}
                      >
                        <span className={s.isCancelled ? "strike" : ""}>{s.title}</span>
                        {s.startTime && (
                          <span className="sub-event-time">{formatDateTime(s.startTime, null)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.sources.length > 0 && (
              <section className="modal-section">
                <h3 className="modal-section-title">
                  Sources <span className="count">· {detail.sources.length}</span>
                </h3>
                <ul className="source-list">
                  {detail.sources.map((s) => (
                    <li key={s.extractedEventId} className={`source-item role-${s.role}`}>
                      <div className="source-head">
                        <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">@{s.author}</a>
                        <span className="source-time">{formatRelative(s.publishTime)}</span>
                      </div>
                      <div className="source-text">{s.rawContent}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatDateTime(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  const startStr = start.toLocaleString();
  if (!endIso) return startStr;
  const end = new Date(endIso);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return sameDay
    ? `${startStr} – ${end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : `${startStr} – ${end.toLocaleString()}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
