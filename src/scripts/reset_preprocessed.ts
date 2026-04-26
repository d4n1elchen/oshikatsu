import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { preprocessedEvents, rawItems, sourceReferences } from "../db/schema";

type ResetArgs = {
  all: boolean;
  dryRun: boolean;
  preprocessedEventIds: string[];
  rawItemIds: string[];
};

function parseArgs(argv: string[]): ResetArgs {
  const args: ResetArgs = {
    all: false,
    dryRun: false,
    preprocessedEventIds: [],
    rawItemIds: [],
  };

  for (const arg of argv) {
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--preprocessed-event-id=")) {
      args.preprocessedEventIds.push(readValue(arg, "--preprocessed-event-id="));
    } else if (arg.startsWith("--raw-item-id=")) {
      args.rawItemIds.push(readValue(arg, "--raw-item-id="));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const targetModeCount = Number(args.all) + Number(args.preprocessedEventIds.length > 0) + Number(args.rawItemIds.length > 0);
  if (targetModeCount !== 1) {
    throw new Error("Specify exactly one target mode: --preprocessed-event-id, --raw-item-id, or --all.");
  }

  return args;
}

function readValue(arg: string, prefix: string): string {
  const value = arg.slice(prefix.length).trim();
  if (!value) {
    throw new Error(`${prefix.slice(0, -1)} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  npm run reset:preprocessed -- --preprocessed-event-id=<preprocessed_event_id>
  npm run reset:preprocessed -- --raw-item-id=<raw_item_id>
  npm run reset:preprocessed -- --all

Options:
  --dry-run      Print the rows that would be touched without changing the database.
  --help, -h     Show this help text.

Notes:
  - Resetting an event deletes the preprocessed event.
  - Its source raw item(s) are marked status="new" and error_message=NULL.
  - preprocessed_event_related_links and source_references are removed by cascade delete.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetEventIds = await resolveTargetEventIds(args);
  const targetRawItemIds = await resolveTargetRawItemIds(targetEventIds, args.rawItemIds);

  if (targetEventIds.length === 0 && targetRawItemIds.length === 0) {
    console.log("No matching preprocessed events or raw items found.");
    return;
  }

  console.log(`Target preprocessed event(s): ${targetEventIds.length}`);
  for (const id of targetEventIds) console.log(`  event ${id}`);

  console.log(`Raw item(s) to requeue: ${targetRawItemIds.length}`);
  for (const id of targetRawItemIds) console.log(`  raw ${id}`);

  if (args.dryRun) {
    console.log("Dry run complete. No changes made.");
    return;
  }

  db.transaction((tx) => {
    if (targetRawItemIds.length > 0) {
      tx.update(rawItems)
        .set({ status: "new", errorMessage: null })
        .where(inArray(rawItems.id, targetRawItemIds))
        .run();
    }

    if (targetEventIds.length > 0) {
      tx.delete(preprocessedEvents)
        .where(inArray(preprocessedEvents.id, targetEventIds))
        .run();
    }
  });

  console.log(`Reset complete. Deleted ${targetEventIds.length} preprocessed event(s), requeued ${targetRawItemIds.length} raw item(s).`);
}

async function resolveTargetEventIds(args: ResetArgs): Promise<string[]> {
  if (args.all) {
    const rows = await db.select({ id: preprocessedEvents.id }).from(preprocessedEvents);
    return unique(rows.map((row) => row.id));
  }

  if (args.preprocessedEventIds.length > 0) {
    const rows = await db.select({ id: preprocessedEvents.id })
      .from(preprocessedEvents)
      .where(inArray(preprocessedEvents.id, unique(args.preprocessedEventIds)));
    return unique(rows.map((row) => row.id));
  }

  const rows = await db.select({ preprocessedEventId: sourceReferences.preprocessedEventId })
    .from(sourceReferences)
    .where(inArray(sourceReferences.rawItemId, unique(args.rawItemIds)));
  return unique(rows.map((row) => row.preprocessedEventId));
}

async function resolveTargetRawItemIds(eventIds: string[], explicitRawItemIds: string[]): Promise<string[]> {
  const ids = new Set(explicitRawItemIds);

  if (eventIds.length > 0) {
    const rows = await db.select({ rawItemId: sourceReferences.rawItemId })
      .from(sourceReferences)
      .where(inArray(sourceReferences.preprocessedEventId, eventIds));
    for (const row of rows) ids.add(row.rawItemId);
  }

  if (ids.size === 0) return [];

  const existing = await db.select({ id: rawItems.id })
    .from(rawItems)
    .where(and(inArray(rawItems.id, [...ids])));

  return unique(existing.map((row) => row.id));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
});
