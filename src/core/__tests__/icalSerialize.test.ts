/**
 * RFC 5545 serialization helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeText,
  foldLine,
  formatUtcDate,
  serializeCalendar,
  serializeEvent,
  type ICalEvent,
} from "../icalSerialize";

test("formatUtcDate emits compact UTC form", () => {
  assert.equal(formatUtcDate(new Date("2026-06-15T18:00:00Z")), "20260615T180000Z");
  assert.equal(formatUtcDate(new Date("2026-01-02T03:04:05Z")), "20260102T030405Z");
});

test("escapeText escapes RFC 5545 special chars", () => {
  assert.equal(escapeText("hello, world"), "hello\\, world");
  assert.equal(escapeText("a;b"), "a\\;b");
  assert.equal(escapeText("line1\nline2"), "line1\\nline2");
  assert.equal(escapeText("c:\\path"), "c:\\\\path");
});

test("escapeText handles backslash before other escapes (no double-escape)", () => {
  assert.equal(escapeText("\\,"), "\\\\\\,");
});

test("foldLine returns short lines unchanged", () => {
  assert.equal(foldLine("SUMMARY:hi"), "SUMMARY:hi");
});

test("foldLine wraps at 75 octets with CRLF + space", () => {
  const long = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(long);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "should fold");
  // Each continuation line begins with a single space.
  for (let i = 1; i < parts.length; i++) {
    assert.ok(parts[i]!.startsWith(" "), "continuation begins with space");
  }
  // First line at most 75 octets.
  assert.ok(new TextEncoder().encode(parts[0]!).length <= 75);
});

test("foldLine does not split multi-byte UTF-8 codepoints", () => {
  // Each "あ" is 3 bytes in UTF-8. 30 of them = 90 bytes — well over 75.
  const line = "SUMMARY:" + "あ".repeat(30);
  const folded = foldLine(line);
  const parts = folded.split("\r\n");
  // Re-decoding each part's text portion (after the leading space on continuations)
  // should still be valid UTF-8 and the concatenation should equal the input.
  const reassembled = parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("");
  assert.equal(reassembled, line);
});

test("serializeEvent emits required fields and STATUS", () => {
  const ev: ICalEvent = {
    uid: "abc@oshikatsu",
    dtstamp: new Date("2026-05-04T12:00:00Z"),
    dtstart: new Date("2026-06-15T18:00:00Z"),
    dtend: new Date("2026-06-15T21:00:00Z"),
    summary: "My Concert",
    description: "Doors at 17:30",
    location: "Tokyo Dome",
    url: "https://example.com/event/123",
    sequence: 1,
    status: "CONFIRMED",
  };
  const out = serializeEvent(ev);
  assert.match(out, /BEGIN:VEVENT/);
  assert.match(out, /END:VEVENT/);
  assert.match(out, /UID:abc@oshikatsu/);
  assert.match(out, /DTSTART:20260615T180000Z/);
  assert.match(out, /DTEND:20260615T210000Z/);
  assert.match(out, /SUMMARY:My Concert/);
  assert.match(out, /LOCATION:Tokyo Dome/);
  assert.match(out, /URL:https:\/\/example\.com\/event\/123/);
  assert.match(out, /SEQUENCE:1/);
  assert.match(out, /STATUS:CONFIRMED/);
});

test("serializeEvent CANCELLED status is preserved", () => {
  const ev: ICalEvent = {
    uid: "x@oshikatsu",
    dtstamp: new Date("2026-05-04T12:00:00Z"),
    dtstart: null, dtend: null,
    summary: "Cancelled show", description: "",
    location: null, url: null,
    sequence: 2,
    status: "CANCELLED",
  };
  assert.match(serializeEvent(ev), /STATUS:CANCELLED/);
});

test("serializeCalendar wraps events in VCALENDAR envelope with CRLF endings", () => {
  const out = serializeCalendar("My Cal", []);
  assert.match(out, /^BEGIN:VCALENDAR\r\n/);
  assert.match(out, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(out, /\r\nVERSION:2\.0\r\n/);
  assert.match(out, /\r\nPRODID:/);
  assert.match(out, /\r\nX-WR-CALNAME:My Cal\r\n/);
});
