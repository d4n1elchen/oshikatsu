import { IngestionScheduler } from "./core/Scheduler";

async function main() {
  const scheduler = new IngestionScheduler({
    intervalMinutes: 15, // Run every 15 minutes
    maxConcurrentJobs: 1,
    retryOnFailure: false,
    retryDelayMinutes: 5,
  });

  console.log("Starting backend ingestion daemon...");
  await scheduler.start();
  
  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log("\nShutting down gracefully...");
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch(console.error);
