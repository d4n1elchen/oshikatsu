DROP TABLE `source_references`;--> statement-breakpoint
ALTER TABLE `extracted_events` ADD `publish_time` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `extracted_events` ADD `author` text NOT NULL;--> statement-breakpoint
ALTER TABLE `extracted_events` ADD `source_url` text NOT NULL;--> statement-breakpoint
ALTER TABLE `extracted_events` ADD `raw_content` text NOT NULL;