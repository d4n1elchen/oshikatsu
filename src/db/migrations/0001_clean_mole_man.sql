CREATE TABLE `normalized_events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`event_time` integer NOT NULL,
	`venue_name` text,
	`venue_url` text,
	`type` text NOT NULL,
	`is_cancelled` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_references` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`raw_item_id` text NOT NULL,
	`source_name` text NOT NULL,
	`source_id` text NOT NULL,
	`publish_time` integer NOT NULL,
	`url` text NOT NULL,
	`author` text NOT NULL,
	`raw_content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE cascade
);
