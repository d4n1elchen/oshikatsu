ALTER TABLE `event_related_links` RENAME TO `preprocessed_event_related_links`;--> statement-breakpoint
ALTER TABLE `normalized_events` RENAME TO `preprocessed_events`;--> statement-breakpoint
ALTER TABLE `preprocessed_event_related_links` RENAME COLUMN "event_id" TO "preprocessed_event_id";--> statement-breakpoint
ALTER TABLE `source_references` RENAME COLUMN "event_id" TO "preprocessed_event_id";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_preprocessed_event_related_links` (
	`id` text PRIMARY KEY NOT NULL,
	`preprocessed_event_id` text NOT NULL,
	`raw_item_id` text,
	`url` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`preprocessed_event_id`) REFERENCES `preprocessed_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_preprocessed_event_related_links`("id", "preprocessed_event_id", "raw_item_id", "url", "title", "created_at") SELECT "id", "preprocessed_event_id", "raw_item_id", "url", "title", "created_at" FROM `preprocessed_event_related_links`;--> statement-breakpoint
DROP TABLE `preprocessed_event_related_links`;--> statement-breakpoint
ALTER TABLE `__new_preprocessed_event_related_links` RENAME TO `preprocessed_event_related_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_preprocessed_event_related_link_dedup` ON `preprocessed_event_related_links` (`preprocessed_event_id`,`url`);--> statement-breakpoint
CREATE TABLE `__new_preprocessed_events` (
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
INSERT INTO `__new_preprocessed_events`("id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at") SELECT "id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at" FROM `preprocessed_events`;--> statement-breakpoint
DROP TABLE `preprocessed_events`;--> statement-breakpoint
ALTER TABLE `__new_preprocessed_events` RENAME TO `preprocessed_events`;--> statement-breakpoint
CREATE INDEX `idx_preprocessed_events_artist_start_time` ON `preprocessed_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_preprocessed_events_start_time` ON `preprocessed_events` (`start_time`);--> statement-breakpoint
CREATE TABLE `__new_source_references` (
	`id` text PRIMARY KEY NOT NULL,
	`preprocessed_event_id` text NOT NULL,
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
	FOREIGN KEY (`preprocessed_event_id`) REFERENCES `preprocessed_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_source_references`("id", "preprocessed_event_id", "raw_item_id", "source_name", "source_id", "publish_time", "url", "author", "venue_name", "venue_url", "raw_content", "created_at") SELECT "id", "preprocessed_event_id", "raw_item_id", "source_name", "source_id", "publish_time", "url", "author", "venue_name", "venue_url", "raw_content", "created_at" FROM `source_references`;--> statement-breakpoint
DROP TABLE `source_references`;--> statement-breakpoint
ALTER TABLE `__new_source_references` RENAME TO `source_references`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
