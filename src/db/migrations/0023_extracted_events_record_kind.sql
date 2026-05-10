-- Fold "annotation" records (milestones, press coverage, recaps,
-- reminder reposts) into extracted_events so the resolver can read
-- them through the same table as events instead of crossing back into
-- raw_items. A new `record_kind` column discriminates: 'event' for
-- the existing 7-type taxonomy, 'annotation' for posts that point at
-- an existing event but aren't an event themselves. Annotation rows
-- reuse `parent_event_hint` for the linkage and leave `start_time`,
-- `end_time`, and `venue_*` null.
--
-- This supersedes the columns we briefly added to raw_items in
-- 0022 — `not_an_event_category` and `related_event_hint` — which
-- mixed structured event-resolution signal into the ingestion-side
-- table. raw_items.status='not_an_event' survives as a terminal
-- status for orphan posts (mood, fan_engagement, other) that don't
-- relate to any event.
ALTER TABLE `extracted_events` ADD `record_kind` text NOT NULL DEFAULT 'event';
CREATE INDEX `idx_extracted_events_record_kind` ON `extracted_events` (`record_kind`);

ALTER TABLE `raw_items` DROP COLUMN `not_an_event_category`;
ALTER TABLE `raw_items` DROP COLUMN `related_event_hint`;
