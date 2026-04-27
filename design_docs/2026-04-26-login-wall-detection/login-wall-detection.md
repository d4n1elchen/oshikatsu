# Login-Wall and Anti-Bot Detection

> **Status:** Landed. 8 tests in `src/connectors/twitter/__tests__/TwitterConnector.test.ts` cover all three detection signals + regression guards.
> **Follow-ups:** Anti-bot marker list will drift with platform updates — periodic refresh tracked in `TECH_DEBTS.md`.

## Overview

This document specifies how the Twitter/X connector detects subtle failure modes — login walls, anti-bot interstitials, and unexpectedly empty timelines caused by GraphQL shape changes — and surfaces them as typed, distinguishable errors instead of clean zero-item fetches.

The change is contained to `src/connectors/twitter/index.ts` and the `BaseConnector` error contract. No schema change. No new tables.

## Problem

After the re-throw fix landed (2026-04-26 commit, `TwitterConnector.fetchUpdates` now propagates navigation/scrape exceptions), one silent-failure mode remains:

- The page loads as HTTP 200 but is actually a login wall (e.g., redirected to `x.com/i/flow/login`).
- The page loads, but X has changed the GraphQL response shape so the `UserTweets` handler never fires.
- An anti-bot interstitial returns 200 with a CAPTCHA or "verifying you're a human" page.

In all three cases the connector returns `[]`. The scheduler logs `Fetched 0 item(s)`, indistinguishable from a real quiet day on the timeline. Days can pass before anyone notices that an artist's announcements are silently being missed.

This is the last remaining "silence = failure" path in ingestion.

## Goals

- Distinguish "the timeline really was empty" from "we couldn't read the timeline" at the connector boundary.
- Use deterministic, low-noise signals — no fuzzy heuristics that flag healthy pages as failures.
- Throw typed errors so the scheduler logs them specifically and the future Monitor view can categorize them.
- Never silently lose data: every plausible "soft failure" path must produce either real items or a thrown error.

## Non-Goals

- Do not implement automated re-login or CAPTCHA solving. If we detect a login wall, the operator runs `npm run login:twitter` manually — same as today.
- Do not implement retry/backoff inside the connector. The scheduler runs again on its own interval; transient failures resolve themselves on the next cycle.
- Do not change the `BaseConnector` interface signature. The change is in *what kind of errors* `fetchUpdates` throws, not its shape.
- Do not implement the future Monitoring component (Component 7 in `ARCHITECTURE.md`); just produce signals it can consume later.

## Detection Signals

Three distinct signals, each cheap and deterministic.

### 1. Login wall — URL probe

After `page.goto(targetUrl)` resolves, check `page.url()`:

- If it contains `/i/flow/login`, `/login`, or `/account/access`, the request was redirected to a login flow.
- This is a strong signal — these paths are reserved for authenticated entry, not public profile views.

### 2. Anti-bot interstitial — DOM probe

After waiting for initial network requests to settle, check for known interstitial markers in the DOM:

- A page-level element with text like `"verifying you are human"` or `"Sorry, you have been blocked"`.
- Cloudflare's `<title>` of `"Just a moment..."`.

These are deliberately narrow checks — looking for specific known phrases, not generic content analysis. False positives (e.g., a tweet *quoting* "verifying you are human") are mitigated by the check scope (page title or top-level container, not arbitrary tweet text).

### 3. Empty timeline + missing GraphQL — handler fire counter

The existing implementation attaches a `response` listener that filters for `UserTweets` GraphQL responses. We add a counter that increments on each handler invocation.

After scrolling completes:

- If `rawItems.length === 0` AND `userTweetsResponseCount === 0`, the timeline GraphQL endpoint never fired. This means the page didn't behave like a normal profile page — likely a shape change on X's side, or the page never loaded the timeline (e.g., suspended account).
- If `rawItems.length === 0` AND `userTweetsResponseCount > 0`, the endpoint fired but returned no entries. This is consistent with a genuinely empty profile (new account, deleted tweets) and is *not* a failure.

This split is the key insight: "no GraphQL responses" is a failure signal, "GraphQL responded with no entries" is a quiet-day signal.

## Error Class Hierarchy

Three typed errors, all subclasses of `Error`, all thrown from `fetchUpdates`:

```ts
export class TwitterFetchError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TwitterFetchError";
  }
}

export class LoginWallError extends TwitterFetchError {
  constructor(public readonly resolvedUrl: string) {
    super(`Login wall detected; redirected to ${resolvedUrl}`);
    this.name = "LoginWallError";
  }
}

export class AntiBotError extends TwitterFetchError {
  constructor(public readonly marker: string) {
    super(`Anti-bot interstitial detected: ${marker}`);
    this.name = "AntiBotError";
  }
}

export class TimelineShapeError extends TwitterFetchError {
  constructor() {
    super("Page loaded but UserTweets GraphQL response never fired; likely shape change");
    this.name = "TimelineShapeError";
  }
}
```

The base `TwitterFetchError` is also used for raw navigation/scrape exceptions (replacing the bare `throw e` from the current code) so the scheduler's catch can recognize the connector's failure family with `instanceof TwitterFetchError`.

## Connector Behavior Changes

```
async fetchUpdates(target):
    attach response handler that:
      - parses tweets as before
      - increments userTweetsResponseCount on each UserTweets response

    try:
        await page.goto(targetUrl)

        # NEW: login-wall probe
        const resolved = page.url()
        if resolved matches login-flow patterns:
            throw new LoginWallError(resolved)

        # NEW: anti-bot probe
        const marker = await detectAntiBotMarker(page)
        if marker:
            throw new AntiBotError(marker)

        scroll loop as before
    finally:
        remove response handler

    # NEW: shape-change probe
    if rawItems.length == 0 and userTweetsResponseCount == 0:
        throw new TimelineShapeError()

    return rawItems[:limit]
```

The probe order matters: login wall and anti-bot are checked *before* scrolling, since scrolling a login page is wasted time.

## Scheduler / Logging Integration

The scheduler's existing per-target catch already logs `Failed to fetch/save watch target X: <error>` and continues to the next target. With typed errors, the log line is automatically more informative because `error.name` and `error.message` carry the failure category and detail.

No change to scheduler code is required for Phase 1 of this work. Phase 2 (when the Monitoring component lands) will pattern-match on `instanceof TwitterFetchError` subclasses to route alerts:

- `LoginWallError` → operator action required (re-run `login:twitter`).
- `AntiBotError` → back off, possibly tighten ingestion interval, manual review.
- `TimelineShapeError` → likely connector update needed; flag for code change.

## Testing Strategy

Unit tests with a mocked Playwright `page` object. Three required cases plus regression guards:

1. **Login wall detected.** `page.goto` resolves to a `/login` URL → expect `LoginWallError`.
2. **Anti-bot detected.** `page.title()` returns `"Just a moment..."` → expect `AntiBotError`.
3. **Shape change detected.** Scrolling completes with zero items AND zero GraphQL responses → expect `TimelineShapeError`.
4. **Genuinely empty timeline.** Scrolling completes with zero items but ≥1 GraphQL response → returns `[]` cleanly, no error.
5. **Normal fetch.** Items are collected → returns the array.
6. **Hard navigation error.** `page.goto` throws → re-thrown wrapped as `TwitterFetchError` (regression for the existing re-throw fix).

Mocking strategy: `TwitterConnector` doesn't currently accept a Playwright instance via constructor — we'd add an optional override (same DI pattern as `EventResolver`/`VenueResolver`) so tests can inject a fake.

## Open Questions

1. **Anti-bot marker list maintenance.** The marker list (Cloudflare phrases, X-specific blocked-page text) will drift as those services update their pages. We should keep the list small, well-commented, and easy to extend. Worth extracting as a constant array so it can be updated without touching the detection logic.

2. **Should `AntiBotError` trigger a longer scheduler back-off automatically?** If we hammer X during an anti-bot block, we likely worsen our reputation. The scheduler currently retries on its normal interval. Out of scope for this design; defer to the Monitor work.

3. **Do we want to capture a screenshot on detection?** Useful for debugging but adds a moving piece (file paths, retention, sensitive data). Defer.

## Tech Debts to Record (post-implementation)

After landing this design, update `TECH_DEBTS.md`:

- Remove the existing "Login-wall / anti-bot detection is not explicit" entry (it will be resolved).
- Add: "Anti-bot marker list will drift as platforms update their pages; needs periodic refresh — see `src/connectors/twitter/antiBotMarkers.ts`."
- The "Connector depends on X internal GraphQL shape" entry stays — `TimelineShapeError` makes shape changes loud, but doesn't fix the underlying fragility.

## Cross-References

- `src/connectors/twitter/index.ts` — implementation target.
- `src/core/Scheduler.ts` — existing per-target catch logs the typed error name automatically; no change needed for Phase 1.
- `src/connectors/types.ts` — `BaseConnector` interface; no change.
- `design_docs/2026-04-23-phase1-designs/twitter-connector.md` — base connector design.
- `TECH_DEBTS.md` — entries to update after impl.
- `ARCHITECTURE.md` — Component 7 (Monitoring) is the eventual consumer of these typed errors.

## Implementation Plan

1. Add `TwitterFetchError` and three subclasses in `src/connectors/twitter/errors.ts`.
2. Add `userTweetsResponseCount` to the existing response handler.
3. Add `detectLoginWall(page)`, `detectAntiBotMarker(page)` helpers.
4. Add the three probe points in `fetchUpdates` per the pseudocode above.
5. Wrap any non-typed exceptions thrown from `page.goto` / scrolling in `TwitterFetchError(...)` to preserve `instanceof` consistency.
6. Add DI for the Playwright page so tests can inject a mock.
7. Add 6 tests per the Testing section.
8. Update `TECH_DEBTS.md`.

Estimated effort: 2 hours including tests.
