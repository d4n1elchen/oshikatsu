-- Add `handle` to artists. SQLite cannot add a NOT NULL column without a
-- DEFAULT, so the column is added nullable and backfilled from `id` for
-- existing rows. Operators can rename via the TUI to something more
-- readable. Application-layer types (drizzle schema) still mark it NOT
-- NULL so all inserts must provide a handle.
ALTER TABLE `artists` ADD `handle` text;--> statement-breakpoint
UPDATE `artists` SET `handle` = `id` WHERE `handle` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artists_handle` ON `artists` (`handle`);
