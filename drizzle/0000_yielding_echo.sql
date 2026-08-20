CREATE TABLE `clash_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`encrypted_source` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clash_links_token_hash_unique` ON `clash_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `clash_links_status_idx` ON `clash_links` (`status`);