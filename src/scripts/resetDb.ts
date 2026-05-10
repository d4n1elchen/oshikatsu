import { count, lt, ne } from "drizzle-orm";
import { db } from "../db";
import {
  artists,
  eventResolutionDecisions,
  exportCursors,
  exportQueue,
  extractedEventRelatedLinks,
  extractedEvents,
  normalizedEventSources,
  normalizedEvents,
  rawItems,
  schedulerRuns,
  venueAliases,
  venues,
  watchTargets,
} from "../db/schema";

type Mode =
  // Per-table modes — one flag per table in the schema.
  | "artists"
  | "watch_targets"
  | "raw_items"
  | "venues"
  | "venue_aliases"
  | "extracted_events"
  | "extracted_links"
  | "normalized_events"
  | "normalized_event_sources"
  | "resolution_decisions"
  | "scheduler_runs"
  | "export_queue"
  | "export_cursors"
  // Convenience combos.
  | "resolution"
  | "export"
  | "watchlist"
  | "all"
  | "everything";

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

  // Map of (--flag, alias --flag-with-hyphens) → mode.
  const flagToMode: Record<string, Mode> = {
    "--artists": "artists",
    "--watch_targets": "watch_targets",
    "--watch-targets": "watch_targets",
    "--targets": "watch_targets",
    "--raw_items": "raw_items",
    "--raw-items": "raw_items",
    "--venues": "venues",
    "--venue_aliases": "venue_aliases",
    "--venue-aliases": "venue_aliases",
    "--extracted_events": "extracted_events",
    "--extracted-events": "extracted_events",
    "--extracted_links": "extracted_links",
    "--extracted-links": "extracted_links",
    "--normalized_events": "normalized_events",
    "--normalized-events": "normalized_events",
    "--normalized_event_sources": "normalized_event_sources",
    "--normalized-event-sources": "normalized_event_sources",
    "--resolution_decisions": "resolution_decisions",
    "--resolution-decisions": "resolution_decisions",
    "--scheduler_runs": "scheduler_runs",
    "--scheduler-runs": "scheduler_runs",
    "--runs": "scheduler_runs",
    "--export_queue": "export_queue",
    "--export-queue": "export_queue",
    "--export_cursors": "export_cursors",
    "--export-cursors": "export_cursors",
    "--resolution": "resolution",
    "--export": "export",
    "--watchlist": "watchlist",
    "--all": "all",
    "--everything": "everything",
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--older-than=")) {
      olderThanMs = parseDurationToMs(arg.slice("--older-than=".length));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (flagToMode[arg]) {
      setMode(flagToMode[arg]!);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error("Specify exactly one mode. Run with --help for the full list.");
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

Per-table modes:
  --artists                   Delete all artists. Cascades to watch_targets, raw_items, extracted/normalized layers.
  --watch_targets             Delete all watch targets. Cascades to raw_items + downstream.
  --raw_items                 Delete all raw items. Cascades to extracted/normalized layers.
  --venues                    Delete all venues. Cascades to venue_aliases; extracted/normalized venue_id set NULL.
  --venue_aliases             Delete all venue aliases.
  --extracted_events          Delete all extracted events; reset linked raw items to status='new'.
  --extracted_links           Delete all extracted event related links.
  --normalized_events         Delete all normalized events. Cascades to normalized_event_sources + export_queue.
  --normalized_event_sources  Delete all normalized_event_sources entries.
  --resolution_decisions      Delete all event resolution decisions.
  --scheduler_runs            Delete scheduler_runs rows (pair with --older-than to prune by age).
  --export_queue              Delete all export_queue entries.
  --export_cursors            Delete all export_cursors.

Convenience combos:
  --resolution                Wipe normalized_events + resolution_decisions; leaves extracted_events for re-resolution.
  --export                    Wipe export_queue + export_cursors.
  --watchlist                 Wipe artists + watch_targets + venues + venue_aliases. Cascades to all downstream data.
  --all                       Wipe operational data: raw_items + downstream + scheduler_runs + export tables.
                              Preserves watchlist (artists/targets/venues).
  --everything                Wipe absolutely every row. Schema only survives.

Options:
  --dry-run                   Print the rows that would be touched without changing the database.
  --older-than=DURATION       For --scheduler_runs only: delete runs older than DURATION (e.g. 30d, 12h, 60m).
  --help, -h                  Show this help text.

Notes:
  - Hyphenated flag forms are also accepted (e.g. --extracted-events).
  - Cascade rules: deleting raw_items deletes extracted_events; deleting extracted_events deletes
    normalized_event_sources, event_resolution_decisions; deleting normalized_events deletes
    normalized_event_sources, export_queue rows, and nulls matched_normalized_event_id on decisions.
  - --extracted_events also wipes normalized_events so the resolution layer doesn't end up orphaned.`);
}

async function tableCount(table: any): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table);
  return row?.value ?? 0;
}

// --- Per-table reset functions ---

async function resetArtists(dryRun: boolean): Promise<void> {
  const artistCount = await tableCount(artists);
  const targetCount = await tableCount(watchTargets);
  const rawCount = await tableCount(rawItems);
  const eventCount = await tableCount(extractedEvents);
  const normCount = await tableCount(normalizedEvents);

  console.log(`Will delete ${artistCount} artist(s).`);
  console.log(
    `Cascade will also delete: ${targetCount} watch target(s), ${rawCount} raw item(s), ${eventCount} extracted event(s), ${normCount} normalized event(s) and all dependent rows.`,
  );

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  if (artistCount === 0) {
    console.log("Nothing to do.");
    return;
  }
  await db.delete(artists);
  console.log("Done.");
}

async function resetWatchTargets(dryRun: boolean): Promise<void> {
  const targetCount = await tableCount(watchTargets);
  const rawCount = await tableCount(rawItems);

  console.log(`Will delete ${targetCount} watch target(s).`);
  console.log(`Cascade will also delete: ${rawCount} raw item(s) and all dependent rows.`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  if (targetCount === 0) {
    console.log("Nothing to do.");
    return;
  }
  await db.delete(watchTargets);
  console.log("Done.");
}

async function resetVenues(dryRun: boolean): Promise<void> {
  const venueCount = await tableCount(venues);
  const aliasCount = await tableCount(venueAliases);

  console.log(`Will delete ${venueCount} venue(s).`);
  console.log(`Cascade will also delete: ${aliasCount} venue alias(es). venue_id on extracted/normalized events will be set NULL.`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }
  if (venueCount === 0) {
    console.log("Nothing to do.");
    return;
  }
  await db.delete(venues);
  console.log("Done.");
}

async function resetVenueAliases(dryRun: boolean): Promise<void> {
  const aliasCount = await tableCount(venueAliases);
  console.log(`Will delete ${aliasCount} venue alias(es).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (aliasCount === 0) { console.log("Nothing to do."); return; }
  await db.delete(venueAliases);
  console.log("Done.");
}

async function resetExtractedEvents(dryRun: boolean): Promise<void> {
  const eventCount = await tableCount(extractedEvents);
  const normCount = await tableCount(normalizedEvents);
  const decisionCount = await tableCount(eventResolutionDecisions);

  // Reset every non-new raw_item, not only the ones with a successful
  // extracted_event. Failed extractions land at status='error' with no
  // extracted_events row; without this, those rows would stay 'error' and
  // never be retried by the extractor on its next pass.
  const rawToReset = await db
    .select({ id: rawItems.id })
    .from(rawItems)
    .where(ne(rawItems.status, "new"));

  console.log(`Will delete ${eventCount} extracted event(s).`);
  console.log(`Will reset ${rawToReset.length} non-new raw item(s) to status='new'.`);
  console.log(`Will also wipe resolution layer: ${normCount} normalized event(s), ${decisionCount} decision(s).`);

  if (dryRun) {
    console.log("Dry run; no changes made.");
    return;
  }

  if (eventCount === 0 && normCount === 0 && decisionCount === 0 && rawToReset.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  db.transaction((tx) => {
    // Delete normalized layer first (decisions reference both extracted and normalized)
    tx.delete(normalizedEvents).run();
    tx.delete(extractedEvents).run();
    tx.update(rawItems)
      .set({ status: "new", errorMessage: null, errorClass: null })
      .where(ne(rawItems.status, "new"))
      .run();
  });

  console.log("Done.");
}

async function resetExtractedLinks(dryRun: boolean): Promise<void> {
  const linkCount = await tableCount(extractedEventRelatedLinks);
  console.log(`Will delete ${linkCount} extracted event related link(s).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (linkCount === 0) { console.log("Nothing to do."); return; }
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
  const queueCount = await tableCount(exportQueue);

  console.log(`Will delete ${normCount} normalized event(s).`);
  console.log(`Cascade will also delete: ${sourceCount} normalized_event_sources row(s), ${queueCount} export_queue row(s).`);
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

async function resetNormalizedEventSources(dryRun: boolean): Promise<void> {
  const c = await tableCount(normalizedEventSources);
  console.log(`Will delete ${c} normalized_event_sources row(s).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (c === 0) { console.log("Nothing to do."); return; }
  await db.delete(normalizedEventSources);
  console.log("Done.");
}

async function resetResolutionDecisions(dryRun: boolean): Promise<void> {
  const decisionCount = await tableCount(eventResolutionDecisions);
  console.log(`Will delete ${decisionCount} event resolution decision(s).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (decisionCount === 0) { console.log("Nothing to do."); return; }
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

async function resetExportQueue(dryRun: boolean): Promise<void> {
  const c = await tableCount(exportQueue);
  console.log(`Will delete ${c} export_queue row(s).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (c === 0) { console.log("Nothing to do."); return; }
  await db.delete(exportQueue);
  console.log("Done.");
}

async function resetExportCursors(dryRun: boolean): Promise<void> {
  const c = await tableCount(exportCursors);
  console.log(`Will delete ${c} export_cursors row(s).`);
  if (dryRun) { console.log("Dry run; no changes made."); return; }
  if (c === 0) { console.log("Nothing to do."); return; }
  await db.delete(exportCursors);
  console.log("Done.");
}

// --- Combo modes ---

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

async function resetExportTables(dryRun: boolean): Promise<void> {
  await resetExportQueue(dryRun);
  await resetExportCursors(dryRun);
}

async function resetWatchlist(dryRun: boolean): Promise<void> {
  // Order matters: artists cascade-deletes watch_targets and (transitively)
  // raw_items + downstream. Venues are independent and just need their
  // aliases removed via cascade.
  await resetArtists(dryRun);
  await resetVenues(dryRun);
}

async function resetAll(dryRun: boolean): Promise<void> {
  // Operational data only — preserves watchlist (artists/targets/venues).
  await resetRawItems(dryRun);
  await resetSchedulerRuns(dryRun);
  await resetExportTables(dryRun);
}

async function resetEverything(dryRun: boolean): Promise<void> {
  await resetAll(dryRun);
  await resetWatchlist(dryRun);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.mode) {
    case "artists": return resetArtists(args.dryRun);
    case "watch_targets": return resetWatchTargets(args.dryRun);
    case "raw_items": return resetRawItems(args.dryRun);
    case "venues": return resetVenues(args.dryRun);
    case "venue_aliases": return resetVenueAliases(args.dryRun);
    case "extracted_events": return resetExtractedEvents(args.dryRun);
    case "extracted_links": return resetExtractedLinks(args.dryRun);
    case "normalized_events": return resetNormalizedEvents(args.dryRun);
    case "normalized_event_sources": return resetNormalizedEventSources(args.dryRun);
    case "resolution_decisions": return resetResolutionDecisions(args.dryRun);
    case "scheduler_runs": return resetSchedulerRuns(args.dryRun, args.olderThanMs);
    case "export_queue": return resetExportQueue(args.dryRun);
    case "export_cursors": return resetExportCursors(args.dryRun);
    case "resolution": return resetResolutionLayer(args.dryRun);
    case "export": return resetExportTables(args.dryRun);
    case "watchlist": return resetWatchlist(args.dryRun);
    case "all": return resetAll(args.dryRun);
    case "everything": return resetEverything(args.dryRun);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
});
