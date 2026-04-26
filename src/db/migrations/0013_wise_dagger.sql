CREATE TABLE `event_resolution_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_extracted_event_id` text NOT NULL,
	`matched_normalized_event_id` text,
	`decision` text NOT NULL,
	`score` real,
	`signals` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`candidate_extracted_event_id`) REFERENCES `extracted_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_normalized_event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_resolution_decisions_extracted` ON `event_resolution_decisions` (`candidate_extracted_event_id`);--> statement-breakpoint
CREATE INDEX `idx_resolution_decisions_normalized` ON `event_resolution_decisions` (`matched_normalized_event_id`);--> statement-breakpoint
CREATE INDEX `idx_resolution_decisions_decision` ON `event_resolution_decisions` (`decision`);--> statement-breakpoint
CREATE TABLE `normalized_event_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_event_id` text NOT NULL,
	`extracted_event_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`normalized_event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extracted_event_id`) REFERENCES `extracted_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_normalized_event_sources_dedup` ON `normalized_event_sources` (`normalized_event_id`,`extracted_event_id`);--> statement-breakpoint
CREATE INDEX `idx_normalized_event_sources_extracted` ON `normalized_event_sources` (`extracted_event_id`);--> statement-breakpoint
CREATE TABLE `normalized_events` (
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
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_normalized_events_artist_start_time` ON `normalized_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_normalized_events_start_time` ON `normalized_events` (`start_time`);--> statement-breakpoint
CREATE INDEX `idx_normalized_events_parent` ON `normalized_events` (`parent_event_id`);