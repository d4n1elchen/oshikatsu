import type { chromium } from "playwright";

type LaunchPersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export interface LaunchOptionsInput {
  userDataDir: string;
  headless: boolean;
}

/**
 * Shared Playwright launch options for both the login script and the
 * scraping connector. Keeping them aligned is what makes the auth cookie
 * stay inside a single fingerprint family across login and scraping —
 * X's session-binding heuristics flag a cookie that is suddenly presented
 * from a visibly different browser as suspect.
 *
 * Intentionally NO `userAgent` override. Letting bundled Chromium send its
 * real UA keeps navigator.userAgent, navigator.userAgentData, and the
 * actual feature set consistent — UA-vs-Client-Hints mismatch is a strong
 * automation tell.
 *
 * The `userDataDir` is consumed by the caller (passed to
 * `launchPersistentContext`), not embedded in the returned options.
 */
export function buildLaunchOptions(opts: LaunchOptionsInput): LaunchPersistentContextOptions {
  return {
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
}
