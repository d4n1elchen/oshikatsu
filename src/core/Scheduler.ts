import { WatchListManager } from "./WatchListManager";
import { RawStorage } from "./RawStorage";
import { TwitterConnector } from "../connectors/twitter";
import * as path from "path";

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

    console.log(`Scheduler started. Interval: ${this.config.intervalMinutes} minutes.`);
    
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
    console.log("Scheduler stopped.");
  }

  /** Execute one full ingestion cycle across all active targets. */
  async runOnce(): Promise<void> {
    console.log(`\n--- Starting ingestion cycle: ${new Date().toISOString()} ---`);
    
    // 1. Fetch active Twitter targets
    const activeTwitterTargets = await this.wlm.getActiveTargets("twitter");
    console.log(`Found ${activeTwitterTargets.length} active Twitter watch targets.`);

    if (activeTwitterTargets.length > 0) {
      // Initialize Twitter Connector
      const twitterConnector = new TwitterConnector({
        browser: {
          userDataDir: path.resolve(process.cwd(), "browser_data"),
          headless: true, // Run headless in production/scheduling
        },
        fetch: {
          maxTweetsPerSource: 50,
          scrollDelayMs: 1500,
          pageLoadTimeoutMs: 15000,
        },
      });

      try {
        await twitterConnector.start();

        // Process each target sequentially for safety (anti-bot)
        for (const target of activeTwitterTargets) {
          console.log(`Fetching updates for ${target.sourceConfig.username}...`);
          try {
            const items = await twitterConnector.fetchUpdates(target);
            console.log(`Fetched ${items.length} total items from ${target.sourceConfig.username}`);
            
            if (items.length > 0) {
              const newItemsCount = await this.storage.saveItems(
                target.id,
                "twitter",
                items.map(i => ({ sourceId: i.sourceId, rawData: i.rawData }))
              );
              console.log(`Saved ${newItemsCount} NEW items to Raw Storage.`);
            }
          } catch (e) {
            console.error(`Failed to fetch/save for watch target ${target.id}:`, e);
          }
        }
      } catch (e) {
        console.error("Failed to start Twitter Connector:", e);
      } finally {
        await twitterConnector.stop();
      }
    }

    console.log("--- Ingestion cycle complete ---\n");
  }
}
