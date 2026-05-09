# Phase 6: Web UI

> **Status:** Proposed.
> **Follow-ups:** Pre-work tracked in `TECH_DEBTS.md` (read/query service layer, Monitor task-name list); Phase 6 follow-on surfaces tracked in `IDEAS.md` (fan-art carousel, hashtag tracking, hype index).

## Overview

Phase 6 adds a browser-based fan-facing interface on top of the operational pipeline (Phases 1–5). The deliverable is a single-page command-center dashboard: the user lands on it, sees what's happening with their oshis right now, and drills into individual events via a modal. There are no other top-level pages in v1 — additional surfaces (admin/curation, fan-art rails, per-artist deep pages) are explicit follow-ups.

The UI is read-only against the canonical data already in SQLite. No new ingestion, extraction, or resolution work; no schema changes; no per-user state. Everything on the dashboard is buildable from existing tables.

## Problem

The pipeline produces canonical events end-to-end, but the only way to consume them today is the TUI (developer-flavored) or the iCal export (calendar-flavored, asynchronous). Neither answers the "what's happening with my oshis right now?" question that motivates the project. A web dashboard is the smallest-scope surface that makes the pipeline useful to non-developer users.

A second motivation: opening up the surface forces a clean read/query layer. The current TUI reaches into `db` and drizzle operators directly from four of six views. Adding a web client without a service layer would duplicate that pattern across two clients — see `TECH_DEBTS.md` ("TUI directly uses DB access"). Phase 6 builds the layer once and migrates both clients to it.

## Goals

- A single-page dashboard that surfaces live streams, this week's events, the recent event feed, and a per-artist activity timeline.
- Sidebar acts as both oshi list and filter; selecting an oshi scopes every panel.
- Event detail surfaces as a modal, not a separate route, so navigation stays on the dashboard.
- Read/query service layer used by both TUI and web — no duplicated drizzle queries across clients.
- All data sourced from existing tables; no schema migrations required for v1.

## Non-Goals

- **No write surface in v1.** Watch-list edits, venue curation, review-queue triage stay in the TUI. Operator workflows are an explicit follow-up phase, not Phase 6.
- **No user accounts, auth, or per-user state.** The dashboard reflects the watch list as configured; "your oshis" means "the watched artists in this deployment." Single-tenant.
- **No push / live updates.** Polling on a sensible interval is enough for v1; WebSockets / SSE deferred until polling is demonstrably insufficient.
- **No mobile-first design.** Responsive collapse is required (right rail drops below center column on narrow screens), but the target is desktop "command center" usage.
- **No fan-art rail, hashtag tracking, hype-index ranking, embedded live playback inline-on-load.** All in `IDEAS.md`; each is additive once the dashboard ships.
- **No platform-confirmed live state.** "LIVE" badges are derived from scheduled `start_time`/`end_time` windows. Actual platform liveness detection is in `IDEAS.md`.
- **No Phase 7 (multi-source) dependency.** The UI is built against the current single-source (Twitter/X) data and will absorb additional sources transparently when Phase 7 lands.

## Design

### Layout

```
┌──────────┬───────────────────────┬──────────┐
│ Sidebar  │ Header                │ Timeline │
│          ├───────────────────────┤ feed     │
│ ● All    │ Next event countdown  │          │
│ ──────   ├───────────────────────┤ ● post   │
│ ● Oshi A │ Live & upcoming    →  │ ● post   │
│ ● Oshi B │ ┌──┐ ┌──┐ ┌──┐ ┌──┐  │ ● post   │
│ ○ Oshi C │ │..│ │..│ │..│ │..│  │ ● post   │
│ ○ Oshi D │ └──┘ └──┘ └──┘ └──┘  │ ● post   │
│          ├───────────────────────┤ ● post   │
│ + Add    │ This week strip       │ ● post   │
│          ├───────────────────────┤  …       │
│          │ Event feed            │          │
│          │ (flat, updated_at)    │          │
└──────────┴───────────────────────┴──────────┘
```

Three columns: sidebar (narrow), main (events), right rail (raw timeline). Sidebar selection filters every panel. Right rail collapses below the main column on narrow viewports.

### Panels

Each panel is independent and queries the read/query layer directly. No cross-panel state beyond the active artist filter.

#### Sidebar

- One row per watched artist + an "All" row (default).
- Row shows: activity dot (active/dim by recency), display name, last-activity timestamp.
- Last-activity = `MAX(raw_items.fetched_at)` for the artist's source targets. Raw, not event-bearing — answers "did they post?" not "did they post something we extracted as an event."
- "Active" threshold for the dot: posted within the last 24h. Cosmetic only; tune later.
- Click → updates URL param `?oshi=<handle>` and scopes every panel; "All" clears the param.

#### Next event countdown (hero)

- Single nearest upcoming event for the active filter: `MIN(start_time)` where `start_time >= now` and (active filter OR all watched artists).
- Shows: title, artist, time-until, venue. Click → modal.
- Empty state: "Nothing on the horizon."

#### Live & upcoming streams (horizontal rail)

- Card list, horizontal scroll (CSS `overflow-x: auto` + scroll-snap; no carousel library).
- Source: events whose venue is virtual.
- Ordering: ongoing first (LIVE badge), then upcoming by `start_time asc`.
- "Ongoing" = `start_time <= now <= end_time`, with a grace window of `start_time + 4h` when `end_time` is null.
- Card: thumbnail placeholder (platform icon for v1 — YouTube/Twitch poster fetching deferred), title, artist, badge (LIVE / "in 3h"). Click → modal.
- Empty state when nothing live or scheduled: "No streams scheduled."

#### This week strip

- Seven-day strip starting today, each day a column with events stacked under it.
- Events bucketed by `start_time` day in the deployment timezone.
- Click event → modal. Click day → filter event feed below to that day (URL param).

#### Event feed

- Flat list, ordered by `normalized_events.updated_at desc`.
- Cards show: title, artist, start_time, venue, source provenance ("3 posts · 2 accounts"), badges.
- Badges: `cancelled` from `is_cancelled`; `updated` (generic) when `updated_at - created_at > threshold`. No "rescheduled" badge in v1 — schema doesn't carry start_time history.
- Sub-events (rows where `parent_event_id IS NOT NULL`) display flat alongside parents but include an "↑ parent" affordance that opens the parent's modal directly.
- Pagination: cursor-based on `updated_at`. Infinite-scroll or "load more" button — pick one in implementation.
- Click card → modal.

#### Event modal

- Single modal component, opened by any event click anywhere on the page.
- URL param `?event=<id>` so it's shareable and back-button works.
- Content: full title, description, artist, venue (with link), start/end time, all related links, all source posts (raw_items linked via `normalized_event_sources`), parent event (if sub-event) or sub-events list (if parent).
- Sub-event "↑ parent" button inside modal swaps the modal contents to the parent — same component, different ID.

#### Timeline rail

- `raw_items` ordered by `fetched_at desc`, scoped to the active filter.
- Compact rows: avatar/handle, post excerpt (~80 chars), relative timestamp, link out to source.
- No filter toggles in v1 — raw firehose. `IDEAS.md` notes future content-type filters; ship without them and let usage reveal which toggles matter.
- Polls on the same interval as the rest of the page.

### Read/query service layer

Pre-work for the UI, also fixing `TECH_DEBTS.md` ("TUI directly uses DB access"). Migration covers the four TUI views currently importing `db` + drizzle operators (`Monitor`, `NormalizedEvents`, `ExtractedEvents`, `ReviewQueue`). `WatchList` and `RawItems` already go through core services and are left alone.

**Shape:**

- One module per surface, not one giant service: `EventsQueries.ts`, `ExtractedEventsQueries.ts`, `ReviewQueueQueries.ts`, `MonitorQueries.ts`, plus new ones for web panels (`DashboardQueries.ts`, `TimelineQueries.ts`).
- Plain async functions, not classes. They close over `db` from `src/db`. Existing repos (`SchedulerRunsRepo`, `ExportQueueRepo`) are class-based because they own writes; read-only services don't need that.
- View-shaped DTOs, not raw rows. Joins flattened, dates as ISO strings, counts attached. The HTTP layer is then `JSON.stringify(await listEvents(...))` with no reshape.
- Transport-agnostic. No `Request`/`Response`, no framework types. TUI calls in-process; web wraps in route handlers.
- Typed options object on every list query: `{ limit, cursor, artistId, ... }`. Cheap to add now, painful to retrofit.

**Tradeoff accepted:** view-shaped DTOs mean two views needing similar data either share one function with broader options or get two functions. Default to duplication; only generalize on the second real overlap. Premature shared shapes turn query layers into ORMs-on-top-of-ORMs.

### HTTP layer

The read/query layer is transport-agnostic, so the HTTP shape is mechanical. Concrete decisions deferred to implementation, but the outline:

- One process. The web server runs alongside the daemon (or as a sibling process sharing the SQLite file in WAL mode). No separate deployment unit.
- Routes mirror queries 1:1: `GET /api/dashboard?oshi=<handle>` returns the bundle the dashboard needs in one call; `GET /api/events?...` for paginated feed; `GET /api/events/:id` for modal; `GET /api/timeline?...` for rail.
- Polling interval: 30s baseline, tunable. No SSE/WebSocket in v1.
- Static frontend bundle served from the same process.

### Stack choice

Deferred to a follow-up commit on this design doc. Constraints to honor when picking:

- TypeScript end-to-end (matches existing codebase).
- Server-side render or SPA-with-SSR — not pure CSR. The dashboard's first paint should be useful.
- Minimal framework lock-in — this is a single-page app; pulling in a heavyweight framework for one page is overkill.
- Drizzle-compatible (no ORM swap).

Candidates to evaluate: Hono + a lightweight React/Solid SPA, Remix, SvelteKit, Astro with islands. Decision belongs in a separate stack-choice commit, not this doc.

## Data availability audit

Every panel maps to existing tables. No schema additions required for v1.

| Panel | Source | Notes |
|---|---|---|
| Sidebar | `artists` + `MAX(raw_items.fetched_at)` per artist | ✓ |
| Hero countdown | `normalized_events` `MIN(start_time) WHERE start_time >= now` | ✓ |
| Streams rail | `normalized_events` joined to virtual `venues` | venue type already in schema |
| LIVE badge | `start_time <= now <= end_time` window | scheduled, not platform-confirmed |
| Week strip | `normalized_events` bucketed by `start_time` day | ✓ |
| Event feed | `normalized_events` ordered by `updated_at` | ✓ |
| Cancelled badge | `normalized_events.is_cancelled` | ✓ |
| Sub-event "↑ parent" | `normalized_events.parent_event_id` | ✓ |
| Source provenance | `COUNT(normalized_event_sources)` | ✓ |
| Event modal | joins across normalized_events / sources / venues / related_links | ✓ |
| Timeline rail | `raw_items` ordered by `fetched_at desc` | ✓ |

**Visible compromises:**

- Stream cards use platform-icon placeholders, not YouTube/Twitch posters — no thumbnail in schema and OG fetching is a v2.
- No "rescheduled" badge — generic "updated" only.
- LIVE badge is scheduled-window, not platform-confirmed.

## Implementation order

1. **Read/query service layer + TUI migration.** No web work yet. Migrate the four drizzle-importing TUI views to the new modules. Ships value independent of Phase 6 (resolves a `TECH_DEBTS.md` item).
2. **HTTP layer + stack choice.** Pick stack, scaffold server, wire one route end-to-end (`/api/dashboard`).
3. **Dashboard panels, in this order:** sidebar → hero → event feed → week strip → streams rail → timeline rail → modal. Each is a standalone PR; the dashboard is functional after every step, just with fewer panels.
4. **Polish + responsive collapse.** Right rail drops below center on narrow viewports.

Each step is independently shippable. The first step has value even if Phases 6+ stall.

## Open questions

- **Stack choice.** Deferred to follow-up commit per above.
- **Timezone.** Display in deployment-local time, or browser-local? Probably browser-local (events are wall-clock anchored to the venue's locale, which we don't currently store separately from `start_time`). Worth confirming when implementing the week strip.
- **Polling cadence vs. perceived freshness.** 30s feels right for a command-center surface; revisit if it feels stale or hammers SQLite.
