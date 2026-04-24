import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { artists, watchTargets } from "../db/schema";
import type { Artist, WatchTarget } from "./types";

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

  /** Remove an artist and all their watch targets. */
  async removeArtist(artistId: string): Promise<void> {
    // Drizzle schema handles cascading deletes for watchTargets
    await db.delete(artists).where(eq(artists.id, artistId));
  }

  /** Enable or disable all monitoring for an artist. */
  async toggleArtist(artistId: string, enabled: boolean): Promise<void> {
    await db
      .update(artists)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(artists.id, artistId));
  }

  /** Update an artist's editable fields. */
  async updateArtist(artistId: string, fields: { name?: string; categories?: string[]; groups?: string[] }): Promise<void> {
    await db
      .update(artists)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(artists.id, artistId));
  }

  /** List all artists, optionally filtering to enabled only. */
  async listArtists(enabledOnly: boolean = false): Promise<Artist[]> {
    if (enabledOnly) {
      return db.select().from(artists).where(eq(artists.enabled, true));
    }
    return db.select().from(artists);
  }

  // --- Watch Target management ---

  /** Add a new watch target for an artist. */
  async addTarget(artistId: string, platform: string, sourceType: string, sourceConfig: Record<string, any>): Promise<WatchTarget> {
    const newTarget = {
      id: randomUUID(),
      artistId,
      platform,
      sourceType,
      sourceConfig,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(watchTargets).values(newTarget);
    return newTarget;
  }

  /** Remove a watch target. */
  async removeTarget(targetId: string): Promise<void> {
    await db.delete(watchTargets).where(eq(watchTargets.id, targetId));
  }

  /** Enable or disable a specific watch target. */
  async toggleTarget(targetId: string, enabled: boolean): Promise<void> {
    await db
      .update(watchTargets)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(watchTargets.id, targetId));
  }

  /** 
   * Get all active watch targets for a platform.
   * Returns targets where both the artist and the target are enabled.
   * Used by the Scheduler to know what to fetch.
   */
  async getActiveTargets(platform: string): Promise<WatchTarget[]> {
    const results = await db
      .select({ target: watchTargets })
      .from(watchTargets)
      .innerJoin(artists, eq(watchTargets.artistId, artists.id))
      .where(
        and(
          eq(watchTargets.platform, platform),
          eq(watchTargets.enabled, true),
          eq(artists.enabled, true)
        )
      );

    return results.map((r: any) => r.target);
  }

  /** Get all watch targets for an artist. */
  async getTargetsForArtist(artistId: string): Promise<WatchTarget[]> {
    return db.select().from(watchTargets).where(eq(watchTargets.artistId, artistId));
  }
}
