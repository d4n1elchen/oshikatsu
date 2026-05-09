import React from "react";
import type { OshiDTO } from "./api";

const ACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000;       // green dot
const RECENT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;   // pink dot

type Props = {
  oshis: OshiDTO[];
  activeOshi: string | null;
  onSelect: (handle: string | null) => void;
};

export function Sidebar({ oshis, activeOshi, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">推</div>
        <div className="brand-name">Oshikatsu</div>
      </div>

      <div className="sidebar-label">Watching</div>

      <nav className="oshi-list">
        <button
          type="button"
          className={`oshi-row ${activeOshi === null ? "active" : ""}`}
          onClick={() => onSelect(null)}
        >
          <span className="oshi-dot active" aria-hidden />
          <span className="oshi-name">All oshis</span>
          <span className="oshi-meta">{oshis.length}</span>
        </button>

        <div className="sidebar-divider" />

        {oshis.map((o) => {
          const dotClass = activityDotClass(o.lastActivityAt);
          const meta = formatLastActivity(o.lastActivityAt);
          return (
            <button
              type="button"
              key={o.id}
              className={`oshi-row ${activeOshi === o.handle ? "active" : ""}`}
              onClick={() => onSelect(o.handle)}
            >
              <span className={`oshi-dot ${dotClass}`} aria-hidden />
              <span className="oshi-name">
                {o.name} <span className="handle">@{o.handle}</span>
              </span>
              <span className="oshi-meta">{meta}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function activityDotClass(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < ACTIVE_THRESHOLD_MS) return "active";
  if (ms < RECENT_THRESHOLD_MS) return "recent";
  return "";
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 30 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d`;
  return `${Math.floor(ms / (30 * 86_400_000))}mo`;
}
