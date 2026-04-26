import { count, inArray } from "drizzle-orm";
import { db } from "../db";
import { extractedEventRelatedLinks, extractedEvents, rawItems } from "../db/schema";

type Mode = "extracted_events" | "extracted_links" | "raw_items" | "all";

interface ResetArgs {
  mode: Mode;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ResetArgs {
  let mode: Mode | null = null;
  let dryRun = false;

  const setMode = (m: Mode) => {
    if (mode && mode !== m) {
      throw new Error("Specify exactly one mode.");
    }
    mode = m;
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--all") {
      setMode("all");
    } else if (arg === "--extracted_events" || arg === "--extracted-events") {
      setMode("extracted_events");
    } else if (arg === "--extracted_links" || arg === "--extracted-links") {
      setMode("extracted_links");
    } else if (arg === "--raw_items" || arg === "--raw-items") {
      setMode("raw_items");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error("Specify exactly one mode: --extracted_events, --extracted_links, --raw_items, or --all.");
  }

  return { mode, dryRun };
}

function printUsage(): void {
  console.log(`Usage: tsx src/scripts/reset_db.ts <mode> [--dry-run]

Modes (pick exactly one):
  --extracted_events   Delete all extracted events; reset linked raw items to status='new'.
  --extracted_links    Delete all extracted event related links.
  --raw_items          Delete all raw items (cascades to extracted events and related links).
  --all                Equivalent to --raw_items: wipes the entire ingestion pipeline output.

Options:
  --dry-run            Print the rows that would be touched without changing the database.
  --help, -h           Show this help text.

Notes:
  - Hyphenated flag forms are also accepted (e.g. --extracted-events).
  - Artists, watch targets, venues, and venue aliases are never touched by this script.
  - Cascade rules in the schema mean deleting raw_items also deletes extracted_events.
  - Deleting extracted_events also deletes related links via cascade.`);
}

async function tableCount(table: any): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

async function resetExtractedEvents(dryRun: boolean): Promise<void> {
  const events = await db
    .select({ id: extractedEvents.id, rawItemId: extractedEvents.rawItemId })
    .from(extractedEvents);

  const eventCount = events.length;
  const rawItemIds = unique(events.map((e) => e.rawItemId).filter((id): id is string => Boolean(id)));

  console.log(`Will delete ${eventCount} extracted event(s).`);
  console.log(`Will reset ${rawItemIds.length} linked raw item(s) to status='new'.`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (eventCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  db.transaction((tx) => {
    tx.delete(extractedEvents).run();
    if (rawItemIds.length > 0) {
      tx.update(rawItems)
        .set({ status: "new", errorMessage: null })
        .where(inArray(rawItems.id, rawItemIds))
        .run();
    }
  });

  console.log("Done.");
}

async function resetExtractedLinks(dryRun: boolean): Promise<void> {
  const linkCount = await tableCount(extractedEventRelatedLinks);

  console.log(`Will delete ${linkCount} extracted event related link(s).`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (linkCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  await db.delete(extractedEventRelatedLinks);
  console.log("Done.");
}

async function resetRawItems(dryRun: boolean): Promise<void> {
  const rawCount = await tableCount(rawItems);
  const eventCount = await tableCount(extractedEvents);
  const linkCount = await tableCount(extractedEventRelatedLinks);

  console.log(`Will delete ${rawCount} raw item(s).`);
  console.log(
    `Cascade will also delete: ${eventCount} extracted event(s), ${linkCount} extracted event related link(s).`,
  );

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (rawCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  await db.delete(rawItems);
  console.log("Done.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.mode) {
    case "extracted_events":
      await resetExtractedEvents(args.dryRun);
      return;
    case "extracted_links":
      await resetExtractedLinks(args.dryRun);
      return;
    case "raw_items":
    case "all":
      // --all is an alias for --raw_items; cascade handles everything downstream.
      await resetRawItems(args.dryRun);
      return;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
});
