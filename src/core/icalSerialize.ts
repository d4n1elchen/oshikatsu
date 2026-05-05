/**
 * Minimal RFC 5545 (iCalendar) serializer. Covers the subset we emit —
 * VCALENDAR + VEVENT with text fields, UTC timestamps, SEQUENCE, STATUS.
 * Out of scope: timezones, recurrence, attendees, alarms.
 */

export type ICalEvent = {
  uid: string;
  dtstamp: Date;
  dtstart: Date | null;
  dtend: Date | null;
  summary: string;
  description: string;
  location: string | null;
  url: string | null;
  sequence: number;
  status: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
};

const CRLF = "\r\n";

/** Format a Date as a UTC iCalendar timestamp: `20260615T180000Z`. */
export function formatUtcDate(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/**
 * Escape per RFC 5545 §3.3.11 (TEXT). Order matters — backslash first so
 * we don't double-escape the slashes we just inserted.
 */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold a content line at 75 octets per RFC 5545 §3.1. Continuation lines
 * begin with a single space. Octet-counted (UTF-8) so multibyte chars
 * don't overflow the limit.
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(line);
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    // Don't split a multi-byte UTF-8 sequence: walk back if we landed mid-codepoint.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(dec.decode(bytes.slice(offset, end)));
    offset = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return out.join(CRLF + " ");
}

function emit(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

export function serializeEvent(ev: ICalEvent): string {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(emit("UID", ev.uid));
  lines.push(emit("DTSTAMP", formatUtcDate(ev.dtstamp)));
  if (ev.dtstart) lines.push(emit("DTSTART", formatUtcDate(ev.dtstart)));
  if (ev.dtend) lines.push(emit("DTEND", formatUtcDate(ev.dtend)));
  lines.push(emit("SUMMARY", escapeText(ev.summary)));
  if (ev.description) lines.push(emit("DESCRIPTION", escapeText(ev.description)));
  if (ev.location) lines.push(emit("LOCATION", escapeText(ev.location)));
  if (ev.url) lines.push(emit("URL", ev.url));
  lines.push(emit("SEQUENCE", ev.sequence.toString()));
  lines.push(emit("STATUS", ev.status));
  lines.push("END:VEVENT");
  return lines.join(CRLF);
}

export function serializeCalendar(calendarName: string, events: ICalEvent[]): string {
  const lines: string[] = ["BEGIN:VCALENDAR"];
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Oshikatsu//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(emit("X-WR-CALNAME", escapeText(calendarName)));
  for (const ev of events) {
    lines.push(serializeEvent(ev));
  }
  lines.push("END:VCALENDAR");
  // Trailing CRLF per RFC.
  return lines.join(CRLF) + CRLF;
}
