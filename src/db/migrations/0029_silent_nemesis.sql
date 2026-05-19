ALTER TABLE `extracted_events` ADD `series_name` text;--> statement-breakpoint
ALTER TABLE `normalized_events` ADD `series_name` text;--> statement-breakpoint
CREATE INDEX `idx_normalized_events_series` ON `normalized_events` (`artist_id`,`series_name`);