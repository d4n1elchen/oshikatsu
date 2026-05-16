-- Preserve resolver decision history when an operator overrides a
-- decision (or when one manual decision is itself superseded). Previously
-- EventResolver.resetDecision() deleted prior rows before writing the new
-- one, which destroyed the score/signals/reason the auto-resolver had
-- produced — exactly the signal we need to train future resolver
-- improvements against.
--
-- Three nullable columns:
--   superseded_at     when this row was replaced; NULL = current decision.
--   superseded_by_id  id of the row that replaced this one; chain follows.
--   note              optional free-text operator reason on a manual row.
--
-- Readers showing "current state" filter `superseded_at IS NULL`.
-- The full chain per extracted event is ORDER BY created_at over rows
-- sharing candidate_extracted_event_id.
ALTER TABLE `event_resolution_decisions` ADD `superseded_at` integer;
ALTER TABLE `event_resolution_decisions` ADD `superseded_by_id` text;
ALTER TABLE `event_resolution_decisions` ADD `note` text;
CREATE INDEX `idx_resolution_decisions_superseded` ON `event_resolution_decisions` (`superseded_at`);
