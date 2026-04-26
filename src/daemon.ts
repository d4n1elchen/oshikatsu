import { IngestionScheduler } from "./core/Scheduler";
import { ExtractionEngine } from "./core/ExtractionEngine";
import { OllamaProvider } from "./core/LLMProvider";
import { getConfig } from "./config";

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

  console.log("Starting backend daemon...");
  
  // Start the ingestion scheduler (it handles its own interval loop)
  await scheduler.start();
  
  // We'll run the extractor on the configured loop
  const extractionIntervalMs = config.scheduler.extractionIntervalMinutes * 60 * 1000;
  
  async function runExtraction() {
    try {
      await extractor.processBatch(20);
    } catch (e) {
      console.error("Extraction loop error:", e);
    }
  }

  // Run extractor immediately
  await runExtraction();
  
  // Schedule extractor
  const extractTimer = setInterval(runExtraction, extractionIntervalMs);
  
  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log("\nShutting down gracefully...");
    clearInterval(extractTimer);
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch(console.error);
