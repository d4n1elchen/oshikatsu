import { IngestionScheduler } from "./core/Scheduler";
import { ExtractionEngine } from "./core/ExtractionEngine";
import { EventResolver } from "./core/EventResolver";
import { OllamaProvider } from "./core/LLMProvider";
import { tagged } from "./core/logger";
import { getConfig } from "./config";

const log = tagged("daemon");

/**
 * Runs `task` on a loop, chaining the next setTimeout *after* each run
 * completes. This avoids the overlap that setInterval would cause when a
 * single run takes longer than the configured interval. Each tick is
 * independent of the others, so all three pipeline stages (ingest,
 * extract, resolve) run as their own self-paced loop. Each stage is
 * idempotent — they can safely overlap each other.
 */
function startLoop(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
  state: { running: boolean; timer: NodeJS.Timeout | null; inFlight: Promise<void> | null }
): void {
  const tick = async () => {
    if (!state.running) return;
    state.inFlight = task().catch((e) => {
      log.error(`${name} loop error:`, e);
    });
    await state.inFlight;
    state.inFlight = null;
    if (!state.running) return;
    state.timer = setTimeout(tick, intervalMs);
  };
  void tick();
}

async function main() {
  const config = getConfig();

  const scheduler = new IngestionScheduler({
    intervalMinutes: config.scheduler.ingestionIntervalMinutes,
    maxConcurrentJobs: 1,
    retryOnFailure: false,
    retryDelayMinutes: 5,
  });

  const llm = new OllamaProvider();
  const extractor = new ExtractionEngine(llm);
  const resolver = new EventResolver();

  log.info("Starting backend daemon");

  // Start the ingestion scheduler (it manages its own drift-safe loop).
  await scheduler.start();

  // Extraction and resolution each run on their own independent self-paced
  // loop. They are decoupled because each stage is idempotent at the row
  // level: extractor skips raw_items already extracted, resolver skips
  // extracted_events that already have a decision. Letting them run in
  // parallel means a slow extraction batch doesn't block resolution from
  // catching up on already-extracted events, and the resolver can be
  // cheaper/more frequent than the LLM-bound extractor.
  const extractionState = { running: true, timer: null as NodeJS.Timeout | null, inFlight: null as Promise<void> | null };
  const resolutionState = { running: true, timer: null as NodeJS.Timeout | null, inFlight: null as Promise<void> | null };

  startLoop(
    "Extraction",
    config.scheduler.extractionIntervalMinutes * 60 * 1000,
    async () => {
      await extractor.processBatch(20);
    },
    extractionState
  );

  startLoop(
    "Resolution",
    config.scheduler.resolutionIntervalMinutes * 60 * 1000,
    async () => {
      await resolver.processBatch(50);
    },
    resolutionState
  );

  // Graceful shutdown: stop new ticks, wait for in-flight work to drain.
  process.on("SIGINT", async () => {
    log.info("Shutting down gracefully");
    extractionState.running = false;
    resolutionState.running = false;
    if (extractionState.timer) clearTimeout(extractionState.timer);
    if (resolutionState.timer) clearTimeout(resolutionState.timer);
    await Promise.all([
      extractionState.inFlight,
      resolutionState.inFlight,
      scheduler.stop(),
    ]);
    process.exit(0);
  });
}

main().catch((e) => log.error("Fatal:", e));
