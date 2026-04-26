PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_normalized_events` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_event_id` text,
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
	FOREIGN KEY (`parent_event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_normalized_events`("id", "parent_event_id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at") SELECT "id", "parent_event_id", "artist_id", "title", "description", "start_time", "end_time", "venue_id", "venue_name", "venue_url", "type", "is_cancelled", "tags", "created_at", "updated_at" FROM `normalized_events`;--> statement-breakpoint
DROP TABLE `normalized_events`;--> statement-breakpoint
ALTER TABLE `__new_normalized_events` RENAME TO `normalized_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_normalized_events_artist_start_time` ON `normalized_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_normalized_events_start_time` ON `normalized_events` (`start_time`);--> statement-breakpoint
CREATE INDEX `idx_normalized_events_parent` ON `normalized_events` (`parent_event_id`);