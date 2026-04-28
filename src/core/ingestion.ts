import { WatchListManager } from "./WatchListManager";
import { RawStorage } from "./RawStorage";
import { TwitterConnector } from "../connectors/twitter";
import { getConfig } from "../config";
import { tagged } from "./logger";
import type { RunDetails } from "./types";

const log = tagged("Ingestion");

export interface IngestionRunDetails extends RunDetails {
  totalTargets: number;
  totalNewItems: number;
  failedTargets: number;
  perTarget: Record<string, {
    items: number;
    saved?: number;
    status: "ok" | "failed" | "skipped";
    errorClass?: string;
  }>;
}

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
): Promise<IngestionRunDetails> {
  const activeTwitterTargets = await wlm.getActiveTargets("twitter");

  const details: IngestionRunDetails = {
    totalTargets: activeTwitterTargets.length,
    totalNewItems: 0,
    failedTargets: 0,
    perTarget: {},
  };

  if (activeTwitterTargets.length === 0) {
    return details;
  }

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
    const baseDelayMs = globalConfig.twitter.interTargetDelayMs;
    for (let i = 0; i < activeTwitterTargets.length; i++) {
      if (signal?.aborted) {
        // Mark the remaining targets as skipped so the Monitor view can
        // distinguish "we never tried this one" from "we tried and failed".
        for (let j = i; j < activeTwitterTargets.length; j++) {
          const t = activeTwitterTargets[j]!;
          details.perTarget[t.sourceConfig.username] = { items: 0, status: "skipped" };
        }
        break;
      }
      // Pace requests to reduce anti-bot risk. Skip before the first
      // target. ±25% jitter so the cadence isn't perfectly periodic.
      if (i > 0 && baseDelayMs > 0) {
        const jitter = (Math.random() - 0.5) * 0.5 * baseDelayMs;
        const delay = Math.max(0, Math.floor(baseDelayMs + jitter));
        await sleep(delay, signal);
        if (signal?.aborted) {
          for (let j = i; j < activeTwitterTargets.length; j++) {
            const t = activeTwitterTargets[j]!;
            details.perTarget[t.sourceConfig.username] = { items: 0, status: "skipped" };
          }
          break;
        }
      }
      const target = activeTwitterTargets[i]!;
      const username = target.sourceConfig.username as string;
      try {
        const items = await twitterConnector.fetchUpdates(target, signal);

        let saved = 0;
        if (items.length > 0) {
          saved = await storage.saveItems(
            target.id,
            "twitter",
            items.map((i) => ({ sourceId: i.sourceId, rawData: i.rawData }))
          );
        }
        details.perTarget[username] = { items: items.length, saved, status: "ok" };
        details.totalNewItems += saved;
      } catch (e) {
        const errClass = e instanceof Error ? e.name : "Error";
        log.error(`Failed to fetch/save watch target ${target.id}:`, e);
        details.perTarget[username] = { items: 0, status: "failed", errorClass: errClass };
        details.failedTargets++;
      }
    }
  } catch (e) {
    log.error("Failed to start Twitter connector:", e);
    // Counts every active target as failed since we never got a chance.
    for (const t of activeTwitterTargets) {
      const u = t.sourceConfig.username as string;
      if (!details.perTarget[u]) {
        details.perTarget[u] = { items: 0, status: "failed", errorClass: e instanceof Error ? e.name : "Error" };
      }
    }
    details.failedTargets = Object.values(details.perTarget).filter((p) => p.status === "failed").length;
  } finally {
    await twitterConnector.stop();
  }

  return details;
}

/**
 * setTimeout-based sleep that resolves early if the abort signal fires.
 * Used between ingestion targets so a graceful shutdown doesn't have to
 * wait the full inter-target delay.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
