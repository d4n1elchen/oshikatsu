import * as fs from "fs/promises";
import * as path from "path";
import { eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { artists, normalizedEvents } from "../../db/schema";
import type { Consumer } from "../Consumer";
import {
  serializeCalendar,
  type ICalEvent,
} from "../icalSerialize";
import { tagged } from "../logger";
import type { DeliveryResult, ExportRecord } from "../types";

const log = tagged("ICalConsumer");

type DbInstance = typeof defaultDb;

export type ICalConsumerOptions = {
  outputDir: string;
  calendarPrefix?: string;
  db?: DbInstance;
};

/**
 * Per-artist iCal file consumer. Each artist gets `<artist-name-slug>.ics`
 * in `outputDir`; users subscribe per artist. Sub-events are emitted as
 * separate VEVENT entries with `[Parent Title] ` prefixed onto SUMMARY,
 * since calendars don't model parent/child natively.
 *
 * When two artists slugify to the same name, the colliding ones get a
 * short id suffix — stable per artist so subscription URLs don't shuffle.
 *
 * Delivery model: rebuild each affected artist's file from scratch by
 * querying current state of `normalized_events`. Cheap at our scale (<<
 * 100k events) and avoids tracking per-event presence in the file.
 *
 * Atomic write: temp file + rename, so a subscribing client never sees a
 * half-written feed.
 *
 * Records with no `artist` are reported as delivered but written nowhere
 * — there is no per-artist target.
 */
export class ICalConsumer implements Consumer {
  readonly name = "ical";
  private outputDir: string;
  private calendarPrefix: string;
  private db: DbInstance;

  constructor(options: ICalConsumerOptions) {
    this.outputDir = options.outputDir;
    this.calendarPrefix = options.calendarPrefix ?? "Oshikatsu";
    this.db = options.db ?? defaultDb;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async deliver(batch: ExportRecord[]): Promise<DeliveryResult> {
    const affectedArtistIds = new Set<string>();
    const orphanedIds: string[] = [];

    for (const record of batch) {
      if (record.artist) {
        affectedArtistIds.add(record.artist.id);
      } else {
        orphanedIds.push(record.id);
      }
    }

    // Build the id→filename map for every artist so collisions are detected
    // even when only some of the colliding artists were touched this tick.
    const filenameByArtistId = await this.computeFilenameMap();

    const errors: { id: string; reason: string }[] = [];
    for (const artistId of affectedArtistIds) {
      const filename = filenameByArtistId.get(artistId);
      if (!filename) continue; // Artist row gone since the record was queued.
      try {
        await this.rebuildArtistFile(artistId, filename);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.error(`Failed to rebuild feed for artist ${artistId}:`, e);
        for (const record of batch) {
          if (record.artist?.id === artistId) {
            errors.push({ id: record.id, reason });
          }
        }
      }
    }

    const failedIds = new Set(errors.map((e) => e.id));
    const delivered = batch
      .filter((r) => !failedIds.has(r.id))
      .map((r) => r.id);

    if (orphanedIds.length > 0) {
      log.info(`${orphanedIds.length} record(s) had no artist; skipping iCal output`);
    }

    const failedArtistIds = new Set(
      errors
        .map((e) => batch.find((r) => r.id === e.id)?.artist?.id)
        .filter((x): x is string => x != null)
    );
    const rewrittenCount = affectedArtistIds.size - failedArtistIds.size;
    if (rewrittenCount > 0) {
      log.info(`Rewrote ${rewrittenCount} artist feed(s) (${batch.length} record(s) in batch)`);
    }

    return { delivered };
  }

  /**
   * Compute the full id→filename map for every artist in the database.
   * Filenames use a slugified name; ids that slugify to the same value get
   * a short id suffix to disambiguate, applied in id-sort order so each
   * artist's filename is stable across runs.
   */
  private async computeFilenameMap(): Promise<Map<string, string>> {
    const rows = await this.db.select({ id: artists.id, name: artists.name }).from(artists);

    const groups = new Map<string, { id: string; name: string }[]>();
    for (const row of rows) {
      const slug = slugifyArtistName(row.name) || row.id;
      const list = groups.get(slug) ?? [];
      list.push(row);
      groups.set(slug, list);
    }

    const result = new Map<string, string>();
    for (const [slug, group] of groups) {
      if (group.length === 1) {
        result.set(group[0]!.id, `${slug}.ics`);
        continue;
      }
      group.sort((a, b) => a.id.localeCompare(b.id));
      for (const artist of group) {
        result.set(artist.id, `${slug}-${artist.id.slice(0, 8)}.ics`);
      }
    }
    return result;
  }

  private async rebuildArtistFile(artistId: string, filename: string): Promise<void> {
    const [artistRow] = await this.db
      .select()
      .from(artists)
      .where(eq(artists.id, artistId))
      .limit(1);
    if (!artistRow) return;

    const events = await this.db
      .select()
      .from(normalizedEvents)
      .where(eq(normalizedEvents.artistId, artistId));

    // Look up parent titles for sub-events. A sub-event's parent may belong
    // to a different artist or no artist at all, so query by id rather than
    // filtering to this artist.
    const parentIds = [
      ...new Set(
        events
          .map((e) => e.parentEventId)
          .filter((x): x is string => x != null)
      ),
    ];
    const parentRows = parentIds.length > 0
      ? await this.db
          .select({ id: normalizedEvents.id, title: normalizedEvents.title })
          .from(normalizedEvents)
          .where(inArray(normalizedEvents.id, parentIds))
      : [];
    const parentTitleById = new Map(parentRows.map((p) => [p.id, p.title]));

    const now = new Date();
    const icalEvents: ICalEvent[] = events.map((e) => {
      const parentTitle = e.parentEventId ? parentTitleById.get(e.parentEventId) : null;
      const summary = parentTitle ? `[${parentTitle}] ${e.title}` : e.title;
      return {
        uid: `${e.id}@oshikatsu`,
        dtstamp: now,
        dtstart: e.startTime,
        dtend: e.endTime,
        summary,
        description: e.description,
        location: e.venueName,
        url: e.venueUrl,
        sequence: Math.floor(e.updatedAt.getTime() / 1000),
        status: e.isCancelled ? "CANCELLED" : "CONFIRMED",
      };
    });

    const calendarName = `${this.calendarPrefix} — ${artistRow.name}`;
    const body = serializeCalendar(calendarName, icalEvents);

    const finalPath = path.join(this.outputDir, filename);
    const tempPath = `${finalPath}.tmp`;
    await fs.writeFile(tempPath, body, "utf8");
    await fs.rename(tempPath, finalPath);
  }
}

/**
 * Convert an artist name into a filesystem-safe filename stem.
 *
 * Rules:
 *  - Strip control chars.
 *  - Replace `/ \ : * ? " < > |` with `_` (Windows-unsafe set, plus path
 *    separators on POSIX).
 *  - Collapse internal whitespace to single `-`.
 *  - Trim leading/trailing whitespace, dots, hyphens, and underscores so the
 *    result is neither hidden (`.foo`) nor confuses extension parsing.
 *  - Preserve Unicode (Japanese, etc.) — modern filesystems handle UTF-8.
 *
 * Returns an empty string if nothing usable remains; callers should fall
 * back to the artist id in that case.
 */
export function slugifyArtistName(name: string): string {
  const collapsed = name.replace(/\s+/g, "-");
  // eslint-disable-next-line no-control-regex
  const noControl = collapsed.replace(/[\u0000-\u001F\u007F]/g, "");
  const safeChars = noControl.replace(/[\\/:*?"<>|]/g, "_");
  const trimmed = safeChars.replace(/^[.\-_]+|[.\-_]+$/g, "");
  return trimmed;
}
