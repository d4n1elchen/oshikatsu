# Virtual Venue Granularity

## Overview

This document refines the Phase 2.1 venue resolver behavior for virtual venues. It treats each distinct virtual destination (e.g., a YouTube channel) as its own venue record, mirroring how physical venues are modelled, instead of collapsing every YouTube/Twitch/etc. event into a single platform-level row.

This design extends `design_docs/2026-04-25-venue-database/venue-database.md`. It introduces no new tables; the change is in resolver behavior and the LLM prompt. The local database will be rebuilt from scratch as part of rollout, so no in-place data migration is required.

## Problem

Today the resolver auto-discovers a venue named after the platform whenever an event mentions a virtual platform without prior history. The first event that says "Live on YouTube" creates a `discovered` venue named "YouTube" with the alias "YouTube". Every subsequent unrelated YouTube event matches that alias and shares the same `venue_id`.

Effects:

- The single "YouTube" row accumulates cross-artist, cross-genre events as if they shared a venue identity.
- The Events TUI badges every livestream as `Venue: YouTube → YouTube [virtual, discovered]`, which is true but uninformative.
- During Phase 3 dedup, candidate selection by `venue_id` pulls every concurrent YouTube event as a candidate to score, even though the dedup engine then has to discount the signal as weak/risky.
- The conceptual model breaks parity with physical venues: "Tokyo Dome" identifies a specific place, but "YouTube" identifies only the platform — analogous to setting every concert's venue to "concert hall."

## Goals

- Treat each distinct virtual destination as its own venue, identified by URL.
- Preserve the conservative, exact-match resolver behavior already used for physical venues.
- Ensure the same channel mentioned twice resolves to the same venue.
- Stop auto-creating venues from bare platform names with no URL.

## Non-Goals

- Do not introduce new tables or schema columns.
- Do not implement YouTube/Twitch/etc. URL canonicalization beyond trim/case-fold.
- Do not implement fuzzy matching across URL forms (e.g., `youtu.be/abc` vs. `youtube.com/watch?v=abc`).
- Do not auto-extract a channel URL from a stream URL by following the network.
- Do not introduce a kind beyond `physical` / `virtual` / `unknown`.

## Conceptual Model

Mirror the physical-venue model:

| Physical analogy            | Virtual equivalent                        |
| --------------------------- | ----------------------------------------- |
| Tokyo Dome                  | Hoshimachi Suisei's YouTube channel       |
| `tokyodome.co.jp`           | `https://youtube.com/@hoshimachisuisei`   |
| Ticket link for a show      | Specific stream URL (`/watch?v=...`)      |
| "Concert hall" (generic)    | "YouTube" (generic platform name)         |

The first row in each pair is the **venue identity**. The second is the **venue URL**. The third is an event-specific destination that belongs in `event_related_links`, not in the venue table. The fourth is generic platform-level text that should not, by itself, create a venue.

## Decisions

1. **Channel-URL granularity.** The venue identity for a virtual venue is the channel/profile URL, not the per-stream URL. Per-stream URLs belong in `event_related_links`.
2. **Auto-discovery requires `venue_url` when kind is `virtual`.** Without a URL, the resolver returns null. The event's extracted `venue_name` text is preserved on `normalized_events`; only `venue_id` is left unset.
3. **Auto-discovery for physical / unknown kinds is unchanged.** Name-only auto-discovery still applies, because physical venue names are usually identifying ("Tokyo Dome" is not a generic class label the way "YouTube" is).
4. **Tolerate stream URLs as venue URLs in the short term.** If the LLM only surfaces a stream URL with no channel URL available, accept the stream URL as the venue URL for now. This is a known imperfection — see Open Questions.
5. **No data migration.** The local database will be rebuilt from scratch as part of rollout. All existing rows in `venues`, `venue_aliases`, `normalized_events`, etc. are dropped. The first ingestion cycle after rollout populates everything fresh under the new resolver behavior.

## Resolver Behavior Changes

The resolution order stays the same: URL → exact alias → exact name → auto-discover → null. The change is in the auto-discover step.

```
async resolve(input):
    venueUrl = normalize(input.venueUrl)
    venueName = normalize(input.venueName)

    if venueUrl: try URL match → return if found
    if venueName: try alias match → return if found
    if venueName: try name match → return if found
    if venueName is on the ignored list: return null

    inferredKind = inferVenueKind(venueName, venueUrl)

    # NEW: require URL for virtual auto-discovery.
    if inferredKind == "virtual" and not venueUrl:
        return null

    return discoverVenue(...)
```

`inferVenueKind` is unchanged. The new branch fires only when the resolver would otherwise create a virtual venue keyed on a generic platform name.

## LLM Prompt Rule

Add one rule to the venue-extraction guidance in `NormalizationStrategy`:

> For virtual platforms (YouTube, Twitch, NicoNico, Streaming+, Z-aN, etc.):
> - Prefer the channel or profile URL as `venue_url` (e.g., `https://youtube.com/@channel_name`).
> - Put the specific stream URL (e.g., `https://youtube.com/watch?v=...`) into `related_links` instead.
> - If only a stream URL is available and no channel URL can be inferred, you may use the stream URL as `venue_url` — but never use a bare platform name like "YouTube" as `venue_name` without an accompanying URL.

If the LLM call fails, the raw item is marked as `error` and no normalized event or venue resolution is attempted. If the LLM succeeds but leaves `venue_url` unset, the resolver rule means no generic virtual venue gets auto-created.

## Rollout

The local SQLite database will be deleted before this lands. After the new code is in place, the next ingestion cycle re-fetches and re-normalizes from the connector under the new rules, producing channel-level virtual venues directly. No migration script is written.

Operationally:

1. Stop any running daemon.
2. Delete `data/oshikatsu.db` (and the WAL/SHM siblings if present).
3. Run `npm run db:migrate` to recreate the schema.
4. Re-add artists and watch targets via the TUI.
5. Restart the daemon.

Note that this also drops `raw_items` and `normalized_events`, so historical tweets that have scrolled out of the X timeline view will not be recoverable. This is an accepted trade-off.

## Testing

Add focused resolver tests:

- Resolver returns null for `venue_name = "YouTube"`, `venue_url` unset.
- Resolver auto-discovers a new venue for `venue_name = "YouTube"`, `venue_url = "https://youtube.com/@channel_a"`.
- Resolver returns the existing venue when the same channel URL is seen again.
- Resolver returns a *different* venue when a different channel URL on the same platform is seen.
- Resolver returns the same venue when the same channel URL is seen with a different `venue_name` (and adds the new name as an alias).
- Physical venue auto-discovery without URL still works (regression guard).

## Open Questions

1. **Stream-URL venue policy.** When the LLM provides a stream URL but no channel URL, we accept the stream URL as `venue_url` (Decision 4). Over time this creates per-stream venue rows that should arguably be merged under their channel. Options for follow-up: (a) curated merge during venue review, (b) LLM-assisted post-pass to extract channel URL from a stream URL, (c) a small URL canonicalizer that maps known stream-URL patterns to channel-URL patterns when possible. Tracked under TECH_DEBTS Phase 2.1.

2. **Should `inferVenueKind` get smarter about distinguishing channel URLs from stream URLs?** Not required for this design — `kind = "virtual"` is already correct for both. Worth revisiting only if a future feature needs the distinction.

## Tech Debts to Record

After implementation, update `TECH_DEBTS.md` under Phase 2.1:

- Stream-URL venue policy creates per-stream venue rows that may later need merging under channel-level venues (open question 1).
- No URL canonicalization across YouTube URL forms (`youtu.be/x`, `youtube.com/watch?v=x`, `youtube.com/@channel`, `youtube.com/channel/UCxxxx`); same channel referenced via different URL forms creates separate venues.

## Cross-References

- `design_docs/2026-04-25-venue-database/venue-database.md` — base Phase 2.1 design; the Current Status section should be updated to mention this refinement once landed.
- `src/core/VenueResolver.ts` — implementation target.
- `src/core/NormalizationStrategy.ts` — LLM prompt target.
- `TECH_DEBTS.md` — debt entries to add post-implementation.
