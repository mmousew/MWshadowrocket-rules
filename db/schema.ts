import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clashProfiles = sqliteTable("clash_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("订阅配置"),
  encryptedSource: text("encrypted_source").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({ statusIdx: index("clash_profiles_status_idx").on(table.status) }));

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
