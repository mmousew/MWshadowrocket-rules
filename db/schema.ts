import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clashProfiles = sqliteTable("clash_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("订阅配置"),
  encryptedSource: text("encrypted_source").notNull().default(""),
  ruleConfigId: text("rule_config_id").notNull().default("default"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({ statusIdx: index("clash_profiles_status_idx").on(table.status), ruleConfigIdx: index("clash_profiles_rule_config_idx").on(table.ruleConfigId) }));

export const ruleConfigs = sqliteTable("rule_configs", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("默认规则"),
  content: text("content").notNull().default(""),
  status: text("status").notNull().default("active"),
  isTemplateDefault: integer("is_template_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({ statusIdx: index("rule_configs_status_idx").on(table.status) }));

export const clashLinks = sqliteTable("clash_links", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().default("default"),
  name: text("name").notNull().default("订阅链接"),
  token: text("token").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  encryptedSource: text("encrypted_source").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
  deletedAt: integer("deleted_at"),
}, (table) => ({
  statusIdx: index("clash_links_status_idx").on(table.status),
  profileIdx: index("clash_links_profile_idx").on(table.profileId),
}));

export const clashSourceSnapshots = sqliteTable("clash_source_snapshots", {
  sourceKey: text("source_key").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  content: text("content").notNull(),
  nodeCount: integer("node_count").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const clashAirportSources = sqliteTable("clash_airport_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("机场订阅"),
  kind: text("kind").notNull().default("url"),
  sourceUrl: text("source_url").notNull().default(""),
  content: text("content").notNull().default(""),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  nodeCount: integer("node_count"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  statusIdx: index("clash_airport_sources_status_idx").on(table.status),
}));

export const ruleSets = sqliteTable("rule_sets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  kind: text("kind").notNull().default("managed"),
  entries: text("entries").notNull().default("[]"),
  platformSources: text("platform_sources").notNull().default("{}"),
  source: text("source").notNull().default(""),
  status: text("status").notNull().default("active"),
  visible: integer("visible", { mode: "boolean" }).notNull().default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({ statusIdx: index("rule_sets_status_idx").on(table.status), sortIdx: index("rule_sets_sort_idx").on(table.sortOrder) }));

export const ruleSetBindings = sqliteTable("rule_set_bindings", {
  id: text("id").primaryKey(),
  ruleConfigId: text("rule_config_id").notNull(),
  groupName: text("group_name").notNull(),
  ruleSetId: text("rule_set_id").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  configIdx: index("rule_set_bindings_config_idx").on(table.ruleConfigId),
  groupIdx: index("rule_set_bindings_group_idx").on(table.groupName),
}));

export const ruleSetMigrations = sqliteTable("rule_set_migrations", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const groupTempRules = sqliteTable("group_temp_rules", {
  id: text("id").primaryKey(),
  ruleConfigId: text("rule_config_id").notNull(),
  groupName: text("group_name").notNull(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  policy: text("policy").notNull(),
  options: text("options").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  configIdx: index("group_temp_rules_config_idx").on(table.ruleConfigId),
  groupIdx: index("group_temp_rules_group_idx").on(table.groupName),
}));
