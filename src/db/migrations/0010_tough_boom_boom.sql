ALTER TABLE `extracted_events` ADD `event_scope` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `extracted_events` ADD `parent_event_hint` text;