-- Add `posted_at` to raw_items: original post time on the source
-- platform, populated by the connector at ingestion when derivable.
-- Nullable; existing rows backfill as NULL and the read path falls
-- back to `fetched_at` for display.
ALTER TABLE `raw_items` ADD `posted_at` integer;
