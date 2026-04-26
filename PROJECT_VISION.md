# Project Vision: oshikatsu

## 1. Project Overview

`oshikatsu` is a platform for tracking new updates about favorite artists and converting them into a unified, analyzable data format.

## 2. Target Focus

- Focus on artists, singers, Vtubers, idols, voice actors, and other fan-favorite personalities.
- Track content such as event announcements, merchandise news, concerts and live shows, live stream alerts, song releases, and broadcast/program updates.

## 3. Core Objectives

- **Multi-source data ingestion**: Build a flexible system that can gather updates from one or more content sources.
- **Source-aware event resolution**: Identify the same event across different sources, merge related information into a single canonical record without duplication, and link sub-events (merch booths, pre-show talks, livestreams of a concert) to their main event.
- **Unified data format**: Normalize collected records so downstream analysis and integrations can consume them consistently.
- **Downstream pipeline integration**: Output standardized data to downstream pipelines for automation, such as calendar updates or notification dispatch.
- **Incremental growth**: Start with a single source today and expand to additional sources over time.

## 4. Current Data Source

- Twitter / X is currently the only implemented source, serving as the first entry point for data collection.

## 5. Success Criteria

- **Coverage**: Able to ingest new items from supported sources reliably.
- **Consistency**: Data is transformed into a stable, unified schema.
- **Extensibility**: New sources can be added with minimal disruption.

## 6. Long-term Direction

- Evolve from single-source ingestion into a platform supporting multiple types of information feeds.
- Keep the focus on reusable data models and source-agnostic processing.
- Support downstream use cases such as event tracking, content aggregation, automatic calendar creation, and automated notification dispatch.
