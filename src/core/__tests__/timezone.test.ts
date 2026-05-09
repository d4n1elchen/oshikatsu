import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasTimezoneOffset,
  parseIsoWithFallbackTimezone,
  assertValidTimezone,
  MissingTimezoneError,
} from "../timezone";

test("hasTimezoneOffset detects Z and ±HH:MM forms", () => {
  assert.equal(hasTimezoneOffset("2026-05-16T18:00:00Z"), true);
  assert.equal(hasTimezoneOffset("2026-05-16T18:00:00+09:00"), true);
  assert.equal(hasTimezoneOffset("2026-05-16T18:00:00-05:00"), true);
  assert.equal(hasTimezoneOffset("2026-05-16T18:00:00+0900"), true);
  assert.equal(hasTimezoneOffset("2026-05-16T18:00:00"), false);
  assert.equal(hasTimezoneOffset("2026-05-16"), false);
});

test("parseIsoWithFallbackTimezone passes through offset-aware strings", () => {
  const d = parseIsoWithFallbackTimezone("2026-05-16T18:00:00+09:00", "America/New_York");
  // 18:00 JST = 09:00 UTC
  assert.equal(d.toISOString(), "2026-05-16T09:00:00.000Z");
});

test("parseIsoWithFallbackTimezone applies fallback TZ when offset is missing", () => {
  // 18:00 wall-clock in JST = 09:00 UTC
  const d = parseIsoWithFallbackTimezone("2026-05-16T18:00:00", "Asia/Tokyo");
  assert.equal(d.toISOString(), "2026-05-16T09:00:00.000Z");
});

test("parseIsoWithFallbackTimezone with non-DST eastern TZ", () => {
  // 18:00 in Asia/Singapore (UTC+8) = 10:00 UTC
  const d = parseIsoWithFallbackTimezone("2026-05-16T18:00:00", "Asia/Singapore");
  assert.equal(d.toISOString(), "2026-05-16T10:00:00.000Z");
});

test("parseIsoWithFallbackTimezone rejects invalid input", () => {
  assert.throws(
    () => parseIsoWithFallbackTimezone("not a date", "Asia/Tokyo"),
    /Invalid ISO 8601/
  );
});

test("assertValidTimezone accepts known IANA names and rejects garbage", () => {
  assert.equal(assertValidTimezone("Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(assertValidTimezone("UTC"), "UTC");
  assert.throws(() => assertValidTimezone("Mars/Olympus_Mons"), /Invalid IANA timezone/);
});

test("MissingTimezoneError carries field name and value", () => {
  const err = new MissingTimezoneError("start_time", "2026-05-16T18:00:00");
  assert.equal(err.name, "MissingTimezoneError");
  assert.match(err.message, /start_time/);
  assert.match(err.message, /2026-05-16T18:00:00/);
});
