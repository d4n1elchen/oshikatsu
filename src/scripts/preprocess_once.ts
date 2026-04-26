import { db } from "../db";
import { rawItems } from "../db/schema";
import { PreprocessingEngine } from "../core/PreprocessingEngine";
import { OllamaProvider } from "../core/LLMProvider";
import { RawStorage } from "../core/RawStorage";
import { eq } from "drizzle-orm";

function parseArgs(argv: string[]): { limit: number; retryErrors: boolean } {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 5;

  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5,
    retryErrors: argv.includes("--retry-errors"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storage = new RawStorage();

  if (args.retryErrors) {
    const errored = await db.select({ id: rawItems.id }).from(rawItems).where(eq(rawItems.status, "error"));
    for (const item of errored) {
      await storage.markNew(item.id);
    }
    console.log(`Queued ${errored.length} errored raw item(s) for retry.`);
  }

  const engine = new PreprocessingEngine(new OllamaProvider());
  const result = await engine.processBatch(args.limit);

  console.log(`Preprocessing complete. Processed: ${result.processed}, failed: ${result.failed}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
