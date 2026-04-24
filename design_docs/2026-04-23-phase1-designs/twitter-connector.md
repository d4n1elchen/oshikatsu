# Twitter/X Source Connector Design

## Overview

The Twitter/X source connector fetches new tweets from configured sources using a headful browser (Playwright via CDP). The connector returns raw tweet data for the ingestion pipeline to store via the [raw storage](./raw-storage.md).

**Fetching approach:** Headful CDP via Playwright (primary), with RSSHub / Nitter as fallback.

## Configuration

Sources to monitor are managed by the [watch list](./watchlist.md), not configured here. This config only covers browser and fetch behavior.

```yaml
twitter:
  # Browser settings
  browser:
    user_data_dir: "./browser_data"  # Persist login session
    headless: false                   # Headful for anti-detection

  # Account (dedicated burner account — NOT your main)
  account:
    username: "burner_handle"

  # Fetch behavior
  fetch:
    max_tweets_per_source: 50        # Max tweets to scrape per source per cycle
    scroll_delay_ms: 1500            # Delay between scrolls (human-like timing)
    page_load_timeout_ms: 15000      # Timeout for page load
```

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
    user_data_dir: string;
    headless: boolean;
  };
  account: {
    username: string;
  };
  fetch: {
    max_tweets_per_source: number;
    scroll_delay_ms: number;
    page_load_timeout_ms: number;
  };
}

export class TwitterConnector {
  constructor(private config: TwitterConnectorConfig) {}

  /** Launch the browser and restore login session. */
  async start(): Promise<void> {
    // implementation
  }

  /**
   * Fetch new tweets from a single source entry.
   * Called by the scheduler for each active Twitter source.
   *
   * @param source A SourceEntry from the watch list.
   * @returns List of raw tweet payloads (Record<string, any>) with source_name and source_id.
   */
  async fetchUpdates(source: SourceEntry): Promise<Record<string, any>[]> {
    // implementation
    return [];
  }

  /** Close the browser gracefully. */
  async stop(): Promise<void> {
    // implementation
  }
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

> **Note:** The `raw_data` shape is not guaranteed to be stable. The storage layer persists it as-is. Normalization (Phase 2) will handle extracting structured fields.

## Anti-Detection Measures

- **Headful browser** with real browser fingerprint (not headless).
- **Dedicated burner account** — never use your main account.
- **Human-like behavior**: randomized scroll delays, natural page navigation patterns.
- **Persistent session**: reuse login cookies from `user_data_dir` to avoid repeated logins.
- **Single browser instance with tabs** via CDP — more efficient and less suspicious than multiple browser instances.

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
