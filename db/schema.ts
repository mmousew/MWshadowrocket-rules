import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const clashLinks = sqliteTable("clash_links", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default("订阅链接"),
  token: text("token").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  encryptedSource: text("encrypted_source").notNull().default(""),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  revokedAt: integer("revoked_at"),
  deletedAt: integer("deleted_at"),
}, (table) => ({ statusIdx: index("clash_links_status_idx").on(table.status) }));
