import { Scheduler } from "./core/Scheduler";
import { runIngestionCycle } from "./core/ingestion";
import { ExtractionEngine } from "./core/ExtractionEngine";
import { EventResolver } from "./core/EventResolver";
import { OllamaProvider } from "./core/LLMProvider";
import { tagged } from "./core/logger";
import { getConfig } from "./config";

const log = tagged("daemon");

async function main() {
  const config = getConfig();

  const llm = new OllamaProvider();
  const extractor = new ExtractionEngine(llm);
  const resolver = new EventResolver();

  log.info("Starting backend daemon");

  // All three pipeline stages run as independent self-paced loops on a single
  // scheduler. Stages are decoupled because each is idempotent at the row
  // level (raw_items dedup by source_id, extractor skips already-extracted
  // raw items, resolver skips already-decided extracted events). This means
  // a slow LLM extraction batch doesn't block resolution from catching up,
  // and each stage gets its own cadence.
  const scheduler = new Scheduler()
    .add({
      name: "Ingestion",
      intervalMinutes: config.scheduler.ingestionIntervalMinutes,
      run: (signal) => runIngestionCycle(undefined, undefined, signal),
    })
    .add({
      name: "Extraction",
      intervalMinutes: config.scheduler.extractionIntervalMinutes,
      run: async (signal) => {
        const { processed, failed } = await extractor.processBatch(20, signal);
        return { processed, failed };
      },
    })
    .add({
      name: "Resolution",
      intervalMinutes: config.scheduler.resolutionIntervalMinutes,
      run: async (signal) => {
        const { resolved, failed } = await resolver.processBatch(50, signal);
        return { resolved, failed };
      },
    });

  scheduler.start();

  process.on("SIGINT", async () => {
    log.info("Shutting down gracefully");
    await scheduler.stop();
    process.exit(0);
  });
}

main().catch((e) => log.error("Fatal:", e));
