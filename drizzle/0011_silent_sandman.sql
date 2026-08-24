CREATE TABLE `rule_group_settings` (
	`rule_config_id` text NOT NULL,
	`group_name` text NOT NULL,
	`visible` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rule_group_settings_config_idx` ON `rule_group_settings` (`rule_config_id`);--> statement-breakpoint
