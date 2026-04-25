# Implementation Plan: Oshikatsu

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

## Phase 2: Normalization Engine

**Goal**: Transform raw source items into the unified internal event schema.

**Deliverables**:

- Twitter/X normalizer that maps raw items to the unified schema
- Field extraction logic (title, description, event_time, venue, artist, type, tags)
- Storage layer updated to persist normalized records
- TUI for browsing and inspecting normalized events

**Working product**: Raw Twitter/X items are automatically normalized into the unified event schema, viewable via TUI.

## Phase 2.1: Venue Database

**Goal**: Add canonical venue records and conservative venue resolution before merge/deduplication.

**Deliverables**:

- Venue database for physical and virtual venues
- Venue alias table for alternate names/spellings
- Nullable `venue_id` reference on normalized events
- Conservative exact URL / exact alias venue resolver
- TUI visibility for extracted venue and matched canonical venue

**Working product**: Normalized events can be linked to canonical venues when exact venue resolution is possible, while preserving extracted `venue_name` and `venue_url`.

## Phase 3: Merge/Deduplication

**Goal**: Consolidate multiple source items referring to the same event.

**Deliverables**:

- Deduplication logic that identifies duplicate events
- Merge strategy that combines source entries into a single record
- Update mechanism for rescheduled/cancelled events
- TUI for viewing merge/dedup status and source provenance

**Working product**: Duplicate events from the same or different sources are automatically merged; event updates are reflected correctly.

## Phase 3.1: Event Hierarchy

**Goal**: Model main/sub-event relationships on top of canonical events produced by Phase 3.

**Motivation**: Real-world activities often consist of a main event (e.g., a concert) plus related sub-activities (merch booth, pre-show talk, post-show meet & greet, livestream of the same concert). Today these surface as independent normalized events, which fragments the timeline and downstream calendar/notification output.

**Deliverables**:

- Schema additions to `normalized_events`:
  - `parent_event_id` (nullable FK to `normalized_events`) — set on sub-events.
  - One-level-deep constraint: a sub-event cannot itself have sub-events.
- Conservative rules for promoting a normalized event to a sub-event of an existing canonical event (e.g., shared artist + close time + explicit reference in source text), explicitly separate from Phase 3 dedup signals.
- Manual override in the TUI to attach/detach a sub-event from a parent.
- TUI Event detail view shows parent context for a sub-event and a sub-event list for a main event.
- Query helpers so downstream consumers can fetch a main event with its sub-events in a single call.

**Working product**: Related events can be grouped under a canonical main event, viewable as a parent-with-children unit in the TUI, and Phase 4 export can choose to emit the bundle or the individual records.

**Open questions** (to resolve in a dedicated design doc before implementation):

- Should hierarchy assignment run automatically as part of the dedup pass, or only via manual/TUI action initially?
- How should sub-events inherit (or override) the parent's venue, tags, and cancellation status?
- Do we need `event_hierarchy_decisions` analogous to `event_merge_decisions` for auditability?

## Phase 4: Downstream Export

**Goal**: Expose normalized events to downstream consumers.

**Deliverables**:

- Export interface for calendar integration
- Export interface for notification dispatch
- Configurable export triggers (on new event, on update)
- TUI for managing export configuration and viewing export status

**Working product**: Normalized events are exported to a calendar and/or notification system.

## Phase 5: Multi-Source Support

**Goal**: Add support for a second data source.

**Deliverables**:

- Second source connector implementation (e.g., Instagram, YouTube)
- Cross-source deduplication validation

**Working product**: Events from two sources are ingested, normalized, merged, and exported correctly.

## Phase 6: Platform Expansion

**Goal**: Add additional sources and downstream integrations.

**Deliverables**:

- Additional source connectors as needed
- Additional downstream export targets
- Monitoring and alerting for ingestion failures

**Working product**: Platform supports multiple sources and multiple downstream integrations with reliable operation.

## Phase 7: Web UI

**Goal**: Provide a web-based interface for managing and visualizing the platform.

**Deliverables**:

- Web UI for watch list management (artists, sources, toggles)
- Artist and venue database management
- Event dashboard with timeline/list view and filtering
- Calendar view with export to iCal/Google Calendar
- Ingestion monitoring dashboard

**Working product**: All platform management and monitoring tasks can be performed through a web browser, replacing the TUI for daily use.
