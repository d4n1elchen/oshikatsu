DROP INDEX `idx_extracted_events_raw_item`;--> statement-breakpoint
CREATE INDEX `idx_extracted_events_raw_item` ON `extracted_events` (`raw_item_id`);