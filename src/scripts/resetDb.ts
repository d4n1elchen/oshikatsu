import { count, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  eventResolutionDecisions,
  extractedEventRelatedLinks,
  extractedEvents,
  normalizedEventSources,
  normalizedEvents,
  rawItems,
} from "../db/schema";

type Mode =
  | "extracted_events"
  | "extracted_links"
  | "raw_items"
  | "normalized_events"
  | "resolution_decisions"
  | "resolution"
  | "all";

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
    } else if (arg === "--normalized_events" || arg === "--normalized-events") {
      setMode("normalized_events");
    } else if (arg === "--resolution_decisions" || arg === "--resolution-decisions") {
      setMode("resolution_decisions");
    } else if (arg === "--resolution") {
      setMode("resolution");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error(
      "Specify exactly one mode: --extracted_events, --extracted_links, --raw_items, --normalized_events, --resolution_decisions, --resolution, or --all.",
    );
  }

  return { mode, dryRun };
}

function printUsage(): void {
  console.log(`Usage: tsx src/scripts/resetDb.ts <mode> [--dry-run]

Modes (pick exactly one):
  --extracted_events     Delete all extracted events (cascades to resolution layer); reset linked raw items to status='new'.
  --extracted_links      Delete all extracted event related links.
  --raw_items            Delete all raw items (cascades to extracted events, related links, and resolution layer).
  --normalized_events    Delete all normalized events (cascades to normalized_event_sources; nulls decision matches).
  --resolution_decisions Delete all event resolution decisions.
  --resolution           Wipe the resolution layer only (normalized_events + decisions); leaves extracted_events intact for re-resolution.
  --all                  Wipe everything below artists/watch_targets/venues: raw_items + extracted_events + resolution layer.

Options:
  --dry-run              Print the rows that would be touched without changing the database.
  --help, -h             Show this help text.

Notes:
  - Hyphenated flag forms are also accepted (e.g. --extracted-events).
  - Artists, watch targets, venues, and venue aliases are never touched by this script.
  - Cascade rules: deleting raw_items deletes extracted_events; deleting extracted_events deletes
    normalized_event_sources and event_resolution_decisions; deleting normalized_events deletes
    normalized_event_sources and nulls matched_normalized_event_id on decisions.
  - --extracted_events also wipes normalized_events so the resolution layer doesn't end up orphaned.`);
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
  const normCount = await tableCount(normalizedEvents);
  const decisionCount = await tableCount(eventResolutionDecisions);

  console.log(`Will delete ${eventCount} extracted event(s).`);
  console.log(`Will reset ${rawItemIds.length} linked raw item(s) to status='new'.`);
  console.log(`Will also wipe resolution layer: ${normCount} normalized event(s), ${decisionCount} decision(s).`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (eventCount === 0 && normCount === 0 && decisionCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  db.transaction((tx) => {
    // Delete normalized layer first (decisions reference both extracted and normalized)
    tx.delete(normalizedEvents).run();
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
  const normCount = await tableCount(normalizedEvents);
  const decisionCount = await tableCount(eventResolutionDecisions);

  console.log(`Will delete ${rawCount} raw item(s).`);
  console.log(
    `Cascade will also delete: ${eventCount} extracted event(s), ${linkCount} related link(s).`,
  );
  console.log(`Will also wipe resolution layer: ${normCount} normalized event(s), ${decisionCount} decision(s).`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (rawCount === 0 && normCount === 0 && decisionCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  db.transaction((tx) => {
    tx.delete(normalizedEvents).run();
    tx.delete(rawItems).run();
  });
  console.log("Done.");
}

async function resetNormalizedEvents(dryRun: boolean): Promise<void> {
  const normCount = await tableCount(normalizedEvents);
  const sourceCount = await tableCount(normalizedEventSources);

  console.log(`Will delete ${normCount} normalized event(s).`);
  console.log(`Cascade will also delete: ${sourceCount} normalized event source link(s).`);
  console.log(`Resolution decisions will have matched_normalized_event_id set to NULL.`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (normCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  await db.delete(normalizedEvents);
  console.log("Done.");
}

async function resetResolutionDecisions(dryRun: boolean): Promise<void> {
  const decisionCount = await tableCount(eventResolutionDecisions);

  console.log(`Will delete ${decisionCount} event resolution decision(s).`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (decisionCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  await db.delete(eventResolutionDecisions);
  console.log("Done.");
}

async function resetResolutionLayer(dryRun: boolean): Promise<void> {
  const normCount = await tableCount(normalizedEvents);
  const sourceCount = await tableCount(normalizedEventSources);
  const decisionCount = await tableCount(eventResolutionDecisions);

  console.log(`Will delete ${normCount} normalized event(s), ${sourceCount} source link(s), and ${decisionCount} decision(s).`);
  console.log(`Extracted events remain intact and can be re-resolved.`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (normCount === 0 && decisionCount === 0) {
    console.log("Nothing to do.");
    return;
  }

  db.transaction((tx) => {
    tx.delete(eventResolutionDecisions).run();
    tx.delete(normalizedEvents).run();
  });
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
      // --all is an alias for --raw_items; cascade handles extracted/links/sources/decisions,
      // and we explicitly wipe normalized_events so nothing is left orphaned.
      await resetRawItems(args.dryRun);
      return;
    case "normalized_events":
      await resetNormalizedEvents(args.dryRun);
      return;
    case "resolution_decisions":
      await resetResolutionDecisions(args.dryRun);
      return;
    case "resolution":
      await resetResolutionLayer(args.dryRun);
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
