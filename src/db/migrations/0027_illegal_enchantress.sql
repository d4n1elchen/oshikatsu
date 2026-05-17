CREATE TABLE `event_embeddings` (
	`normalized_event_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	`vector` blob NOT NULL,
	`source_text` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`normalized_event_id`) REFERENCES `normalized_events`(`id`) ON UPDATE no action ON DELETE cascade
);
