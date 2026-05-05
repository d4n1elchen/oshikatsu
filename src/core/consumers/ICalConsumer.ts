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
 * Per-artist iCal file consumer. Each artist gets `<artist-id>.ics` in
 * `outputDir`; users subscribe per artist. Sub-events are emitted as
 * separate VEVENT entries with `[Parent Title] ` prefixed onto SUMMARY,
 * since calendars don't model parent/child natively.
 *
 * Delivery model: rebuild each affected artist's file from scratch by
 * querying current state of `normalized_events`. Cheap at our scale (<<
 * 100k events) and avoids tracking per-event presence in the file.
 *
 * Atomic write: temp file + rename, so a subscribing client never sees a
 * half-written feed.
 *
 * Records with no `artist` are reported as delivered but written nowhere
 * — there is no per-artist target. A future "_orphans.ics" fallback can
 * be added if needed.
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

    const errors: { id: string; reason: string }[] = [];
    for (const artistId of affectedArtistIds) {
      try {
        await this.rebuildArtistFile(artistId);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.error(`Failed to rebuild feed for artist ${artistId}:`, e);
        // Mark all records for this artist as needing retry by leaving
        // them out of `delivered`. The runner implicitly retries them.
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

    return { delivered };
  }

  /**
   * Rebuild the .ics for a single artist by querying their current
   * canonical events plus their parents' titles for sub-event prefixing.
   */
  private async rebuildArtistFile(artistId: string): Promise<void> {
    const [artistRow] = await this.db
      .select()
      .from(artists)
      .where(eq(artists.id, artistId))
      .limit(1);
    if (!artistRow) {
      // Artist deleted; remove the stale feed if present.
      await this.removeArtistFile(artistId);
      return;
    }

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
        // SEQUENCE per RFC: monotonic per UID. We don't track per-uid
        // emit count yet; using updated_at-derived seconds gives a
        // monotonic-enough integer that survives across rebuilds.
        sequence: Math.floor(e.updatedAt.getTime() / 1000),
        status: e.isCancelled ? "CANCELLED" : "CONFIRMED",
      };
    });

    const calendarName = `${this.calendarPrefix} — ${artistRow.name}`;
    const body = serializeCalendar(calendarName, icalEvents);

    const finalPath = path.join(this.outputDir, `${artistId}.ics`);
    const tempPath = `${finalPath}.tmp`;
    await fs.writeFile(tempPath, body, "utf8");
    await fs.rename(tempPath, finalPath);
  }

  private async removeArtistFile(artistId: string): Promise<void> {
    const finalPath = path.join(this.outputDir, `${artistId}.ics`);
    try {
      await fs.unlink(finalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
