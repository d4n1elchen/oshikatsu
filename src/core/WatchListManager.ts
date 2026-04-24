import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { artists, sourceEntries } from "../db/schema";
import type { Artist, SourceEntry } from "./types";

export class WatchListManager {
  // --- Artist management ---

  /** Add a new artist to the watch list. */
  async addArtist(name: string, categories: string[] = [], groups: string[] = []): Promise<Artist> {
    const newArtist = {
      id: randomUUID(),
      name,
      categories,
      groups,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(artists).values(newArtist);
    return newArtist;
  }

  /** Remove an artist and all their source entries. */
  async removeArtist(artistId: string): Promise<void> {
    // Drizzle schema handles cascading deletes for sourceEntries
    await db.delete(artists).where(eq(artists.id, artistId));
  }

  /** Enable or disable all monitoring for an artist. */
  async toggleArtist(artistId: string, enabled: boolean): Promise<void> {
    await db
      .update(artists)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(artists.id, artistId));
  }

  /** List all artists, optionally filtering to enabled only. */
  async listArtists(enabledOnly: boolean = false): Promise<Artist[]> {
    if (enabledOnly) {
      return db.select().from(artists).where(eq(artists.enabled, true));
    }
    return db.select().from(artists);
  }

  // --- Source entry management ---

  /** Add a new source entry for an artist. */
  async addSource(artistId: string, platform: string, sourceType: string, sourceConfig: Record<string, any>): Promise<SourceEntry> {
    const newSource = {
      id: randomUUID(),
      artistId,
      platform,
      sourceType,
      sourceConfig,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(sourceEntries).values(newSource);
    return newSource;
  }

  /** Remove a source entry. */
  async removeSource(sourceId: string): Promise<void> {
    await db.delete(sourceEntries).where(eq(sourceEntries.id, sourceId));
  }

  /** Enable or disable a specific source. */
  async toggleSource(sourceId: string, enabled: boolean): Promise<void> {
    await db
      .update(sourceEntries)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(sourceEntries.id, sourceId));
  }

  /** 
   * Get all active sources for a platform.
   * Returns sources where both the artist and the source are enabled.
   * Used by the Scheduler to know what to fetch.
   */
  async getActiveSources(platform: string): Promise<SourceEntry[]> {
    const results = await db
      .select({ source: sourceEntries })
      .from(sourceEntries)
      .innerJoin(artists, eq(sourceEntries.artistId, artists.id))
      .where(
        and(
          eq(sourceEntries.platform, platform),
          eq(sourceEntries.enabled, true),
          eq(artists.enabled, true)
        )
      );

    return results.map(r => r.source);
  }

  /** Get all source entries for an artist. */
  async getSourcesForArtist(artistId: string): Promise<SourceEntry[]> {
    return db.select().from(sourceEntries).where(eq(sourceEntries.artistId, artistId));
  }
}
