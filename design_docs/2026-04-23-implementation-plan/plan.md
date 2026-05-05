# Implementation Plan: Oshikatsu

> **Status:** Active roadmap. Phases 1, 2, 2.1, 3 (resolution + hierarchy), 4 (Monitoring & Observability), and 5 (Downstream Export Protocol) have landed. Phase 6 (Multi-Source Support) is the next target.
> **Follow-ups:** Future phases scoped inline as they're approached. Open work tracked in `TECH_DEBTS.md`.

## Overview

This plan outlines the phased implementation of the Oshikatsu platform, starting from a single working source (Twitter/X) and incrementally adding features. Each phase delivers a working, testable product.

## Phase 1: Core Ingestion Pipeline

**Goal**: Ingest raw items from Twitter/X and store them with provenance.

**Deliverables**:

- Watch list for managing artists and their monitored sources
- Twitter/X source connector that fetches new items
- Raw storage layer that persists items with source provenance
- Basic scheduler to run ingestion periodically
- TUI for watch list management, ingestion monitoring, and data inspection

**Working product**: New tweets from configured Twitter/X sources are fetched, stored, and retrievable via TUI.

## Phase 2: Event Extraction Engine

**Goal**: Transform each raw source item into one source-derived extracted event candidate.

**Deliverables**:

- Twitter/X extraction strategy that maps raw items to the extracted event schema
- Field extraction logic (title, description, start_time, end_time, venue, artist, type, tags)
- Storage layer updated to persist extracted event records
- TUI for browsing and inspecting extracted events

**Working product**: Raw Twitter/X items are automatically extracted into extracted event candidates, viewable via TUI. These are not canonical events until Phase 3 event resolution runs.

## Phase 2.1: Venue Database

**Goal**: Add canonical venue records and conservative venue resolution before event resolution.

**Deliverables**:

- Venue database for physical and virtual venues
- Venue alias table for alternate names/spellings
- Nullable `venue_id` reference on extracted events
- Conservative exact URL / exact alias venue resolver
- TUI visibility for extracted venue and matched canonical venue

**Working product**: Extracted events can be linked to canonical venues when exact venue resolution is possible, while preserving extracted `venue_name` and `venue_url`.

## Phase 3: Event Resolution

**Goal**: Resolve extracted event candidates into canonical normalized events. The Event Resolution Engine handles three intertwined responsibilities — identity (new vs. existing), record consolidation (merge / dedup), and hierarchy (sub-event linking) — and is delivered in two stages.

### Phase 3.0: Identity & Merge

**Deliverables**:

- Identity resolution that decides whether each extracted event matches an existing canonical event or is new
- Record consolidation logic that merges duplicate or overlapping extracted events into a single canonical normalized event while preserving links to source extracted events
- Update mechanism for rescheduled/cancelled events
- Resolution decision log (`event_resolution_decisions`) capturing matched signals and rationale
- TUI for viewing resolution status and source provenance

**Working product**: Duplicate extracted events from the same or different sources are automatically merged into canonical normalized events; event updates are reflected correctly. `event_scope` and `parent_event_hint` are carried into the resolution log as evidence but not yet acted on.

### Phase 3.1: Hierarchy Resolution

**Goal**: Extend the Event Resolution Engine to detect and persist parent/sub-event relationships.

**Motivation**: Real-world activities often consist of a main event (e.g., a concert) plus related sub-activities (merch booth, pre-show talk, post-show meet & greet, livestream of the same concert). After Phase 3.0 these surface as independent canonical events; Phase 3.1 links them together.

**Deliverables**:

- Schema additions to `normalized_events`:
  - `parent_event_id` (nullable FK to `normalized_events`) — set on sub-events.
  - One-level-deep constraint: a sub-event cannot itself have sub-events.
- Hierarchy resolution rules using source-derived `event_scope` and `parent_event_hint` plus conservative signals (shared artist, close time, venue/link overlap), explicitly separate from merge signals.
- New `linked_as_sub` resolution decision outcome.
- Manual override in the TUI to attach/detach a sub-event from a parent.
- TUI Event detail view shows parent context for a sub-event and a sub-event list for a main event.
- Query helpers so downstream consumers can fetch a main event with its sub-events in a single call.

**Working product**: Related events are grouped under a canonical main event, viewable as a parent-with-children unit in the TUI, and Phase 4 export can choose to emit the bundle or the individual records.

**Open questions** (resolved or revised in `design_docs/2026-04-25-phase3-event-resolution/event-resolution.md`):

- Should hierarchy resolution run in the same pass as identity/merge, or as a follow-up sweep over recently created canonical events?
- How should sub-events inherit (or override) the parent's venue, tags, and cancellation status?
- Resolution decisions for both merge and hierarchy share the `event_resolution_decisions` log; no separate hierarchy log is planned.

## Phase 4: Monitoring & Observability

**Goal**: Provide visibility into pipeline health so failures don't accumulate silently. Substrate for the later alerting and automated-recovery deliverables.

**Motivation**: Phases 1–3 already produce typed error signals (`LoginWallError`, `AntiBotError`, `TimelineShapeError`, `TwitterFetchError`) and propagate persistent-storage failures, but they only land in logs. With three concurrent loops and Phase 5 (Downstream Export) about to consume the data, "is the daemon healthy?" needs an answer that doesn't require tailing logs.

**Deliverables**:

- `scheduler_runs` table capturing per-cycle metadata (run_id, task_name, started_at, finished_at, status, error_class, error_message, details JSON).
- Scheduler instrumentation: every tick records a row; AbortError → `status='aborted'`, typed errors → `status='failed'` with `error_class` from `error.name`, success → `status='completed'`.
- Optional task-returned details payload (e.g., per-target item counts from ingestion, processed/failed counts from extraction and resolution) merged into `details`.
- Per-target last-success / last-failure tracking, surfacing the data the eventual "mark target unhealthy" judgment will use.
- TUI Monitor tab rendering recent runs per task, color-coded status, last-success timestamp per task, and error rate over a recent window.
- A small structured summary log line at the end of each tick so operators tailing logs see the same data as the TUI.

**Working product**: The operator can answer "is the daemon healthy?" and "did task X fail recently?" via the TUI, without log archaeology. Phase 5 export work writes its own runs through the same scheduler instrumentation for free. Storage-failure escalation (currently a silent log line) becomes a visible per-target failure counter.

**Out of scope** (deferred to a later "platform expansion" phase):

- Alert dispatch (email, webhook, Slack).
- Automated recovery / auto-disable of unhealthy targets.
- Health-check CLI command for external monitoring.
- External monitoring integrations (Prometheus, OpenTelemetry, etc.).

## Phase 5: Downstream Export Protocol

**Goal**: Build a generic export protocol so downstream consumers (calendar, notification, webhook, etc.) can be added one at a time without touching the core. No specific consumer is built in this phase — only the substrate.

**Deliverables**:

- `Consumer` interface defining `deliver(batch)` with partial-success / retry semantics.
- `ExportRunner` registered as a `ScheduledTask` so the existing Phase 4 Monitor view shows export health for free.
- `export_queue` table populated by `EventResolver` whenever a normalized event is created / updated / cancelled.
- `export_cursors` table tracking per-consumer delivery position.
- Queue compaction so a lagging consumer sees the latest state per event, not the full edit history.
- Defined contracts for sub-events (delivered as independent records with `parentId`), updates (`changeType="updated"` with bumped `version`), and cancellations (`changeType="cancelled"`, never deletes).
- `NoopConsumer` reference implementation used in tests.

**Working product**: Adding a new downstream sink is a self-contained follow-up — implement `Consumer`, register in `daemon.ts`, done. Until a real consumer is registered, the runner is a no-op. Design: `design_docs/2026-05-04-phase5-downstream-export/`.

**Out of scope** (each becomes its own follow-up):

- Specific consumer implementations (iCal file, Google Calendar, Discord/Slack webhook, email, push).
- Web/HTTP pull API (Phase 8).
- Consumer-failure alerting (Phase 7, builds on the same `scheduler_runs` substrate).

## Phase 6: Multi-Source Support

**Goal**: Add support for a second data source.

**Deliverables**:

- Second source connector implementation (e.g., Instagram, YouTube)
- Cross-source resolution validation (identity matching, merge correctness, sub-event linking)

**Working product**: Events from two sources are ingested, resolved (deduplicated and hierarchically linked), and exported correctly.

## Phase 7: Platform Expansion

**Goal**: Build alerting, automated recovery, and additional integrations on top of the Phase 4 monitoring substrate.

**Deliverables**:

- Alert dispatch on persistent failures (configurable channel: webhook, email, etc.).
- Automated unhealthy-target handling (auto-disable after N consecutive failures, operator notification).
- Health-check CLI command for external monitoring.
- Additional source connectors as needed.
- Additional downstream export targets.

**Working product**: Platform supports multiple sources and downstream integrations with reliable operation; persistent failures generate alerts rather than silent log lines.

## Phase 8: Web UI

**Goal**: Provide a web-based interface for managing and visualizing the platform.

**Deliverables**:

- Web UI for watch list management (artists, sources, toggles)
- Artist and venue database management
- Event dashboard with timeline/list view and filtering
- Calendar view with export to iCal/Google Calendar
- Ingestion monitoring dashboard

**Working product**: All platform management and monitoring tasks can be performed through a web browser, replacing the TUI for daily use.
