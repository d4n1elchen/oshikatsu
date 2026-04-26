import { IngestionScheduler } from "./core/Scheduler";
import { PreprocessingEngine } from "./core/PreprocessingEngine";
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
  const preprocessor = new PreprocessingEngine(llm);

  console.log("Starting backend daemon...");
  
  // Start the ingestion scheduler (it handles its own interval loop)
  await scheduler.start();
  
  // We'll run the preprocessor on the configured loop
  const preprocessingIntervalMs = config.scheduler.preprocessingIntervalMinutes * 60 * 1000;
  
  async function runPreprocessing() {
    try {
      await preprocessor.processBatch(20);
    } catch (e) {
      console.error("Preprocessing loop error:", e);
    }
  }

  // Run preprocessor immediately
  await runPreprocessing();
  
  // Schedule preprocessor
  const preprocessTimer = setInterval(runPreprocessing, preprocessingIntervalMs);
  
  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log("\nShutting down gracefully...");
    clearInterval(preprocessTimer);
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch(console.error);
