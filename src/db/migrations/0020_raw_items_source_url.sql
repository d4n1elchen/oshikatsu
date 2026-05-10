-- Add `source_url` to raw_items: canonical URL on the source platform
-- (e.g. https://x.com/<handle>/status/<id> for tweets), populated by
-- the connector at ingestion. Nullable; existing rows backfill as NULL
-- and the read path renders posts as non-clickable when absent.
ALTER TABLE `raw_items` ADD `source_url` text;
