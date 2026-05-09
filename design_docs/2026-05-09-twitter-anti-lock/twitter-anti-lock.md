# Twitter Connector Anti-Lock Hardening

> **Status:** Proposed.
> **Follow-ups:** Behavioral fingerprinting items (wheel events, mouse movement, viewport jitter, schedule jitter) tracked in `TECH_DEBTS.md` after this lands.

## Overview

The Twitter/X connector reads public profile timelines via a logged-in Playwright browser. The operator's previous X account was locked. This document inventories the connector's fingerprint and behavior tells, picks the smallest set of changes most likely to have caused the lock, and specifies the fixes.

The change is contained to `src/connectors/twitter/index.ts`, `src/scripts/twitterLogin.ts`, a new `src/connectors/twitter/browser.ts`, and `config.yaml` / `src/config.ts`. No schema change. No new tables.

## Problem

Three categories of risk on X for a Playwright-driven session:

1. **Login fingerprint vs. scraping fingerprint mismatch.** The login script and the scraping connector share the same `userDataDir`, so the auth cookie minted in one session is reused by the other. They launch with *different* `headless` modes, *different* user-agents, and *different* viewport options. From X's view, an `auth_token` cookie that suddenly starts being presented from a visibly different browser is the canonical "stolen cookie / automation handoff" signal.
2. **Hard-coded outdated UA.** The connector pins `Chrome/121.0.0.0` (Jan 2024) in [src/connectors/twitter/index.ts:69](../../src/connectors/twitter/index.ts). Today is 2026-05; bundled Chromium is several major versions newer. `navigator.userAgent` will contradict `navigator.userAgentData.brands` and the actual Chromium feature set — a high-confidence bot tell.
3. **Headless mode + behavioral robotics.** `headless: true` is detectable on its own. Combined with programmatic `window.scrollBy` (no `wheel` events), no mouse movement, fixed viewport, and metronomic per-page timing, the session is recognizable as automated even when stealth flags hide the obvious `navigator.webdriver` signals.

The last symptom of #1 + #3 is what triggered this review: the persistent session was found logged out (auth_token cookie absent), serving the degraded "Tweet Highlights" preview to the connector. We don't have evidence proving a lock vs. a session expiry, but the user's account history strongly suggests X flagged the prior account.

## Goals

- Eliminate the launch-options divergence between `twitterLogin.ts` and the connector. Same UA, same viewport, same headless mode, same flags.
- Remove the hard-coded UA so `navigator.userAgent` and the actual Chromium fingerprint stay consistent automatically.
- Run the scraper headful by default, since detection of headless Chromium is well-documented.
- Keep the change small and reversible. The high-leverage fixes are config-level, not architectural.

## Non-Goals

- No browser automation evasion library (e.g., `playwright-extra` + stealth plugin). These move quickly, are heavy dependencies, and X's detection tracks them. The defaults plus consistent fingerprint is the correct primitive; advanced evasion belongs in a separate, explicitly-opt-in design.
- No CAPTCHA solving, no proxy rotation, no IP cycling.
- No replacement of the in-Playwright login flow with cookie-import-from-real-Chrome. That is a stronger fix but adds a moving piece (parsing Chrome's encrypted cookie store, OS keychain access). Tracked as future work in `TECH_DEBTS.md`.
- No behavioral simulation pass (mouse-wheel scroll, mouse movement, varied dwell). Each is small but the combination expands surface area; defer until we have evidence that fingerprint consistency alone is insufficient.

## Risk Inventory

What could trigger a lock, ranked by my read of likely contribution:

| # | Risk | Severity | Address now? |
|---|------|----------|--------------|
| 1 | Login session UA/viewport/headless ≠ scraping session | High | **Yes** |
| 2 | Hard-coded Chrome 121 UA contradicts bundled Chromium | High | **Yes** |
| 3 | `headless: true` is independently detectable | High | **Yes** |
| 4 | Login itself happens inside Playwright (any login from automation is suspicious) | Medium | Defer (separate design) |
| 5 | `window.scrollBy` emits no `wheel` events | Medium | Defer |
| 6 | Fixed 3000ms post-load wait, fixed 1500ms scroll delay | Medium | Defer |
| 7 | No mouse movement at all | Medium | Defer |
| 8 | Fixed `1280×800` viewport every session | Low | Defer |
| 9 | Sequential profile hops at 3s base delay regardless of fleet size | Low | Defer (configurable already) |
| 10 | Ingestion fires on the dot every 60 min | Low | Defer |

Items 4–10 are real but each is incremental once #1–#3 are fixed. They belong in `TECH_DEBTS.md` so future investigation can pick them up; they do not block this change.

## Design

### Shared launch options

A new module, `src/connectors/twitter/browser.ts`, exposes a single helper:

```ts
export interface LaunchOptionsInput {
  userDataDir: string;
  headless: boolean;
}

export function buildLaunchOptions(opts: LaunchOptionsInput): LaunchOptions {
  return {
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    // Intentionally NO userAgent override — let bundled Chromium send its
    // real UA so navigator.userAgent matches navigator.userAgentData and
    // the actual Chromium feature set.
  };
}
```

Both [src/connectors/twitter/index.ts](../../src/connectors/twitter/index.ts) (`TwitterConnector.start`) and [src/scripts/twitterLogin.ts](../../src/scripts/twitterLogin.ts) call `chromium.launchPersistentContext(userDataDir, buildLaunchOptions({...}))`. The only difference between them is the `headless` value passed in by the caller. The login script always passes `headless: false` (the operator must see the form to type into); the connector passes whatever `config.twitter.headless` says.

This guarantees that the auth cookie stays inside one fingerprint family — same UA, same viewport, same flags — across login and scraping. With `config.twitter.headless: false` (next change), the only remaining difference is window visibility, which is *not* part of the device fingerprint surface.

### `headless: false` by default

Switch [config.yaml](../../config.yaml) and the `DEFAULT_CONFIG` in [src/config.ts](../../src/config.ts) so `twitter.headless` defaults to `false`. This is a behavior change — the operator's machine pops up a Chrome window during ingestion — but it's the single biggest detection mitigation available, and the operator already runs the daemon interactively on macOS.

Tests are unaffected: the existing test suite uses `setPageForTesting` and never launches a real browser, so the headless flag is irrelevant in tests.

### Drop the hard-coded UA

Removing the `userAgent` option from `launchPersistentContext` is the entire fix. Playwright's bundled Chromium sends its real UA, which matches `navigator.userAgentData`, the JS engine version, and the feature set. No UA-vs-Client-Hints mismatch remains.

We accept the small downside that the UA changes when Playwright is upgraded — that is the desired behavior. A "real" user's UA also changes when their browser updates.

## Implementation Plan

1. Add `src/connectors/twitter/browser.ts` exporting `buildLaunchOptions`.
2. Update `TwitterConnector.start` in `src/connectors/twitter/index.ts` to call it. Remove the inline option literal and the `userAgent` line.
3. Update `src/scripts/twitterLogin.ts` to call the helper with `headless: false`. Remove the duplicate inline options.
4. Flip the `twitter.headless` default to `false` in `src/config.ts`.
5. Update `config.yaml` to set `twitter.headless: false` explicitly.
6. Update `TECH_DEBTS.md`: add the deferred items (#4–#10) under the "Twitter/X Connector" section.

Estimated effort: 30 minutes including TECH_DEBTS update. No new tests — this is a launch-options consolidation; existing tests continue to use `setPageForTesting` and don't exercise the launch path.

## Open Questions

1. **Should `headless` stop being a config option entirely?** Once we recommend `false`, leaving it in config invites the operator to flip it back "for performance" and re-introduce the detection risk. Counter-argument: CI / future remote daemon may need headless. Verdict: keep the option, but document that flipping to `true` increases lock risk.
2. **Should the scraper share the *exact same* `BrowserContext` as the login script?** I.e., not just same options, same cookies, but a single long-lived context process. That's a bigger architectural change and is already noted in `TECH_DEBTS.md` ("Browser context is recreated every ingestion cycle"). Defer.

## Cross-References

- `src/connectors/twitter/index.ts` — connector launch site.
- `src/scripts/twitterLogin.ts` — login launch site.
- `src/connectors/twitter/browser.ts` — new shared launch-options module.
- `config.yaml`, `src/config.ts` — `twitter.headless` default flip.
- `TECH_DEBTS.md` — deferred items (#4–#10) recorded here after landing.
- `design_docs/2026-04-26-login-wall-detection/login-wall-detection.md` — the previous connector hardening pass; this is its successor for fingerprint risk specifically.
