PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_extracted_events` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_item_id` text NOT NULL,
	`artist_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`start_time` integer,
	`end_time` integer,
	`venue_id` text,
	`venue_name` text,
	`venue_url` text,
	`type` text NOT NULL,
	`event_scope` text DEFAULT 'unknown' NOT NULL,
	`parent_event_hint` text,
	`is_cancelled` integer DEFAULT false NOT NULL,
	`tags` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_extracted_events`(
	"id",
	"raw_item_id",
	"artist_id",
	"title",
	"description",
	"start_time",
	"end_time",
	"venue_id",
	"venue_name",
	"venue_url",
	"type",
	"event_scope",
	"parent_event_hint",
	"is_cancelled",
	"tags",
	"created_at",
	"updated_at"
)
SELECT
	"extracted_events"."id",
	(
		SELECT "source_references"."raw_item_id"
		FROM "source_references"
		WHERE "source_references"."extracted_event_id" = "extracted_events"."id"
		ORDER BY "source_references"."created_at" ASC
		LIMIT 1
	),
	"artist_id",
	"title",
	"description",
	"start_time",
	"end_time",
	"venue_id",
	"venue_name",
	"venue_url",
	"type",
	"event_scope",
	"parent_event_hint",
	"is_cancelled",
	"tags",
	"created_at",
	"updated_at"
FROM `extracted_events`;--> statement-breakpoint
DROP TABLE `extracted_events`;--> statement-breakpoint
ALTER TABLE `__new_extracted_events` RENAME TO `extracted_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_extracted_events_raw_item` ON `extracted_events` (`raw_item_id`);--> statement-breakpoint
CREATE INDEX `idx_extracted_events_artist_start_time` ON `extracted_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_extracted_events_start_time` ON `extracted_events` (`start_time`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
