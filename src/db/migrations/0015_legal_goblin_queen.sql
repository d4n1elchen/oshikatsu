CREATE TABLE `scheduler_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_name` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`error_class` text,
	`error_message` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `idx_scheduler_runs_task_started` ON `scheduler_runs` (`task_name`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduler_runs_status_started` ON `scheduler_runs` (`status`,`started_at`);--> statement-breakpoint
ALTER TABLE `raw_items` ADD `error_class` text;--> statement-breakpoint
CREATE INDEX `idx_raw_items_status` ON `raw_items` (`status`);