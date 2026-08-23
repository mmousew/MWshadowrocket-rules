import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

export function getRawDb() {
  if (!env.DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return env.DB;
}

let databaseReady: Promise<void> | null = null;

async function addMissingClashLinkColumns() {
  const db = getRawDb();
  const info = await db.prepare("PRAGMA table_info(clash_links)").all<{ name: string }>();
  const columns = new Set((info.results || []).map((column) => column.name));
  const statements = [];
  if (!columns.has("token")) statements.push(db.prepare("ALTER TABLE clash_links ADD COLUMN token text DEFAULT '' NOT NULL"));
  if (!columns.has("name")) statements.push(db.prepare("ALTER TABLE clash_links ADD COLUMN name text DEFAULT '订阅链接' NOT NULL"));
  if (!columns.has("profile_id")) statements.push(db.prepare("ALTER TABLE clash_links ADD COLUMN profile_id text DEFAULT 'default' NOT NULL"));
  if (statements.length) await db.batch(statements);
}

async function addMissingClashProfileColumns() {
  const db = getRawDb();
  const info = await db.prepare("PRAGMA table_info(clash_profiles)").all<{ name: string }>();
  const columns = new Set((info.results || []).map((column) => column.name));
  if (!columns.has("rule_config_id")) await db.prepare("ALTER TABLE clash_profiles ADD COLUMN rule_config_id text DEFAULT 'default' NOT NULL").run();
}

async function addMissingRuleConfigColumns() {
  const db = getRawDb();
  const info = await db.prepare("PRAGMA table_info(rule_configs)").all<{ name: string }>();
  const columns = new Set((info.results || []).map((column) => column.name));
  if (!columns.has("is_template_default")) {
    await db.prepare("ALTER TABLE rule_configs ADD COLUMN is_template_default integer DEFAULT 0 NOT NULL").run();
  }
  const marked = await db.prepare("SELECT id FROM rule_configs WHERE status <> 'deleted' AND is_template_default = 1 LIMIT 1").first<{ id: string }>();
  if (!marked) {
    await db.prepare("UPDATE rule_configs SET is_template_default = CASE WHEN id = 'default' THEN 1 ELSE 0 END WHERE status <> 'deleted'").run();
  }
}

async function addMissingRuleSetColumns() {
  const db = getRawDb();
  const info = await db.prepare("PRAGMA table_info(rule_sets)").all<{ name: string }>();
  const columns = new Set((info.results || []).map((column) => column.name));
  const statements = [];
  if (!columns.has("visible")) statements.push(db.prepare("ALTER TABLE rule_sets ADD COLUMN visible integer DEFAULT 1 NOT NULL"));
  if (!columns.has("enabled")) statements.push(db.prepare("ALTER TABLE rule_sets ADD COLUMN enabled integer DEFAULT 1 NOT NULL"));
  if (statements.length) await db.batch(statements);
}

async function initializeDatabaseSchema() {
  const db = getRawDb();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS clash_links (id text PRIMARY KEY NOT NULL, profile_id text DEFAULT 'default' NOT NULL, name text DEFAULT '订阅链接' NOT NULL, token text DEFAULT '' NOT NULL, token_hash text NOT NULL, encrypted_source text DEFAULT '' NOT NULL, status text DEFAULT 'active' NOT NULL, created_at integer NOT NULL, revoked_at integer, deleted_at integer)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_profiles (id text PRIMARY KEY NOT NULL, name text DEFAULT '订阅配置' NOT NULL, encrypted_source text DEFAULT '' NOT NULL, rule_config_id text DEFAULT 'default' NOT NULL, status text DEFAULT 'active' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rule_configs (id text PRIMARY KEY NOT NULL, name text DEFAULT '默认规则' NOT NULL, content text DEFAULT '' NOT NULL, status text DEFAULT 'active' NOT NULL, is_template_default integer DEFAULT 0 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_source_snapshots (source_key text PRIMARY KEY NOT NULL, source_url text NOT NULL, content text NOT NULL, node_count integer DEFAULT 0 NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_airport_sources (id text PRIMARY KEY NOT NULL, name text DEFAULT '机场订阅' NOT NULL, kind text DEFAULT 'url' NOT NULL, source_url text DEFAULT '' NOT NULL, content text DEFAULT '' NOT NULL, hidden integer DEFAULT 0 NOT NULL, status text DEFAULT 'active' NOT NULL, node_count integer, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rule_sets (id text PRIMARY KEY NOT NULL, name text NOT NULL, description text DEFAULT '' NOT NULL, kind text DEFAULT 'managed' NOT NULL, entries text DEFAULT '[]' NOT NULL, source text DEFAULT '' NOT NULL, status text DEFAULT 'active' NOT NULL, visible integer DEFAULT 1 NOT NULL, enabled integer DEFAULT 1 NOT NULL, sort_order integer DEFAULT 0 NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rule_set_bindings (id text PRIMARY KEY NOT NULL, rule_config_id text NOT NULL, group_name text NOT NULL, rule_set_id text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rule_set_migrations (id text PRIMARY KEY NOT NULL, version integer NOT NULL, created_at integer NOT NULL)"),
  ]);
  await addMissingClashLinkColumns();
  await addMissingClashProfileColumns();
  await addMissingRuleConfigColumns();
  await addMissingRuleSetColumns();
  await db.batch([
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS clash_links_token_hash_unique ON clash_links (token_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_links_status_idx ON clash_links (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_links_profile_idx ON clash_links (profile_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_profiles_status_idx ON clash_profiles (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_profiles_rule_config_idx ON clash_profiles (rule_config_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rule_configs_status_idx ON rule_configs (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_airport_sources_status_idx ON clash_airport_sources (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rule_sets_status_idx ON rule_sets (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rule_sets_sort_idx ON rule_sets (sort_order)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rule_set_bindings_config_idx ON rule_set_bindings (rule_config_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS rule_set_bindings_group_idx ON rule_set_bindings (group_name)"),
  ]);
  try {
    await db.prepare("PRAGMA optimize").run();
  } catch {
    // Some local D1 runtimes do not expose this maintenance pragma.
  }
}

export async function ensureDatabaseSchema() {
  if (!databaseReady) {
    databaseReady = initializeDatabaseSchema().catch((error) => {
      databaseReady = null;
      throw error;
    });
  }
  await databaseReady;
}

export async function getReadyRawDb() {
  await ensureDatabaseSchema();
  return getRawDb();
}
