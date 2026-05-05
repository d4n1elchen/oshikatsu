import { Scheduler } from "./core/Scheduler";
import { runIngestionCycle } from "./core/ingestion";
import { ExtractionEngine } from "./core/ExtractionEngine";
import { EventResolver } from "./core/EventResolver";
import { ExportQueueRepo } from "./core/ExportQueueRepo";
import { ExportRunner } from "./core/ExportRunner";
import type { Consumer } from "./core/Consumer";
import { OllamaProvider } from "./core/LLMProvider";
import { tagged } from "./core/logger";
import { getConfig } from "./config";

const log = tagged("daemon");

async function main() {
  const config = getConfig();

  const llm = new OllamaProvider();
  const extractor = new ExtractionEngine(llm);

  // Phase 5: when export is enabled, the resolver enqueues consumer-visible
  // changes into export_queue inside its existing write transactions. When
  // disabled, no queue rows are written and the runner is not registered.
  const exportQueueRepo = config.export.enabled ? new ExportQueueRepo() : null;
  const resolver = new EventResolver(undefined, undefined, exportQueueRepo);

  // Real consumers (calendar, webhook, notification dispatch, etc.) are added
  // here as separate follow-ups once the protocol lands. Until one is
  // registered, the runner is a no-op and the queue accumulates harmlessly.
  const consumers: Consumer[] = [];

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

  let exportRunner: ExportRunner | null = null;
  if (config.export.enabled && consumers.length > 0) {
    exportRunner = new ExportRunner(consumers);
    await exportRunner.start();
    scheduler.add({
      name: "Export",
      intervalMinutes: config.scheduler.exportIntervalMinutes,
      run: (signal) => exportRunner!.tick(signal),
    });
  }

  scheduler.start();

  process.on("SIGINT", async () => {
    log.info("Shutting down gracefully");
    await scheduler.stop();
    if (exportRunner) await exportRunner.stop();
    process.exit(0);
  });
}

main().catch((e) => log.error("Fatal:", e));
