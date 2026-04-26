import { IngestionScheduler } from "./core/Scheduler";
import { ExtractionEngine } from "./core/ExtractionEngine";
import { EventResolver } from "./core/EventResolver";
import { OllamaProvider } from "./core/LLMProvider";
import { tagged } from "./core/logger";
import { getConfig } from "./config";

const log = tagged("daemon");

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

  // Start the ingestion scheduler (it handles its own interval loop)
  await scheduler.start();

  // We'll run the extractor and resolver on the configured loop
  const extractionIntervalMs = config.scheduler.extractionIntervalMinutes * 60 * 1000;

  async function runExtraction() {
    try {
      await extractor.processBatch(20);
      await resolver.processBatch(50);
    } catch (e) {
      log.error("Extraction loop error:", e);
    }
  }

  // Run extractor immediately
  await runExtraction();

  // Schedule extractor
  const extractTimer = setInterval(runExtraction, extractionIntervalMs);
  
  // Keep the process alive
  process.on('SIGINT', async () => {
    log.info("Shutting down gracefully");
    clearInterval(extractTimer);
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch((e) => log.error("Fatal:", e));
