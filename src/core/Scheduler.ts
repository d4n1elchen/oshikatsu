import { WatchListManager } from "./WatchListManager";
import { RawStorage } from "./RawStorage";
import { TwitterConnector } from "../connectors/twitter";
import { getConfig } from "../config";
import { log } from "./logger";

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

  constructor(private config: SchedulerConfig) {
    this.wlm = new WatchListManager();
    this.storage = new RawStorage();
  }

  /** Start the scheduler loop. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    log.info(`Scheduler started. Interval: ${this.config.intervalMinutes} minutes.`);
    
    // Run immediately on start
    await this.runOnce();

    // Schedule subsequent runs
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    this.timer = setInterval(async () => {
      if (!this.isRunning) return;
      await this.runOnce();
    }, intervalMs);
  }

  /** Stop the scheduler gracefully. */
  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Scheduler stopped.");
  }

  /** Execute one full ingestion cycle across all active targets. */
  async runOnce(): Promise<void> {
    log.info(`\n--- Starting ingestion cycle: ${new Date().toISOString()} ---`);
    
    // 1. Fetch active Twitter targets
    const activeTwitterTargets = await this.wlm.getActiveTargets("twitter");
    log.info(`Found ${activeTwitterTargets.length} active Twitter watch targets.`);

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
          log.info(`Fetching updates for ${target.sourceConfig.username}...`);
          try {
            const items = await twitterConnector.fetchUpdates(target);
            log.info(`Fetched ${items.length} total items from ${target.sourceConfig.username}`);
            
            if (items.length > 0) {
              const newItemsCount = await this.storage.saveItems(
                target.id,
                "twitter",
                items.map(i => ({ sourceId: i.sourceId, rawData: i.rawData }))
              );
              log.info(`Saved ${newItemsCount} NEW items to Raw Storage.`);
            }
          } catch (e) {
            log.error(`Failed to fetch/save for watch target ${target.id}:`, e);
          }
        }
      } catch (e) {
        log.error("Failed to start Twitter Connector:", e);
      } finally {
        await twitterConnector.stop();
      }
    }

    log.info("--- Ingestion cycle complete ---\n");
  }
}
