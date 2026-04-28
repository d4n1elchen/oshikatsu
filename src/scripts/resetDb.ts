import { count, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import {
  eventResolutionDecisions,
  extractedEventRelatedLinks,
  extractedEvents,
  normalizedEventSources,
  normalizedEvents,
  rawItems,
  schedulerRuns,
} from "../db/schema";

type Mode =
  | "extracted_events"
  | "extracted_links"
  | "raw_items"
  | "normalized_events"
  | "resolution_decisions"
  | "resolution"
  | "scheduler_runs"
  | "all";

interface ResetArgs {
  mode: Mode;
  dryRun: boolean;
  /** For scheduler_runs mode: only delete runs older than this. */
  olderThanMs?: number;
}

function parseArgs(argv: string[]): ResetArgs {
  let mode: Mode | null = null;
  let dryRun = false;
  let olderThanMs: number | undefined;

  const setMode = (m: Mode) => {
    if (mode && mode !== m) {
      throw new Error("Specify exactly one mode.");
    }
    mode = m;
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--older-than=")) {
      olderThanMs = parseDurationToMs(arg.slice("--older-than=".length));
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
    } else if (arg === "--scheduler_runs" || arg === "--scheduler-runs" || arg === "--runs") {
      setMode("scheduler_runs");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error(
      "Specify exactly one mode: --extracted_events, --extracted_links, --raw_items, --normalized_events, --resolution_decisions, --resolution, --scheduler_runs, or --all.",
    );
  }

  return { mode, dryRun, olderThanMs };
}

function parseDurationToMs(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`Invalid --older-than value "${s}"; expected e.g. 30d, 12h, 60m, 90s`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * factor;
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
  --scheduler_runs       Delete scheduler_runs rows (defaults to all; pair with --older-than to prune by age).
  --all                  Wipe everything below artists/watch_targets/venues: raw_items + extracted_events + resolution layer + scheduler_runs.

Options:
  --dry-run              Print the rows that would be touched without changing the database.
  --older-than=DURATION  For --scheduler_runs only: delete runs older than DURATION. Examples: 30d, 12h, 60m.
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

async function resetSchedulerRuns(dryRun: boolean, olderThanMs?: number): Promise<void> {
  const total = await tableCount(schedulerRuns);
  let toDelete = total;
  let cutoff: Date | null = null;
  if (olderThanMs !== undefined) {
    cutoff = new Date(Date.now() - olderThanMs);
    const rows = await db
      .select({ id: schedulerRuns.id })
      .from(schedulerRuns)
      .where(lt(schedulerRuns.startedAt, cutoff));
    toDelete = rows.length;
  }

  if (cutoff) {
    console.log(`Will delete ${toDelete} of ${total} scheduler run(s) (older than ${cutoff.toISOString()}).`);
  } else {
    console.log(`Will delete all ${total} scheduler run(s).`);
  }

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (toDelete === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (cutoff) {
    await db.delete(schedulerRuns).where(lt(schedulerRuns.startedAt, cutoff));
  } else {
    await db.delete(schedulerRuns);
  }
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
      await resetRawItems(args.dryRun);
      return;
    case "all":
      // --all wipes raw_items (cascading to extracted/links/sources/decisions
      // and explicitly normalized_events) plus scheduler_runs.
      await resetRawItems(args.dryRun);
      await resetSchedulerRuns(args.dryRun);
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
    case "scheduler_runs":
      await resetSchedulerRuns(args.dryRun, args.olderThanMs);
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
