/**
 * Timezone utilities for extraction-time timestamp parsing.
 *
 * Background: the LLM is instructed to emit offset-aware ISO 8601 strings
 * (`±HH:MM` or `Z`). When it forgets, we apply a fallback IANA timezone
 * (artist > config) to turn the offset-less wall-clock time into an
 * absolute instant. The standard `new Date(value)` would otherwise
 * silently use the daemon host's TZ, which has been a source of silent
 * data corruption.
 */

/** Match a trailing `Z` or `±HH:MM` / `±HHMM` offset on an ISO 8601 string. */
const OFFSET_REGEX = /(Z|[+-]\d{2}:?\d{2})$/;

export function hasTimezoneOffset(iso: string): boolean {
  return OFFSET_REGEX.test(iso.trim());
}

/**
 * Compute the offset (minutes east of UTC) of the given timezone at the
 * given instant. Positive for east of UTC (e.g. Asia/Tokyo = +540).
 */
function offsetMinutesAt(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asIfUtc - date.getTime()) / 60000;
}

/**
 * Validate an IANA timezone name. Throws if invalid; otherwise returns it.
 * Cheap — `Intl.DateTimeFormat` rejects unknown names eagerly.
 */
export function assertValidTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }
}

/**
 * Parse an ISO 8601 string. If it carries an offset, parse normally.
 * Otherwise interpret the wall-clock time as being in `fallbackTimezone`
 * (IANA) and return the corresponding absolute instant.
 *
 * Edge cases near DST transitions (skipped/ambiguous local times) are not
 * specially handled — for `Asia/Tokyo` (no DST) this is exact. For DST
 * zones the result may be off by an hour during the transition window;
 * acceptable for the extraction fallback path.
 */
export function parseIsoWithFallbackTimezone(
  iso: string,
  fallbackTimezone: string
): Date {
  const trimmed = iso.trim();
  if (hasTimezoneOffset(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
    }
    return parsed;
  }

  // Offset-less. Treat the wall-clock as UTC first to get a guess.
  const utcGuess = new Date(trimmed + "Z");
  if (Number.isNaN(utcGuess.getTime())) {
    throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
  }
  // The TZ's offset at that local moment, then back-correct.
  const offsetMin = offsetMinutesAt(utcGuess, fallbackTimezone);
  return new Date(utcGuess.getTime() - offsetMin * 60000);
}

/** Thrown when an offset-less timestamp arrives and no fallback is available. */
export class MissingTimezoneError extends Error {
  constructor(field: string, value: string) {
    super(
      `Offset-less timestamp on ${field} (${value}) and no fallback timezone configured. ` +
        `Set artist.timezone or config.defaultTimezone, or have the LLM emit a TZ-aware ISO string.`
    );
    this.name = "MissingTimezoneError";
  }
}
