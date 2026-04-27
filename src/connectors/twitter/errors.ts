/**
 * Typed errors for the Twitter connector.
 *
 * The base class lets the scheduler's per-target catch recognize the
 * connector's failure family with `instanceof TwitterFetchError`. Subclasses
 * carry the specific category so a future Monitoring component can route
 * alerts (e.g., LoginWallError → operator action; TimelineShapeError → code
 * change required).
 */

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

/**
 * Substrings indicating a login flow page. Checked against `page.url()`
 * after navigation completes.
 */
export const LOGIN_WALL_URL_PATTERNS = [
  "/i/flow/login",
  "/account/access",
];

/**
 * Markers indicating an anti-bot interstitial. Each entry is a (location,
 * substring) pair: location is one of "title" or "body". Matching is
 * case-insensitive.
 *
 * This list will drift as platforms update their pages — keep it small,
 * narrowly-scoped (page-level only, not arbitrary tweet content), and
 * easy to extend.
 */
export const ANTI_BOT_MARKERS: ReadonlyArray<{ location: "title" | "body"; substring: string }> = [
  { location: "title", substring: "just a moment" }, // Cloudflare
  { location: "body", substring: "verifying you are human" },
  { location: "body", substring: "sorry, you have been blocked" },
];
