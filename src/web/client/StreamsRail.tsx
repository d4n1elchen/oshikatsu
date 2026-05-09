import React from "react";
import type { StreamDTO } from "./api";

const PLATFORM_LABEL: Record<StreamDTO["platform"], string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  niconico: "ニコニコ",
  x: "X",
  other: "Stream",
};

const PLATFORM_ICON: Record<StreamDTO["platform"], string> = {
  youtube: "▶",
  twitch: "🎮",
  niconico: "ニ",
  x: "𝕏",
  other: "🎙",
};

export function StreamsRail({ streams }: { streams: StreamDTO[] }) {
  return (
    <section className="streams-section">
      <div className="section-header">
        <h2 className="section-title">
          Live &amp; upcoming streams <span className="count">· {streams.length}</span>
        </h2>
      </div>

      {streams.length === 0 ? (
        <div className="streams-empty">No streams scheduled.</div>
      ) : (
        <div className="streams-rail" role="list">
          {streams.map((s) => (
            <StreamCard key={s.id} stream={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function StreamCard({ stream }: { stream: StreamDTO }) {
  const start = new Date(stream.startTime);
  const badge = stream.isLive ? "LIVE" : formatRelative(start);

  return (
    <a
      role="listitem"
      className="stream-card"
      href={stream.venueUrl ?? "#"}
      target={stream.venueUrl ? "_blank" : undefined}
      rel={stream.venueUrl ? "noopener noreferrer" : undefined}
    >
      <div className={`stream-thumb plat-${stream.platform}`}>
        <span className={`stream-badge ${stream.isLive ? "live" : "upcoming"}`}>{badge}</span>
        <span className="stream-icon">{PLATFORM_ICON[stream.platform]}</span>
        <span className="stream-platform">{PLATFORM_LABEL[stream.platform]}</span>
      </div>
      <div className="stream-body">
        <div className="stream-title" title={stream.title}>{stream.title}</div>
        <div className="stream-artist">{stream.artistName ?? "Unknown"}</div>
      </div>
    </a>
  );
}

function formatRelative(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms < 60_000) return "soon";
  if (ms < 3_600_000) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 3_600_000) return `in ${Math.floor(ms / 3_600_000)}h`;
  if (ms < 7 * 24 * 3_600_000) {
    const days = Math.floor(ms / (24 * 3_600_000));
    return `in ${days}d`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
