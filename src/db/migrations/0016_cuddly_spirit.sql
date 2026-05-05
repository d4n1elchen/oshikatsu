CREATE TABLE `export_cursors` (
	`consumer_name` text PRIMARY KEY NOT NULL,
	`cursor_position` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `export_queue` (
	`position` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalized_event_id` text NOT NULL,
	`change_type` text NOT NULL,
	`version` integer NOT NULL,
	`enqueued_at` integer NOT NULL,
	FOREIGN KEY (`normalized_event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_export_queue_event_position` ON `export_queue` (`normalized_event_id`,`position`);