CREATE TABLE `clash_airport_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '机场订阅' NOT NULL,
	`kind` text DEFAULT 'url' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`node_count` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clash_airport_sources_status_idx` ON `clash_airport_sources` (`status`);