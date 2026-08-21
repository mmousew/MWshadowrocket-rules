CREATE TABLE `clash_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '订阅配置' NOT NULL,
	`encrypted_source` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clash_profiles_status_idx` ON `clash_profiles` (`status`);--> statement-breakpoint
ALTER TABLE `clash_links` ADD `profile_id` text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `clash_profiles` (`id`, `name`, `encrypted_source`, `status`, `created_at`, `updated_at`) VALUES ('default', '花云400G', '', 'active', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
--> statement-breakpoint
UPDATE `clash_profiles` SET `encrypted_source` = COALESCE((SELECT `encrypted_source` FROM `clash_links` WHERE `profile_id` = 'default' AND `status` <> 'deleted' AND `encrypted_source` <> '' ORDER BY `created_at` DESC LIMIT 1), `encrypted_source`), `updated_at` = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE `id` = 'default';
