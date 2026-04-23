# Implementation Plan: Oshikatsu

## Overview

This plan outlines the phased implementation of the Oshikatsu platform, starting from a single working source (Twitter/X) and incrementally adding features. Each phase delivers a working, testable product.

## Phase 1: Core Ingestion Pipeline

**Goal**: Ingest raw items from Twitter/X and store them with provenance.

**Deliverables**:

- Twitter/X source connector that fetches new items
- Raw storage layer that persists items with source provenance
- Basic scheduler to run ingestion periodically

**Working product**: New tweets from configured Twitter/X sources are fetched, stored, and retrievable.

## Phase 2: Normalization Engine

**Goal**: Transform raw source items into the unified internal event schema.

**Deliverables**:

- Twitter/X normalizer that maps raw items to the unified schema
- Field extraction logic (title, description, event_time, venue, artist, type, tags)
- Storage layer updated to persist normalized records

**Working product**: Raw Twitter/X items are automatically normalized into the unified event schema and stored.

## Phase 3: Merge/Deduplication

**Goal**: Consolidate multiple source items referring to the same event.

**Deliverables**:

- Deduplication logic that identifies duplicate events
- Merge strategy that combines source entries into a single record
- Update mechanism for rescheduled/cancelled events

**Working product**: Duplicate events from the same or different sources are automatically merged; event updates are reflected correctly.

## Phase 4: Downstream Export

**Goal**: Expose normalized events to downstream consumers.

**Deliverables**:

- Export interface for calendar integration
- Export interface for notification dispatch
- Configurable export triggers (on new event, on update)

**Working product**: Normalized events are exported to a calendar and/or notification system.

## Phase 5: Multi-Source Support

**Goal**: Add support for a second data source.

**Deliverables**:

- Abstract source connector interface
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
