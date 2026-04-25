import { IngestionScheduler } from "./core/Scheduler";
import { NormalizationEngine } from "./core/NormalizationEngine";
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
  const normalizer = new NormalizationEngine(llm);

  console.log("Starting backend daemon...");
  
  // Start the ingestion scheduler (it handles its own interval loop)
  await scheduler.start();
  
  // We'll run the normalizer on the configured loop
  const normalizationIntervalMs = config.scheduler.normalizationIntervalMinutes * 60 * 1000;
  
  async function runNormalization() {
    try {
      await normalizer.processBatch(20);
    } catch (e) {
      console.error("Normalization loop error:", e);
    }
  }

  // Run normalizer immediately
  await runNormalization();
  
  // Schedule normalizer
  const normTimer = setInterval(runNormalization, normalizationIntervalMs);
  
  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log("\nShutting down gracefully...");
    clearInterval(normTimer);
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch(console.error);
