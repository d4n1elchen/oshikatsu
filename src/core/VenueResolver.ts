import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { venueAliases, venues } from "../db/schema";
import type { NewVenueAlias, Venue } from "./types";

export interface VenueResolutionInput {
  venueName?: string | null;
  venueUrl?: string | null;
}

export interface VenueResolution {
  venue: Venue;
  method: "url" | "exact_alias" | "exact_name" | "discovered";
}

export class VenueResolver {
  async resolve(input: VenueResolutionInput): Promise<VenueResolution | null> {
    const venueUrl = normalizeUrl(input.venueUrl);
    const venueName = normalizeVenueName(input.venueName);

    if (venueUrl) {
      const byUrl = await this.findByUrl(venueUrl);
      if (byUrl) {
        await this.addAliasIfMissing(byUrl.id, input.venueName, venueName);
        return { venue: byUrl, method: "url" };
      }
    }

    if (!venueName) return null;

    const byAlias = await this.findByAlias(venueName);
    if (byAlias) return { venue: byAlias, method: "exact_alias" };

    const byName = await this.findByName(venueName);
    if (byName) return { venue: byName, method: "exact_name" };

    if (await this.hasIgnoredName(venueName)) {
      return null;
    }

    const discovered = await this.discoverVenue({
      venueName: input.venueName,
      normalizedVenueName: venueName,
      venueUrl,
    });

    return discovered ? { venue: discovered, method: "discovered" } : null;
  }

  private async findByUrl(url: string): Promise<Venue | null> {
    const rows = await db.select()
      .from(venues)
      .where(eq(venues.url, url))
      .limit(1);
    return firstUsableVenue(rows);
  }

  private async findByAlias(normalizedAlias: string): Promise<Venue | null> {
    const rows = await db.select({ venue: venues, alias: venueAliases.alias })
      .from(venueAliases)
      .innerJoin(venues, eq(venueAliases.venueId, venues.id));

    const match = rows.find((row) => row.venue.status !== "ignored" && normalizeVenueName(row.alias) === normalizedAlias);
    return match?.venue || null;
  }

  private async findByName(normalizedName: string): Promise<Venue | null> {
    const rows = await db.select().from(venues);
    return rows.find((venue) => venue.status !== "ignored" && normalizeVenueName(venue.name) === normalizedName) || null;
  }

  private async hasIgnoredName(normalizedName: string): Promise<boolean> {
    const aliasRows = await db.select({ venue: venues, alias: venueAliases.alias })
      .from(venueAliases)
      .innerJoin(venues, eq(venueAliases.venueId, venues.id));
    if (aliasRows.some((row) => row.venue.status === "ignored" && normalizeVenueName(row.alias) === normalizedName)) {
      return true;
    }

    const venueRows = await db.select().from(venues);
    return venueRows.some((venue) => venue.status === "ignored" && normalizeVenueName(venue.name) === normalizedName);
  }

  private async addAliasIfMissing(
    venueId: string,
    venueName?: string | null,
    normalizedVenueName?: string
  ): Promise<void> {
    const displayName = normalizeDisplayName(venueName);
    const normalizedName = normalizedVenueName || normalizeVenueName(displayName);
    if (!isUsableVenueName(displayName, normalizedName)) return;

    const rows = await db.select()
      .from(venueAliases)
      .where(eq(venueAliases.venueId, venueId));
    if (rows.some((alias) => normalizeVenueName(alias.alias) === normalizedName)) {
      return;
    }

    await db.insert(venueAliases).values({
      id: randomUUID(),
      venueId,
      alias: displayName,
      locale: null,
      source: "preprocessing",
      createdAt: new Date(),
    }).onConflictDoNothing();
  }

  private async discoverVenue(input: {
    venueName?: string | null;
    normalizedVenueName: string;
    venueUrl: string;
  }): Promise<Venue | null> {
    const displayName = normalizeDisplayName(input.venueName);
    if (!isUsableVenueName(displayName, input.normalizedVenueName)) {
      return null;
    }

    const inferredKind = inferVenueKind(input.normalizedVenueName, input.venueUrl);

    // Virtual venues require a URL to be auto-discovered. A bare platform
    // name like "YouTube" identifies only the platform, not a specific
    // destination — auto-creating one venue per platform name would conflate
    // unrelated events that just happen to share a platform.
    if (inferredKind === "virtual" && !input.venueUrl) {
      return null;
    }

    const now = new Date();
    const newVenue: Venue = {
      id: randomUUID(),
      name: displayName,
      kind: inferredKind,
      status: "discovered",
      url: input.venueUrl || null,
      address: null,
      city: null,
      region: null,
      country: null,
      latitude: null,
      longitude: null,
      createdAt: now,
      updatedAt: now,
    };

    const alias: NewVenueAlias = {
      id: randomUUID(),
      venueId: newVenue.id,
      alias: displayName,
      locale: null,
      source: "preprocessing",
      createdAt: now,
    };

    db.transaction((tx) => {
      tx.insert(venues).values(newVenue).run();
      tx.insert(venueAliases).values(alias).onConflictDoNothing().run();
    });

    return newVenue;
  }
}

function firstUsableVenue(rows: Venue[]): Venue | null {
  return rows.find((venue) => venue.status !== "ignored") || null;
}

function normalizeDisplayName(value?: string | null): string {
  return (value || "").trim().replace(/\s+/g, " ");
}

function normalizeVenueName(value?: string | null): string {
  return (value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function normalizeUrl(value?: string | null): string {
  return (value || "").trim();
}

function isUsableVenueName(displayName: string, normalizedName: string): boolean {
  if (!displayName || !normalizedName) return false;
  if (normalizedName.length < 2) return false;
  return /[\p{L}\p{N}]/u.test(displayName);
}

function inferVenueKind(normalizedName: string, venueUrl: string): Venue["kind"] {
  const haystack = `${normalizedName} ${venueUrl.toLocaleLowerCase("en-US")}`;
  if (/(youtube|youtu\.be|twitch|niconico|nicovideo|streaming\+|z-an|zan-live)/.test(haystack)) {
    return "virtual";
  }

  return "unknown";
}
