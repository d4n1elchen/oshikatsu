import { EventResolver } from "../core/EventResolver";
import { EmbeddingsRepo } from "../core/EmbeddingsRepo";
import { OllamaEmbeddingService } from "../core/EmbeddingService";
import { db } from "../db";
import { getConfig } from "../config";
import { tagged } from "../core/logger";

const log = tagged("resolve:once");

function parseArgs(argv: string[]): { limit: number } {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const parsed = limitArg ? Number(limitArg.split("=")[1]) : NaN;
  // Default to "process all pending" — one-shot script is usually run to
  // drain the queue. Pass --limit=N to cap for partial runs.
  return { limit: Number.isFinite(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const embeddings = getConfig().embeddings.enabled
    ? new EmbeddingsRepo(db, new OllamaEmbeddingService())
    : null;
  if (embeddings) {
    log.info(`Embeddings enabled (model=${embeddings.modelId()}, cosineThreshold=${embeddings.cosineThreshold()})`);
  }
  const resolver = new EventResolver(undefined, undefined, null, embeddings);
  const result = await resolver.processBatch(args.limit);
  log.info(
    `Done; resolved ${result.resolved}, failed ${result.failed}; ` +
      `annotations attached ${result.annotationsAttached}, no_match ${result.annotationsNoMatch}, ` +
      `deferred ${result.annotationsDeferred}, failed ${result.annotationsFailed}`
  );
}

main().catch((error) => {
  log.error("Fatal:", error);
  process.exit(1);
});
