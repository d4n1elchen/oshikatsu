import React from "react";
import type { NormalizedEventDTO } from "./api";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Props = {
  events: NormalizedEventDTO[];
  onEventClick?: (eventId: string) => void;
};

/**
 * 7-day strip starting today. Events with a `start_time` falling
 * within the strip are bucketed under their day. Today's column is
 * highlighted.
 */
export function WeekStrip({ events, onEventClick }: Props) {
  const today = startOfLocalDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => new Date(today.getTime() + i * DAY_MS));

  const eventsByDay = new Map<number, NormalizedEventDTO[]>();
  for (const ev of events) {
    if (!ev.startTime) continue;
    const day = startOfLocalDay(new Date(ev.startTime)).getTime();
    if (day < today.getTime() || day >= today.getTime() + 7 * DAY_MS) continue;
    const list = eventsByDay.get(day) ?? [];
    list.push(ev);
    eventsByDay.set(day, list);
  }

  return (
    <section className="week-section">
      <div className="section-header">
        <h2 className="section-title">This week</h2>
        <span className="section-link">{formatRange(days[0]!, days[6]!)}</span>
      </div>
      <div className="week-strip">
        {days.map((d, i) => {
          const isToday = i === 0;
          const dayEvents = (eventsByDay.get(d.getTime()) ?? []).sort(
            (a, b) => new Date(a.startTime!).getTime() - new Date(b.startTime!).getTime()
          );
          return (
            <div key={d.getTime()} className={`week-day ${isToday ? "today" : ""}`}>
              <div className="week-day-head">
                <span className="week-day-name">{DAY_LABELS[d.getDay()]}</span>
                <span className="week-day-num">{d.getDate()}</span>
              </div>
              {dayEvents.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  className={`week-event ${ev.isCancelled ? "cancelled" : ""}`}
                  title={`${formatTime(new Date(ev.startTime!))} · ${ev.title}`}
                  onClick={onEventClick ? () => onEventClick(ev.id) : undefined}
                >
                  {ev.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatRange(start: Date, end: Date): string {
  const monthStart = start.toLocaleString(undefined, { month: "short" });
  const monthEnd = end.toLocaleString(undefined, { month: "short" });
  if (monthStart === monthEnd) {
    return `${monthStart} ${start.getDate()} — ${end.getDate()}`;
  }
  return `${monthStart} ${start.getDate()} — ${monthEnd} ${end.getDate()}`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
