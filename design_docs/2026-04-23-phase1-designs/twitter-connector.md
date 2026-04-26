# Twitter/X Source Connector Design

## Overview

The Twitter/X source connector fetches new tweets from configured sources using a headful browser (Playwright via CDP). The connector returns raw tweet data for the ingestion pipeline to store via the [raw storage](./raw-storage.md).

**Fetching approach:** Headful CDP via Playwright (primary), with RSSHub / Nitter as fallback.

## Configuration

Watch targets to monitor are managed by the [watch list](./watchlist.md), not configured here. The connector config covers only browser and fetch behavior.

The shipped global `config.yaml` exposes a flattened subset:

```yaml
twitter:
  maxTweetsPerSource: 50
  headless: true     # Daemon default. Use `headless: false` for development/debugging.

paths:
  browserData: "./browser_data"   # Shared with login:twitter; persists the X session.
```

The connector itself receives a structured config when constructed by the Scheduler:

```yaml
twitter:
  browser:
    userDataDir: "./browser_data"   # Persist login session across runs
    headless: true                  # See note below
  fetch:
    maxTweetsPerSource: 50          # Max tweets per watch target per cycle
    scrollDelayMs: 1500             # Delay between scrolls (human-like timing)
    pageLoadTimeoutMs: 15000        # Timeout for page load
```

### What changed from earlier drafts

- **No `account` block.** Authentication is held entirely by the persistent browser profile in `userDataDir`. A one-time login is performed via `npm run login:twitter` (`src/scripts/twitter_login.ts`), which launches a headful Chromium against `https://x.com/login`, waits up to 3 minutes for manual login + 2FA, and persists cookies into `browserData`. The runtime connector reuses that profile and never re-enters credentials, so a separate `account.username` config field is unnecessary.
- **`headless` defaults to `true`.** The original anti-detection rationale recommended headful, but a logged-in persistent context is the dominant signal — modern Playwright headless plus `--disable-blink-features=AutomationControlled` has been good enough in practice. Keep `headless: false` during development if you need to watch the page, or if anti-bot pressure increases.
- **Burner account discipline still applies.** Use a dedicated X account in `browserData`, not your main account. This is a runbook concern rather than a config field.

## Architecture

### Fetching Strategy

The connector uses Playwright with CDP to control a real browser instance:

1. **Launch** a persistent browser context (reuses login session from `user_data_dir`).
2. **Navigate** to the target page (user timeline URL or search URL).
3. **Intercept GraphQL responses** via CDP network events — this is more resilient than DOM scraping, as the tweet data comes directly from X's internal API responses.
4. **Scroll** the page to trigger additional tweet loads, with human-like delays.
5. **Collect** intercepted tweet JSON payloads as raw data.
6. **Dedup** against already-fetched items (via `RawStorage.exists()`).
7. **Return** new items to the pipeline.

### Why GraphQL Interception Over DOM Parsing

- X frequently changes class names and DOM structure — DOM selectors break often.
- The GraphQL responses from X's internal API contain structured JSON with all tweet data.
- Intercepting network responses via CDP is more stable than scraping rendered HTML.
- We still get the anti-detection benefits of a real headful browser.

## Interface

```typescript
export interface TwitterConnectorConfig {
  browser: {
    userDataDir: string;
    headless: boolean;
  };
  fetch: {
    maxTweetsPerSource: number;
    scrollDelayMs: number;
    pageLoadTimeoutMs: number;
  };
}

export class TwitterConnector implements BaseConnector {
  constructor(private config: TwitterConnectorConfig) {}

  /** Launch the persistent browser context and reopen the X session. */
  async start(): Promise<void> {}

  /**
   * Fetch new tweets from a single watch target.
   * Called by the scheduler for each active Twitter watch target.
   *
   * @param target A WatchTarget from the watch list. Expects sourceConfig.username.
   * @returns List of raw tweet payloads, each shaped as
   *          { sourceName: "twitter", sourceId: <tweet id>, rawData: <tweet result> }.
   */
  async fetchUpdates(target: WatchTarget): Promise<Record<string, any>[]> {
    return [];
  }

  /** Close the browser gracefully. */
  async stop(): Promise<void> {}
}
```

## Raw Output Format

Each raw item returned by the connector is the unmodified GraphQL response payload from X. The shape may vary as X updates its internal API, but typically includes:

```json
{
  "source_name": "twitter",
  "source_id": "tweet_id_string",
  "raw_data": {
    "__typename": "Tweet",
    "rest_id": "tweet_id_string",
    "core": {
      "user_results": { "..." : "author info" }
    },
    "legacy": {
      "full_text": "tweet text content",
      "created_at": "Thu Apr 23 10:00:00 +0000 2026",
      "favorite_count": 500,
      "retweet_count": 100,
      "reply_count": 50,
      "entities": { "..." : "hashtags, urls, media" }
    }
  }
}
```

> **Note:** The `raw_data` shape is not guaranteed to be stable. The storage layer persists it as-is. Event extraction (Phase 2) will handle extracting structured fields.

## Anti-Detection Measures

- **Persistent logged-in session** as the dominant signal: reuse cookies from `userDataDir` to avoid repeated logins. This is what makes the connector look like a real returning user.
- **Real-browser fingerprint** even in headless mode: a desktop user-agent, a 1280×800 viewport, `--disable-blink-features=AutomationControlled`, and `ignoreDefaultArgs: ["--enable-automation"]`. `headless` is configurable; flip to `false` if anti-bot pressure increases.
- **Dedicated burner account** — never use your main account. Enforced operationally via `login:twitter`, not by config.
- **Human-like behavior**: scroll-and-wait with `scrollDelayMs` between steps, capped by `maxTweetsPerSource`.
- **Single persistent browser context with one tab** — efficient and less suspicious than spawning instances per fetch.

## Error Handling

- **Anti-bot detection** (CAPTCHA, login wall): log a warning alert, pause fetching, notify via monitoring.
- **Page load timeout**: retry up to 3 times with increasing delays.
- **GraphQL interception failure**: fall back to a longer scroll wait, then fail gracefully.
- **Browser crash**: restart the browser context and resume from the last successful source.

## Fallback: RSSHub / Nitter

If CDP proves unreliable or too resource-heavy:

- Use RSSHub or self-hosted Nitter to fetch RSS feeds for user timelines.
- Simpler implementation (HTTP fetch + XML parse), no browser needed.
- Limitations: no search support, no engagement metrics, limited tweet history.
- Can run in parallel with CDP as a secondary data source.
