CREATE TABLE `artists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`categories` text NOT NULL,
	`groups` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_entry_id` text NOT NULL,
	`source_name` text NOT NULL,
	`source_id` text NOT NULL,
	`raw_data` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`error_message` text,
	FOREIGN KEY (`source_entry_id`) REFERENCES `source_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text NOT NULL,
	`platform` text NOT NULL,
	`source_type` text NOT NULL,
	`source_config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
