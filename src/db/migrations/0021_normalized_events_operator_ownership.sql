-- Add operator-ownership flags to normalized_events. When an operator
-- edits a row through the admin surface, `operator_owned` flips to 1
-- and `operator_edited_at` records when. The resolver checks the flag
-- on its UPDATE paths and skips frozen rows. Operators can release
-- the row back to the resolver from the edit modal.
ALTER TABLE `normalized_events` ADD `operator_owned` integer NOT NULL DEFAULT 0;
ALTER TABLE `normalized_events` ADD `operator_edited_at` integer;
