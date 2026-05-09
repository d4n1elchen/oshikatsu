# Timezone Handling

> **Status:** Landed (extraction path). Display-side TZ work tracked in `TECH_DEBTS.md` ("No venue-level or event-level timezone stored", "TUI displays dates in host-local time").
> **Follow-ups:** Add `venues.timezone` and `normalized_events.timezone` when the Phase 6 dashboard surfaces a cross-TZ display gap; revisit the daemon-host fallback if extraction error rate from `MissingTimezoneError` becomes meaningful.

## Overview

This doc captures how Oshikatsu handles timezones across the pipeline: where TZ matters, where it's lossless, and where we deliberately accept ambiguity. The motivating bug was silent corruption — the LLM emitting offset-less ISO 8601 strings, which `new Date(value)` was interpreting in the daemon host's TZ. The fix is twofold: tighten the prompt to require an offset, and provide a deterministic fallback chain for when the LLM still forgets.

The deliverable is a small `src/core/timezone.ts` helper, a fallback chain wired through `ExtractionEngine` → `ExtractionStrategy.sanitize`, an `artists.timezone` column, and a `config.defaultTimezone` setting. Tests cover the parsing logic and the rejection path.

## Problem

Three connected issues, with very different urgency.

**1. Silent corruption at extraction time.** The extraction prompt asked for "ISO 8601" without specifying that the offset was required. The LLM frequently emitted bare wall-clock strings like `"2026-05-16T18:00:00"`. `parseDateOrThrow(value)` did `new Date(value)`, which JS interprets as the *local* TZ of the running process. Result:

- Daemon on a JST host → stores the right instant.
- Daemon on a UTC host → stores 9 hours late.
- Daemon on a US host → stores 13–17 hours off.

No test caught this. Failures didn't fire — the bad timestamp validates, persists, and ships through `iCalConsumer` to subscribers' calendars, where it appears at the wrong hour. Once the rows land, fixing them needs the deferred reprocess command (see `TECH_DEBTS.md`).

**2. No event-local TZ stored anywhere.** Events are persisted as absolute instants only (`integer({ mode: "timestamp" })`). There is no field saying "this event happens in JST." iCal export side-steps the question by emitting UTC and trusting the calendar client to convert. The TUI uses `toLocaleString()` (host-local). The web UI (Phase 6) will surface the gap: a "Sat 18:00 JST" label is not derivable from an instant alone.

**3. TUI display is host-local.** Cosmetic; an operator viewing JST events from a non-JST host sees them in the host's TZ. Not a correctness issue, but inconsistent.

#1 was actively wrong. #2 and #3 are display gaps with workarounds.

## Goals

- Extraction can never silently coerce a wall-clock string via the daemon's host TZ.
- A fallback chain is defined: explicit offset → artist's home TZ → deployment default → reject.
- The fallback is deterministic and visible: rejection produces a typed error and shows up in `Monitor` failures by class, so operators see when the LLM is dropping offsets.
- No new heavyweight dependency; `Intl.DateTimeFormat` is the only TZ primitive needed.

## Non-Goals

- **No event-local or venue-local TZ storage** in this iteration. Adding `venues.timezone` / `normalized_events.timezone` is the right next step for the display-side gap (#2 above), but it's a separate concern and is deferred until Phase 6 surfaces a concrete need. Tracked in `TECH_DEBTS.md`.
- **No DST-edge correctness.** The fallback parse uses a single offset lookup at the wall-clock instant; for TZs that observe DST, this can be off by an hour during the ambiguous transition window (1–2 hours per year). For `Asia/Tokyo` (no DST), it's exact. Acceptable for the fallback path; the LLM is supposed to emit an offset anyway.
- **No retroactive repair** of timestamps already stored under the old buggy path. Old rows keep their (possibly wrong) values until the deferred reprocess command lands.
- **No TUI display rewrite.** The TUI continues to render host-local. Switching to artist-local TZ is tracked separately.

## Design

### Fallback chain

When the LLM emits a timestamp during extraction, this is the order of attempts:

1. **Offset present** (`Z` or `±HH:MM`) → parse as-is. Always preferred.
2. **No offset, artist has `timezone` set** → interpret the wall-clock as that IANA TZ.
3. **No offset, no artist TZ, `config.defaultTimezone` set** → interpret as that.
4. **No offset, no artist TZ, no config default** → throw `MissingTimezoneError`. Marks the raw item `error` with that error class, surfaces in Monitor.

This makes every offset-less timestamp resolve to *something specific* (artist > config) or *fail loudly* — never the daemon's host TZ.

### Why per-artist + config default

A single global default (config-only) would handle the common case (most artists are JP) but force every non-JP artist to set the global, breaking everyone else. A per-artist setting handles outliers cleanly.

A pure per-artist column without a config default would mean every artist has to be configured before extraction works. That's friction for new operators.

The two-level chain (artist → config) gives one-line setup for the common case (`defaultTimezone: "Asia/Tokyo"`) while letting a touring overseas artist be a one-row override.

### Components

#### `src/core/timezone.ts`

Three exports:

- `hasTimezoneOffset(iso: string): boolean` — regex check for trailing `Z` or `±HH:MM` / `±HHMM`.
- `parseIsoWithFallbackTimezone(iso: string, fallbackTimezone: string): Date` — if `iso` carries an offset, parses it; otherwise interprets the wall-clock as `fallbackTimezone` and returns the corresponding UTC instant.
- `assertValidTimezone(tz: string): string` — validates an IANA name via `Intl.DateTimeFormat`. Used by `WatchListManager` on add/update.
- `MissingTimezoneError` — thrown when offset is missing and no fallback is configured.

Implementation of the fallback parse:

```ts
function offsetMinutesAt(date: Date, timeZone: string): number {
  // Format the UTC instant in the target TZ, reconstruct as if it were UTC,
  // and take the difference. The offset is the gap.
}

export function parseIsoWithFallbackTimezone(iso: string, fallbackTimezone: string): Date {
  if (hasTimezoneOffset(iso.trim())) return new Date(iso);
  const utcGuess = new Date(iso.trim() + "Z");        // wall-clock interpreted as UTC
  const offset = offsetMinutesAt(utcGuess, fallbackTimezone);
  return new Date(utcGuess.getTime() - offset * 60000);
}
```

Hand-rolled rather than pulling in `luxon` (~70KB) or `@js-temporal/polyfill`. Trade-off: DST edges are imprecise; for non-DST TZs (`Asia/Tokyo`, `Asia/Singapore`) it's exact. Revisit if DST-zone artists become common.

#### Schema

Single nullable column added to `artists`:

```ts
timezone: text("timezone")  // IANA name, e.g. "Asia/Tokyo"
```

Migration: `0018_artists_timezone.sql` — `ALTER TABLE artists ADD timezone text`. Existing rows stay NULL and fall through to `config.defaultTimezone`.

#### Config

```ts
defaultTimezone: "Asia/Tokyo"   // or null to disable the fallback entirely
```

Default in `DEFAULT_CONFIG` is `"Asia/Tokyo"` — matches the project's primary user base and means a fresh deployment "just works" without any per-artist setup. Setting `null` enforces strict-mode (every offset-less timestamp fails extraction).

#### Extraction

`SourceContext` gains an optional `fallbackTimezone: string | null`. The engine attaches it after `buildContext`:

```ts
const context = strategy.buildContext(item);
context.fallbackTimezone = await this.resolveFallbackTimezone(item);
// → joins watch_targets → artists.timezone, falls back to config.defaultTimezone
```

`sanitize` reads it via `parseDateOrThrow(value, fieldName, fallbackTimezone)`. The strategy doesn't need to know about config — by the time it's called, the engine has resolved the right answer.

#### Prompt change

Added one rule to the extraction prompt:

> start_time and end_time MUST include a timezone offset (e.g. "2026-05-16T18:00:00+09:00" for JST, or trailing "Z" for UTC). If the source post does not state a timezone explicitly, infer it from the language, location, or venue (e.g. Japanese fan announcements default to +09:00 / JST). Never emit a bare local time like "2026-05-16T18:00:00".

The LLM should now emit offsets the vast majority of the time. The fallback exists to catch the rest, not to be the primary path.

### Why not validate `start_time` at the LLM-output schema layer

We could add a Zod refinement requiring an offset on `start_time`. We didn't, because:

- The LLM occasionally still gets it wrong; rejecting at the schema level would mark the whole extraction as failed even when the timestamp is recoverable via the fallback.
- The fallback path is meant to be a soft net, not a hard rejection.
- The hard rejection happens in `parseDateOrThrow` only when *both* the LLM forgets *and* no fallback is available — which matches the actual unrecoverable case.

## Where TZ is now correct

| Surface | Behavior | Source |
|---|---|---|
| Schema storage | Absolute UTC instants | `integer({ mode: "timestamp" })` |
| Extraction (offset present) | Parsed as-is | `parseDateOrThrow` |
| Extraction (offset missing) | Artist TZ → config default → throw | `parseIsoWithFallbackTimezone` |
| iCal export | UTC `Z` suffix; calendar client converts | `formatUtcDate` |
| Web UI display (planned) | Browser-local in v1; venue/artist-local once stored | `IDEAS.md` / Phase 6 |
| TUI display | Host-local — known cosmetic gap | `TECH_DEBTS.md` |

## Open questions

- **Should the fallback chain include a "log warning when fallback is applied" hook?** Useful operator signal: tells you how often the LLM is dropping offsets, which informs whether the prompt is working. Currently the fallback is silent. Worth adding when there's a place for it (Phase 4 monitoring already has counter primitives).
- **Multiple artists per raw item.** Today every raw item belongs to exactly one watch target → one artist. If we ever ingest content that mentions multiple artists (e.g. collab posts surfaced via hashtag tracking — see `IDEAS.md`), the TZ resolution needs a tiebreaker. Probably "primary artist of the watch target" is still right, but worth re-asking when hashtag tracking lands.
- **DST handling.** If we start serving artists in DST zones (e.g. US/Europe), the single-offset-lookup approach in `parseIsoWithFallbackTimezone` becomes lossy at transition boundaries. Cheapest path: pull in `luxon` or `@js-temporal/polyfill` only at that point; the existing helper's signature is stable.
