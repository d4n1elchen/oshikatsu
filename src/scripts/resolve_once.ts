import { EventResolver } from "../core/EventResolver";

function parseArgs(argv: string[]): { limit: number } {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 50;
  return { limit: Number.isFinite(limit) && limit > 0 ? limit : 50 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolver = new EventResolver();
  const result = await resolver.processBatch(args.limit);
  console.log(`Resolution complete. Resolved: ${result.resolved}, failed: ${result.failed}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
