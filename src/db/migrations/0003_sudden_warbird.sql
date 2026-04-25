CREATE TABLE `venue_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`alias` text NOT NULL,
	`locale` text,
	`source` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_venue_alias_dedup` ON `venue_aliases` (`venue_id`,`alias`);--> statement-breakpoint
CREATE INDEX `idx_venue_alias` ON `venue_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'unknown' NOT NULL,
	`url` text,
	`address` text,
	`city` text,
	`region` text,
	`country` text,
	`latitude` real,
	`longitude` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_venues_name` ON `venues` (`name`);--> statement-breakpoint
CREATE INDEX `idx_venues_url` ON `venues` (`url`);--> statement-breakpoint
CREATE INDEX `idx_venues_kind` ON `venues` (`kind`);--> statement-breakpoint
ALTER TABLE `normalized_events` ADD `venue_id` text REFERENCES venues(id);