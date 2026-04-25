CREATE TABLE `event_related_links` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`raw_item_id` text,
	`url` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_event_related_link_dedup` ON `event_related_links` (`event_id`,`url`);