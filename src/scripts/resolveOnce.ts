import { EventResolver } from "../core/EventResolver";
import { tagged } from "../core/logger";

const log = tagged("resolve:once");

function parseArgs(argv: string[]): { limit: number } {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 50;
  return { limit: Number.isFinite(limit) && limit > 0 ? limit : 50 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolver = new EventResolver();
  const result = await resolver.processBatch(args.limit);
  log.info(`Done; resolved ${result.resolved}, failed ${result.failed}`);
}

main().catch((error) => {
  log.error("Fatal:", error);
  process.exit(1);
});
