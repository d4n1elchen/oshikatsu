ALTER TABLE `normalized_events` ADD `artist_id` text REFERENCES artists(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `normalized_events` ADD `start_time` integer;--> statement-breakpoint
ALTER TABLE `normalized_events` ADD `end_time` integer;--> statement-breakpoint
UPDATE `normalized_events` SET `start_time` = `event_time` WHERE `start_time` IS NULL;--> statement-breakpoint
UPDATE `normalized_events`
SET `artist_id` = (
	SELECT `watch_targets`.`artist_id`
	FROM `source_references`
	INNER JOIN `raw_items` ON `raw_items`.`id` = `source_references`.`raw_item_id`
	INNER JOIN `watch_targets` ON `watch_targets`.`id` = `raw_items`.`watch_target_id`
	WHERE `source_references`.`event_id` = `normalized_events`.`id`
	LIMIT 1
)
WHERE `artist_id` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_normalized_events_artist_start_time` ON `normalized_events` (`artist_id`,`start_time`);--> statement-breakpoint
CREATE INDEX `idx_normalized_events_start_time` ON `normalized_events` (`start_time`);
