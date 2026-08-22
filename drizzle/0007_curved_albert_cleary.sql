CREATE TABLE `rule_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '默认规则' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rule_configs_status_idx` ON `rule_configs` (`status`);--> statement-breakpoint
ALTER TABLE `clash_profiles` ADD `rule_config_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `clash_profiles_rule_config_idx` ON `clash_profiles` (`rule_config_id`);