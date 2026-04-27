import { WatchListManager } from "./WatchListManager";
import { RawStorage } from "./RawStorage";
import { TwitterConnector } from "../connectors/twitter";
import { getConfig } from "../config";
import { tagged } from "./logger";

const log = tagged("Ingestion");

/**
 * Execute one full ingestion cycle: fetch active watch targets across each
 * supported platform, pull raw items, and persist to raw storage.
 *
 * Idempotent at the row level — `RawStorage.saveItems` dedupes by
 * `(source_name, source_id)`, so re-running a cycle is safe.
 *
 * If `signal` is provided and aborted, the cycle bails out at the next
 * target boundary. The currently-in-progress fetch is allowed to complete
 * (or fail on its own) so we don't leave the browser context in a bad state.
 */
export async function runIngestionCycle(
  wlm: WatchListManager = new WatchListManager(),
  storage: RawStorage = new RawStorage(),
  signal?: AbortSignal
): Promise<void> {
  log.info(`Cycle starting at ${new Date().toISOString()}`);

  const activeTwitterTargets = await wlm.getActiveTargets("twitter");
  log.info(`Found ${activeTwitterTargets.length} active Twitter watch target(s)`);

  if (activeTwitterTargets.length > 0) {
    const globalConfig = getConfig();

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

      // Process each target sequentially for safety (anti-bot).
      for (const target of activeTwitterTargets) {
        if (signal?.aborted) {
          log.info("Ingestion aborted; skipping remaining targets");
          break;
        }
        log.info(`Fetching updates for @${target.sourceConfig.username}`);
        try {
          const items = await twitterConnector.fetchUpdates(target, signal);
          log.info(`Fetched ${items.length} item(s) from @${target.sourceConfig.username}`);

          if (items.length > 0) {
            const newItemsCount = await storage.saveItems(
              target.id,
              "twitter",
              items.map((i) => ({ sourceId: i.sourceId, rawData: i.rawData }))
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

  log.info("Cycle complete");
}
