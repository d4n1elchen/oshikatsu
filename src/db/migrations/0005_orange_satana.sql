ALTER TABLE `venues` ADD `status` text DEFAULT 'discovered' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_venues_status` ON `venues` (`status`);