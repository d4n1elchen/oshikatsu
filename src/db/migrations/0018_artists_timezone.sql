-- Add `timezone` (IANA name, e.g. "Asia/Tokyo") to artists. Used as a
-- fallback when the LLM emits an offset-less timestamp during extraction.
-- Nullable; the ultimate fallback is `config.defaultTimezone`.
ALTER TABLE `artists` ADD `timezone` text;
