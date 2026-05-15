-- Persist the orphan-post category alongside raw_items.status='not_an_event'.
-- Previously the category (mood | fan_engagement | other) was passed to
-- RawStorage.markNotAnEvent but discarded — only the human-readable reason
-- ended up in error_message. The operator orphan-inspection surface needs
-- the category to group rows and spot misclassifications.
--
-- See design_docs/2026-05-10-non-event-classification/ for the taxonomy.
ALTER TABLE `raw_items` ADD `not_an_event_category` text;
CREATE INDEX `idx_raw_items_not_an_event_category` ON `raw_items` (`not_an_event_category`);
