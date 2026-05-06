import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { artists, watchTargets } from "../db/schema";
import { validateHandle } from "./validateHandle";
import type { Artist, WatchTarget } from "./types";

type DbInstance = typeof defaultDb;

export class HandleInUseError extends Error {
  constructor(handle: string) {
    super(`Handle "${handle}" is already in use.`);
    this.name = "HandleInUseError";
  }
}

export class InvalidHandleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidHandleError";
  }
}

export class WatchListManager {
  private db: DbInstance;

  constructor(db: DbInstance = defaultDb) {
    this.db = db;
  }

  // --- Artist management ---

  /**
   * Add a new artist. `handle` is operator-supplied and must be unique;
   * we don't auto-derive from name. Throws InvalidHandleError on bad
   * format and HandleInUseError on collision.
   */
  async addArtist(
    name: string,
    handle: string,
    categories: string[] = [],
    groups: string[] = [],
  ): Promise<Artist> {
    const validation = validateHandle(handle);
    if (!validation.valid) throw new InvalidHandleError(validation.reason);
    if (await this.handleExists(handle)) throw new HandleInUseError(handle);

    const newArtist = {
      id: randomUUID(),
      handle,
      name,
      categories,
      groups,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.db.insert(artists).values(newArtist);
    return newArtist;
  }

  private async handleExists(handle: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.handle, handle))
      .limit(1);
    return rows.length > 0;
  }

  /** Remove an artist and all their watch targets. */
  async removeArtist(artistId: string): Promise<void> {
    // Drizzle schema handles cascading deletes for watchTargets
    await this.db.delete(artists).where(eq(artists.id, artistId));
  }

  /** Enable or disable all monitoring for an artist. */
  async toggleArtist(artistId: string, enabled: boolean): Promise<void> {
    await this.db
      .update(artists)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(artists.id, artistId));
  }

  /**
   * Update an artist's editable fields. If `handle` is provided and differs
   * from the current value, it is validated and checked for collisions.
   */
  async updateArtist(
    artistId: string,
    fields: { name?: string; categories?: string[]; groups?: string[]; handle?: string }
  ): Promise<void> {
    const { handle: requestedHandle, ...rest } = fields;
    const updates: Record<string, unknown> = { ...rest, updatedAt: new Date() };

    if (requestedHandle != null) {
      const existing = await this.db
        .select({ handle: artists.handle })
        .from(artists)
        .where(eq(artists.id, artistId))
        .limit(1);
      if (existing[0]?.handle !== requestedHandle) {
        const validation = validateHandle(requestedHandle);
        if (!validation.valid) throw new InvalidHandleError(validation.reason);
        if (await this.handleExists(requestedHandle)) throw new HandleInUseError(requestedHandle);
        updates.handle = requestedHandle;
      }
    }

    await this.db
      .update(artists)
      .set(updates)
      .where(eq(artists.id, artistId));
  }

  /** List all artists, optionally filtering to enabled only. */
  async listArtists(enabledOnly: boolean = false): Promise<Artist[]> {
    if (enabledOnly) {
      return this.db.select().from(artists).where(eq(artists.enabled, true));
    }
    return this.db.select().from(artists);
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

    await this.db.insert(watchTargets).values(newTarget);
    return newTarget;
  }

  /** Remove a watch target. */
  async removeTarget(targetId: string): Promise<void> {
    await this.db.delete(watchTargets).where(eq(watchTargets.id, targetId));
  }

  /** Enable or disable a specific watch target. */
  async toggleTarget(targetId: string, enabled: boolean): Promise<void> {
    await this.db
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
    const results = await this.db
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
    return this.db.select().from(watchTargets).where(eq(watchTargets.artistId, artistId));
  }
}
