import React, { useEffect, useMemo, useState } from "react";
import {
  adminReleaseEvent,
  adminUpdateEvent,
  fetchEventDetail,
  type EventDetailPayload,
  type EventEditFields,
} from "./api";

type Props = {
  eventId: string;
  onClose: () => void;
  onSaved: () => void;
};

export function EditEventModal({ eventId, onClose, onSaved }: Props) {
  const [detail, setDetail] = useState<EventDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [isCancelled, setIsCancelled] = useState(false);
  const [tags, setTags] = useState("");
  const [parentEventId, setParentEventId] = useState("");
  const [venueId, setVenueId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDetail(null);
    fetchEventDetail(eventId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setTitle(d.title);
        setDescription(d.description);
        setStartTime(toLocalInput(d.startTime));
        setEndTime(toLocalInput(d.endTime));
        setIsCancelled(d.isCancelled);
        setTags((d.tags ?? []).join(", "));
        setParentEventId(d.parentEventId ?? "");
        setVenueId(d.venueId ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty = useMemo(() => {
    if (!detail) return false;
    return (
      title !== detail.title ||
      description !== detail.description ||
      startTime !== toLocalInput(detail.startTime) ||
      endTime !== toLocalInput(detail.endTime) ||
      isCancelled !== detail.isCancelled ||
      tags !== (detail.tags ?? []).join(", ") ||
      (parentEventId || null) !== (detail.parentEventId ?? null) ||
      (venueId || null) !== (detail.venueId ?? null)
    );
  }, [detail, title, description, startTime, endTime, isCancelled, tags, parentEventId, venueId]);

  const onSave = async () => {
    if (!detail) return;
    setSaving(true);
    setError(null);
    const fields: EventEditFields = {
      title,
      description,
      startTime: fromLocalInput(startTime),
      endTime: fromLocalInput(endTime),
      isCancelled,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      parentEventId: parentEventId.trim() || null,
      venueId: venueId.trim() || null,
    };
    try {
      await adminUpdateEvent(detail.id, fields);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onRelease = async () => {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      await adminReleaseEvent(detail.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-edit" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>

        {error && <div className="modal-error">Error: {error}</div>}
        {!detail && !error && <div className="modal-loading">Loading…</div>}

        {detail && (
          <>
            <header className="modal-header">
              <h2 className="modal-title">Edit event</h2>
              <div className="modal-meta">
                {detail.operatorOwned && detail.operatorEditedAt ? (
                  <span className="badge owned">
                    operator-owned since {new Date(detail.operatorEditedAt).toLocaleString()}
                  </span>
                ) : (
                  <span className="dim">resolver-owned</span>
                )}
              </div>
            </header>

            <div className="form-grid">
              <Field label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Description">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                />
              </Field>
              <Field label="Start">
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </Field>
              <Field label="End">
                <input
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </Field>
              <Field label="Tags (comma-separated)">
                <input value={tags} onChange={(e) => setTags(e.target.value)} />
              </Field>
              <Field label="Venue id">
                <input
                  value={venueId}
                  onChange={(e) => setVenueId(e.target.value)}
                  placeholder={detail.venue?.name ?? "(none)"}
                />
              </Field>
              <Field label="Parent event id">
                <input
                  value={parentEventId}
                  onChange={(e) => setParentEventId(e.target.value)}
                  placeholder={detail.parentTitle ?? "(none)"}
                />
              </Field>
              <Field label="Cancelled">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isCancelled}
                    onChange={(e) => setIsCancelled(e.target.checked)}
                  />
                  <span>Mark as cancelled</span>
                </label>
              </Field>
            </div>

            <footer className="modal-footer">
              {detail.operatorOwned && (
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={onRelease}
                >
                  Release back to resolver
                </button>
              )}
              <div className="modal-footer-spacer" />
              <button type="button" className="btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={onSave}
                disabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * Convert an ISO timestamp to the value format expected by
 * <input type="datetime-local">: YYYY-MM-DDTHH:mm in *local* time.
 * Returns "" when the source is null so the input renders empty.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
