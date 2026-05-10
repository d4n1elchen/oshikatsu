-- Extend raw_items.status with a fourth terminal value, `not_an_event`,
-- for posts the LLM classifies as outside the event taxonomy (mood
-- tweets, milestones, recaps, fan engagement, press coverage,
-- reminder reposts, etc.). Distinct from `error` so real extraction
-- failures stay measurable on their own.
--
-- SQLite ignores the CHECK-style enum encoded in Drizzle's TEXT, so
-- the existing column accepts the new value with no schema change to
-- the column itself. Two new nullable columns capture the structured
-- non-event signal: `not_an_event_category` records which bucket the
-- LLM picked, and `related_event_hint` is free-form text pointing at
-- whichever existing event a milestone/coverage post relates to.
ALTER TABLE `raw_items` ADD `not_an_event_category` text;
ALTER TABLE `raw_items` ADD `related_event_hint` text;
