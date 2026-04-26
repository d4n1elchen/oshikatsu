import { chromium, type BrowserContext, type Page } from "playwright";
import type { BaseConnector } from "../types";
import type { WatchTarget } from "../../core/types";
import { tagged } from "../../core/logger";

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

export class TwitterConnector implements BaseConnector {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private config: TwitterConnectorConfig) {}

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

    this.page = await this.context.newPage();
  }

  async fetchUpdates(source: WatchTarget): Promise<Record<string, any>[]> {
    if (!this.page) throw new Error("Browser not started");

    const username = source.sourceConfig.username as string;
    if (!username) throw new Error("Invalid source config: missing username");

    const targetUrl = `https://x.com/${username}`;
    log.info(`Navigating to ${targetUrl}`);

    const rawItems: Record<string, any>[] = [];

    // Intercept all GraphQL responses
    const responseHandler = async (response: any) => {
      try {
        const url = response.url();
        // X uses GraphQL endpoints like 'UserTweets' or 'UserMedia'
        if (url.includes("graphql") && url.includes("UserTweets")) {
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

    // Attach listener
    this.page.on("response", responseHandler);

    try {
      await this.page.goto(targetUrl, { 
        timeout: this.config.fetch.pageLoadTimeoutMs,
        waitUntil: "domcontentloaded" 
      });

      // Wait a moment for initial network requests to settle
      await this.page.waitForTimeout(3000);

      // Perform scrolling to trigger pagination if we need more items
      let scrolls = 0;
      const maxScrolls = Math.ceil(this.config.fetch.maxTweetsPerSource / 10); // Rough estimate

      while (scrolls < maxScrolls && rawItems.length < this.config.fetch.maxTweetsPerSource) {
        log.info(`Scrolling (collected ${rawItems.length} so far)`);
        await this.page.evaluate(() => window.scrollBy(0, 1000));
        await this.page.waitForTimeout(this.config.fetch.scrollDelayMs);
        scrolls++;
      }
    } catch (e) {
      // Re-throw so the scheduler treats this as a failed fetch rather than
      // an empty-but-successful one. Without this, navigation timeouts, login
      // walls, and broken page loads are indistinguishable from "the user
      // posted nothing today" — silent data loss.
      log.error(`Failed to fetch updates for @${username}:`, e);
      throw e;
    } finally {
      // Clean up the listener so it doesn't duplicate on the next fetch
      this.page.removeListener("response", responseHandler);
    }

    // Return truncated list if we over-collected
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
