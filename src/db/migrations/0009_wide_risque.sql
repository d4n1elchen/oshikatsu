ALTER TABLE `preprocessed_event_related_links` RENAME TO `extracted_event_related_links`;--> statement-breakpoint
ALTER TABLE `preprocessed_events` RENAME TO `extracted_events`;--> statement-breakpoint
ALTER TABLE `extracted_event_related_links` RENAME COLUMN "preprocessed_event_id" TO "extracted_event_id";--> statement-breakpoint
ALTER TABLE `source_references` RENAME COLUMN "preprocessed_event_id" TO "extracted_event_id";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_extracted_event_related_links` (
	`id` text PRIMARY KEY NOT NULL,
	`extracted_event_id` text NOT NULL,
	`raw_item_id` text,
	`url` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extracted_event_id`) REFERENCES `extracted_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_extracted_event_related_links`("id", "extracted_event_id", "raw_item_id", "url", "title", "created_at") SELECT "id", "extracted_event_id", "raw_item_id", "url", "title", "created_at" FROM `extracted_event_related_links`;--> statement-breakpoint
DROP TABLE `extracted_event_related_links`;--> statement-breakpoint
ALTER TABLE `__new_extracted_event_related_links` RENAME TO `extracted_event_related_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extracted_event_related_link_dedup` ON `extracted_event_related_links` (`extracted_event_id`,`url`);--> statement-breakpoint
CREATE TABLE `__new_extracted_events` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`start_time` integer,
	`end_time` integer,
	`venue_id` text,
	`venue_name` text,
	`venue_url` text,
	`type` text NOT NULL,
	`is_cancelled` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_extracted_events`("id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at") SELECT "id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at" FROM `extracted_events`;--> statement-breakpoint
DROP TABLE `extracted_events`;--> statement-breakpoint
ALTER TABLE `__new_extracted_events` RENAME TO `extracted_events`;--> statement-breakpoint
CREATE INDEX `idx_extracted_events_artist_start_time` ON `extracted_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_extracted_events_start_time` ON `extracted_events` (`start_time`);--> statement-breakpoint
CREATE TABLE `__new_source_references` (
	`id` text PRIMARY KEY NOT NULL,
	`extracted_event_id` text NOT NULL,
	`raw_item_id` text NOT NULL,
	`source_name` text NOT NULL,
	`source_id` text NOT NULL,
	`publish_time` integer NOT NULL,
	`url` text NOT NULL,
	`author` text NOT NULL,
	`venue_name` text,
	`venue_url` text,
	`raw_content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extracted_event_id`) REFERENCES `extracted_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_source_references`("id", "extracted_event_id", "raw_item_id", "source_name", "source_id", "publish_time", "url", "author", "venue_name", "venue_url", "raw_content", "created_at") SELECT "id", "extracted_event_id", "raw_item_id", "source_name", "source_id", "publish_time", "url", "author", "venue_name", "venue_url", "raw_content", "created_at" FROM `source_references`;--> statement-breakpoint
DROP TABLE `source_references`;--> statement-breakpoint
ALTER TABLE `__new_source_references` RENAME TO `source_references`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
