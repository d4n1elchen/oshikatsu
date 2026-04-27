import { chromium, type BrowserContext, type Page } from "playwright";
import type { BaseConnector } from "../types";
import type { WatchTarget } from "../../core/types";
import { tagged } from "../../core/logger";
import {
  ANTI_BOT_MARKERS,
  AntiBotError,
  LOGIN_WALL_URL_PATTERNS,
  LoginWallError,
  TimelineShapeError,
  TwitterFetchError,
} from "./errors";

const log = tagged("TwitterConnector");

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

/**
 * Minimal Page surface used by fetchUpdates. Defined so tests can inject a
 * fake without depending on Playwright's full type.
 */
export interface PageLike {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
  on(event: "response", handler: (response: any) => void | Promise<void>): void;
  removeListener(event: "response", handler: (response: any) => void | Promise<void>): void;
}

export class TwitterConnector implements BaseConnector {
  private context: BrowserContext | null = null;
  private page: PageLike | null = null;

  constructor(private config: TwitterConnectorConfig) {}

  /** Test seam: inject a pre-made page (skips browser launch). */
  setPageForTesting(page: PageLike): void {
    this.page = page;
  }

  async start(): Promise<void> {
    log.info(`Launching persistent browser context at ${this.config.browser.userDataDir}`);
    this.context = await chromium.launchPersistentContext(this.config.browser.userDataDir, {
      headless: this.config.browser.headless,
      // Useful for reducing anti-bot detections
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    this.page = (await this.context.newPage()) as unknown as PageLike;
  }

  async fetchUpdates(source: WatchTarget): Promise<Record<string, any>[]> {
    if (!this.page) throw new TwitterFetchError("Browser not started");

    const username = source.sourceConfig.username as string;
    if (!username) throw new TwitterFetchError("Invalid source config: missing username");

    const targetUrl = `https://x.com/${username}`;
    log.info(`Navigating to ${targetUrl}`);

    const rawItems: Record<string, any>[] = [];
    let userTweetsResponseCount = 0;

    // Intercept all GraphQL responses
    const responseHandler = async (response: any) => {
      try {
        const url = response.url();
        // X uses GraphQL endpoints like 'UserTweets' or 'UserMedia'
        if (url.includes("graphql") && url.includes("UserTweets")) {
          userTweetsResponseCount++;
          const json = await response.json();
          // Extract the core entries from the complex timeline JSON
          const userResult = json?.data?.user?.result;
          const timelineObj = userResult?.timeline_v2?.timeline || userResult?.timeline?.timeline || userResult?.timeline;
          const instructions = timelineObj?.instructions || [];
          for (const instruction of instructions) {
            if (instruction.type === "TimelineAddEntries") {
              for (const entry of instruction.entries || []) {
                if (entry.entryId.startsWith("tweet-")) {
                  // We found a tweet! Map it to our generic RawItem format
                  const rawTweetData = entry.content?.itemContent?.tweet_results?.result;
                  if (rawTweetData && rawTweetData.rest_id) {
                    rawItems.push({
                      sourceName: "twitter",
                      sourceId: rawTweetData.rest_id,
                      rawData: rawTweetData,
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore JSON parsing errors for unrelated requests
      }
    };

    this.page.on("response", responseHandler);

    try {
      await this.page.goto(targetUrl, {
        timeout: this.config.fetch.pageLoadTimeoutMs,
        waitUntil: "domcontentloaded",
      });

      // Login-wall probe: if we got redirected to a login flow, the profile
      // page is not viewable for this session. The persistent browser profile
      // needs to be re-authenticated via `npm run login:twitter`.
      const resolvedUrl = this.page.url();
      if (LOGIN_WALL_URL_PATTERNS.some((pattern) => resolvedUrl.includes(pattern))) {
        throw new LoginWallError(resolvedUrl);
      }

      // Wait a moment for initial network requests to settle
      await this.page.waitForTimeout(3000);

      // Anti-bot probe: check the page for known interstitial markers. Done
      // after the initial settle so dynamically-rendered text is in place.
      const marker = await detectAntiBotMarker(this.page);
      if (marker) {
        throw new AntiBotError(marker);
      }

      // Perform scrolling to trigger pagination if we need more items
      let scrolls = 0;
      const maxScrolls = Math.ceil(this.config.fetch.maxTweetsPerSource / 10);

      while (scrolls < maxScrolls && rawItems.length < this.config.fetch.maxTweetsPerSource) {
        log.info(`Scrolling (collected ${rawItems.length} so far)`);
        await this.page.evaluate(() => window.scrollBy(0, 1000));
        await this.page.waitForTimeout(this.config.fetch.scrollDelayMs);
        scrolls++;
      }
    } catch (e) {
      log.error(`Failed to fetch updates for @${username}:`, e);
      // Wrap untyped errors so callers can use `instanceof TwitterFetchError`.
      // Already-typed errors pass through unchanged.
      if (e instanceof TwitterFetchError) throw e;
      throw new TwitterFetchError(
        e instanceof Error ? e.message : String(e),
        e
      );
    } finally {
      this.page.removeListener("response", responseHandler);
    }

    // Shape-change probe: if the page loaded cleanly but the UserTweets
    // GraphQL endpoint never fired, the page is not behaving like a normal
    // profile page — most likely X changed the response shape, but could also
    // be a suspended/protected account. Either way, distinguishable from a
    // genuinely empty timeline (where the endpoint fires with no entries).
    if (rawItems.length === 0 && userTweetsResponseCount === 0) {
      throw new TimelineShapeError();
    }

    return rawItems.slice(0, this.config.fetch.maxTweetsPerSource);
  }

  async stop(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}

async function detectAntiBotMarker(page: PageLike): Promise<string | null> {
  for (const marker of ANTI_BOT_MARKERS) {
    if (marker.location === "title") {
      const title = (await page.title()).toLowerCase();
      if (title.includes(marker.substring)) return marker.substring;
    } else {
      const body = (await page.content()).toLowerCase();
      if (body.includes(marker.substring)) return marker.substring;
    }
  }
  return null;
}
