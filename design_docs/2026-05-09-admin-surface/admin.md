# Phase 6.1: Admin Surface

> **Status:** Proposed.
> **Follow-ups:** Builds on the Phase 6 dashboard (`design_docs/2026-05-08-phase6-web-ui/web-ui.md`) and the read/query layer (`design_docs/2026-05-08-read-query-layer/query-layer.md`). Operator-action endpoints (POST routes) are new substrate; per-field override masks for normalized-event edits are deliberately deferred per the open question below.

## Overview

A single-page admin dashboard for operators, separate route from the fan dashboard, sharing the same shell (sidebar, header, dark theme) but with operator-flavored content. Combines monitoring, review queue, and normalized-event editing onto one page so the operator gets a glanceable "is everything OK and what needs me?" view without tab-switching.

The fan dashboard answers "what's happening with my oshis?". The admin dashboard answers "is the pipeline healthy and is anything waiting on me?". Same pattern (dense, polling, modal-for-detail), different concerns.

This doc replaces the Phase 6 design doc's "no write surface in v1" Non-Goal. The fan dashboard remains read-only; admin is where writes live.

## Problem

The TUI today provides Monitor and ReviewQueue views and a `WatchListManager`-driven WatchList. There is no surface — TUI or otherwise — for editing canonical normalized events. Operators currently:

- Watch the pipeline through Monitor (TUI only).
- Triage `needs_review` decisions through ReviewQueue (TUI only).
- Cannot fix wrong canonical events at all without raw SQL against `normalized_events`.

Three gaps, with different urgency:

- **Monitor in browser**: cosmetic, but the fan dashboard's running web server makes a parallel admin page free relative to building one from scratch.
- **Review queue in browser**: same shape as monitor — read already supported by `listReviewQueue`, write actions already exist on `EventResolver`. Mostly plumbing.
- **Editing normalized events**: real design question, not just plumbing. `normalized_events` is the *output* of resolution. If an operator edits a row and a later resolver pass writes to it (new source merged, reschedule detected), what happens?

## Goals

- A single admin page at `/admin` that lays out pipeline health, review queue, canonical events, and extraction failures on one scroll surface.
- Read-side queries are reuses or thin wrappers over the existing query layer — no duplicated drizzle code.
- Operator actions exposed as POST routes that thinly wrap existing core methods (`EventResolver.acceptAsMerge`, `EventResolver.acceptAsNew`, plus new `updateNormalizedEvent`).
- Editing a normalized event has well-defined interaction with the resolver — operator intent is not silently lost on the next tick.

## Non-Goals

- **Auth, multi-tenant, RBAC.** Single-tenant deployment; the admin page is gated by URL knowledge plus whatever the operator puts in front of the host (reverse proxy auth, VPN, localhost-only). Auth design is a separate phase.
- **Venue curation UI.** Tracked in `TECH_DEBTS.md`. Belongs on this admin page eventually but is not in scope for the first cut — venue resolution is conservative enough today that the discovered/verified/ignored states aren't actively painful.
- **Watch list management UI.** TUI's WatchList view already covers this and won't be retired by Phase 6.1. Adding it to admin is a follow-up.
- **Audit log UI.** A `event_edits` audit table is mentioned below as a follow-up but not built in v1; SQL is enough until it isn't.
- **Per-field override masks** (see open question). v1 uses row-level freeze; per-field is the natural refinement when row-level proves too coarse.
- **Bulk operations.** Edit one event at a time. Bulk re-extract / bulk re-resolve / bulk delete aren't shaped here.

## Design

### Layout

```
┌──────────┬───────────────────────┬──────────┐
│ Sidebar  │ Header (admin)        │ Recent   │
│          ├───────────────────────┤ runs     │
│ ● Dash   │ Pipeline health       │ rail     │
│ ● Admin  │ ┌─────┬─────┬─────┐   │          │
│          │ │ Ing │ Ext │ Res │   │ ● run    │
│          │ │  ✓  │  ✓  │  ⚠  │   │ ● run    │
│          │ └─────┴─────┴─────┘   │ ● run    │
│          ├───────────────────────┤  …       │
│          │ Review queue · 7      │          │
│          │ ┌──────────────────┐  │          │
│          │ │ candidate · [m] [n]│ │          │
│          │ └──────────────────┘  │          │
│          ├───────────────────────┤          │
│          │ Canonical events      │          │
│          │ (search + table)      │          │
│          ├───────────────────────┤          │
│          │ Extraction failures   │          │
│          │ (grouped errors)      │          │
└──────────┴───────────────────────┴──────────┘
```

Three columns, like the fan dashboard. Sidebar carries the Dashboard / Admin toggle (the only top-level surfaces in this phase). Right rail is a continuous live feed of recent scheduler runs — the operator equivalent of "timeline." Main column stacks the four panels in priority order: health, then queue (actionable inbox), then events (browse + edit), then failures (only matters when broken).

### Panels

#### Pipeline health

Three cards, one per task (Ingestion, Extraction, Resolution; Export when enabled). Each card shows: last-run status, time since last success, time since last failure, success/fail counts in the last hour. Color: green (last completed), yellow (recent failures within otherwise-healthy window), red (last failed), gray (idle or never run).

Source: `SchedulerRunsRepo.recent(50)` + `countsSince(now - 1h)`. Same shape the TUI Monitor view computes today.

The hardcoded `["Ingestion", "Extraction", "Resolution"]` list in [Monitor.tsx](src/tui/views/Monitor.tsx) becomes a `SELECT DISTINCT task_name FROM scheduler_runs` once the admin page exists, since the TUI gap and the web gap are now the same problem. Tracked in `TECH_DEBTS.md`.

#### Review queue

Reuses `listReviewQueue` directly. Each row: candidate title, score, reason, with two action buttons:

- **Merge** → `POST /api/admin/review/:decisionId/merge` (calls `EventResolver.acceptAsMerge`).
- **New** → `POST /api/admin/review/:decisionId/new` (calls `EventResolver.acceptAsNew`).

Click row → expands inline (or opens modal) to show full candidate + matched + signals + raw content, mirroring the TUI ReviewQueue's expanded view.

Empty state: "Resolver is happy." (Same as the TUI.)

#### Canonical events (with edit)

Searchable, paginated list of `normalized_events`. Same query as the fan dashboard's event feed, ordered by `updated_at desc`. Each row clickable → opens an **edit modal** (not the read-only modal from the fan dashboard).

Edit modal exposes:

- `title`, `description`, `start_time`, `end_time`, `is_cancelled`, `tags`, `parent_event_id`, `venue_id`
- A "save" button that POSTs to `/api/admin/events/:id`, calling a new `updateNormalizedEvent(id, fields)` core method
- A visible "operator-owned" indicator if the row was edited (see override semantics below)
- A "release back to resolver" button to clear the operator-owned flag

#### Extraction failures

Reuses `getExtractionFailureSummary`. Same group-by view the TUI Monitor has, here as a collapsed-by-default section that expands when `total > 0`.

#### Recent runs rail

Right column. List of last ~50 scheduler runs, newest first, color-coded by status. Click → opens a small modal showing the run's details JSON, error class, error message. Source: `SchedulerRunsRepo.recent(50)`.

### Override semantics for normalized-event edits

**The question:** when an operator edits a `normalized_events` row, and a later resolver tick wants to write to it (e.g. a new source merges, a reschedule arrives), what happens?

**Three options considered:**

1. **Optimistic clobber.** Resolver always writes; operator changes silently disappear. Trivial to implement, terrible UX. Rejected.
2. **Per-field override mask.** Each row has a `operator_overrides: string[]` JSON column listing field names that are operator-pinned; resolver writes only unset fields. Most flexible, most complex (every resolver write path needs to consult the mask). Rejected for v1, deferred as the natural refinement.
3. **Row-level freeze with explicit release.** First operator edit sets `operator_owned = true` on the row. Resolver checks this flag before any UPDATE and skips frozen rows entirely. Operator can click "release back to resolver" in the edit modal to clear the flag.

**v1 choice: row-level freeze.**

Rationale:

- Simpler implementation: one boolean check at every resolver update site.
- Visible state: the modal shows "operator-owned since 2026-05-09" so operators see what's frozen.
- Releasable: operators aren't trapped — they can hand the row back.
- Coarseness is acceptable for early use. If "I fixed the title but now the venue moved and I have to manually re-fix the venue" becomes a real complaint, that's the signal to add the per-field mask.

**Schema additions to `normalized_events`:**

```ts
operatorOwned: integer("operator_owned", { mode: "boolean" }).notNull().default(false),
operatorEditedAt: integer("operator_edited_at", { mode: "timestamp" }),
```

Migration: `0019_normalized_events_operator_ownership.sql`.

**Resolver changes:**

`EventResolver.processBatch` and any other UPDATE-issuing code paths add a `WHERE NOT operator_owned` filter (or skip-row check). Existing operator-untouched rows behave identically. No backfill needed.

**Audit log:** deferred. An `event_edits` table capturing field-level diffs would be useful for compliance/debugging but is overkill at v1. SQL `git blame`-equivalent is "just look at `operator_edited_at`."

### API surface

```
GET  /api/admin/dashboard        // composed bundle: health + review + events + failures + runs
POST /api/admin/review/:id/merge
POST /api/admin/review/:id/new
PATCH /api/admin/events/:id      // updateNormalizedEvent
POST  /api/admin/events/:id/release  // clear operator_owned
```

The composed `/dashboard` endpoint mirrors the fan dashboard's pattern — one round-trip for first paint. Mutations are individual routes.

### Auth

None in v1 per Non-Goals. Operators run the web server behind a reverse proxy or on localhost. The admin route is at `/admin` rather than buried in obscurity — the goal is "no auth complexity," not "security through obscurity," and operators are expected to know to gate the deployment themselves.

A follow-up phase will add auth (probably basic HTTP auth via the reverse proxy at first, then a real session model).

### Polling

Same as fan dashboard: 30s interval. Mutations re-fetch on success so the UI reflects the post-write state immediately.

## Implementation order

1. **Admin sidebar + routing.** Add the Dashboard/Admin toggle to the existing sidebar. Render an empty `/admin` shell. Smallest, validates routing pattern.
2. **Pipeline health panel.** Read-only. New `AdminMonitorQueries.ts` exposing the cards-shape (or just call `SchedulerRunsRepo.recent` + `countsSince` from a route handler — cleaner since these are already the right shape).
3. **Recent runs rail.** Read-only. Same source.
4. **Extraction failures panel.** Reuses `getExtractionFailureSummary` directly.
5. **Review queue panel + actions.** Read reuses `listReviewQueue`. Two POST routes wrapping `EventResolver` methods. Mirrors TUI behavior 1:1.
6. **Schema migration for `operator_owned` / `operator_edited_at`.** Resolver gains the skip-frozen check at every UPDATE site. Tests for the freeze behavior.
7. **Canonical events panel + edit modal.** New `updateNormalizedEvent` core method, new PATCH route, modal UI. Largest single step; deliberately last.
8. **`Monitor.tsx` task-name list de-hardcoding.** Once the admin page also keys on task names, the change becomes obviously worth doing for both surfaces.

Each step is independently shippable; the admin page is functional after every step, with fewer panels.

## Open questions

- **Per-field override mask vs. row-level freeze.** Picked row-level for v1; will revisit if "I had to re-edit the venue" complaints arrive.
- **Edit history UI.** Deferred to a `event_edits` audit table when there's actual demand.
- **Bulk operations.** Probably comes up as soon as someone has 50 events to mass-cancel for a postponed tour. Not designed yet.
- **Venue curation surface.** Belongs here eventually. Schema (discovered/verified/ignored) already supports it; UX is the only missing piece. Tracked in `TECH_DEBTS.md`.
