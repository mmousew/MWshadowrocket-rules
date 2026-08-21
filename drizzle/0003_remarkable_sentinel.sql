CREATE TABLE `clash_source_snapshots` (
	`source_key` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`content` text NOT NULL,
	`node_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
