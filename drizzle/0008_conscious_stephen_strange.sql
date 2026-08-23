CREATE TABLE `rule_set_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_config_id` text NOT NULL,
	`group_name` text NOT NULL,
	`rule_set_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rule_set_bindings_config_idx` ON `rule_set_bindings` (`rule_config_id`);--> statement-breakpoint
CREATE INDEX `rule_set_bindings_group_idx` ON `rule_set_bindings` (`group_name`);--> statement-breakpoint
CREATE TABLE `rule_set_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'managed' NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rule_sets_status_idx` ON `rule_sets` (`status`);--> statement-breakpoint
CREATE INDEX `rule_sets_sort_idx` ON `rule_sets` (`sort_order`);
