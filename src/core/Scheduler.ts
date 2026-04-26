import { WatchListManager } from "./WatchListManager";
import { RawStorage } from "./RawStorage";
import { TwitterConnector } from "../connectors/twitter";
import { getConfig } from "../config";
import { tagged } from "./logger";

const log = tagged("Scheduler");

export interface SchedulerConfig {
  intervalMinutes: number;
  maxConcurrentJobs: number;
  retryOnFailure: boolean;
  retryDelayMinutes: number;
}

export class IngestionScheduler {
  private wlm: WatchListManager;
  private storage: RawStorage;
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private config: SchedulerConfig) {
    this.wlm = new WatchListManager();
    this.storage = new RawStorage();
  }

  /** Start the scheduler loop. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    log.info(`Started; interval ${this.config.intervalMinutes}m`);

    // Run immediately, then chain subsequent runs via setTimeout *after* each
    // run completes. setInterval would fire on a fixed cadence regardless of
    // run duration, causing overlap when a cycle takes longer than the
    // interval. Chaining absorbs drift and serializes runs naturally.
    const loop = async () => {
      if (!this.isRunning) return;
      this.inFlight = this.runOnce().catch((e) => {
        log.error("Cycle error:", e);
      });
      await this.inFlight;
      this.inFlight = null;
      if (!this.isRunning) return;
      const intervalMs = this.config.intervalMinutes * 60 * 1000;
      this.timer = setTimeout(loop, intervalMs);
    };

    void loop();
  }

  /** Stop the scheduler gracefully. Waits for any in-flight cycle. */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    log.info("Stopped");
  }

  /** Execute one full ingestion cycle across all active targets. */
  async runOnce(): Promise<void> {
    log.info(`Ingestion cycle starting at ${new Date().toISOString()}`);

    // 1. Fetch active Twitter targets
    const activeTwitterTargets = await this.wlm.getActiveTargets("twitter");
    log.info(`Found ${activeTwitterTargets.length} active Twitter watch target(s)`);

    if (activeTwitterTargets.length > 0) {
      const globalConfig = getConfig();
      
      // Initialize Twitter Connector
      const twitterConnector = new TwitterConnector({
        browser: {
          userDataDir: globalConfig.paths.browserData,
          headless: globalConfig.twitter.headless,
        },
        fetch: {
          maxTweetsPerSource: globalConfig.twitter.maxTweetsPerSource,
          scrollDelayMs: 1500,
          pageLoadTimeoutMs: 15000,
        },
      });

      try {
        await twitterConnector.start();

        // Process each target sequentially for safety (anti-bot)
        for (const target of activeTwitterTargets) {
          log.info(`Fetching updates for @${target.sourceConfig.username}`);
          try {
            const items = await twitterConnector.fetchUpdates(target);
            log.info(`Fetched ${items.length} item(s) from @${target.sourceConfig.username}`);

            if (items.length > 0) {
              const newItemsCount = await this.storage.saveItems(
                target.id,
                "twitter",
                items.map(i => ({ sourceId: i.sourceId, rawData: i.rawData }))
              );
              log.info(`Saved ${newItemsCount} new item(s) to raw storage`);
            }
          } catch (e) {
            log.error(`Failed to fetch/save watch target ${target.id}:`, e);
          }
        }
      } catch (e) {
        log.error("Failed to start Twitter connector:", e);
      } finally {
        await twitterConnector.stop();
      }
    }

    log.info("Ingestion cycle complete");
  }
}
