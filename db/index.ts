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

async function initializeDatabaseSchema() {
  const db = getRawDb();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS clash_links (id text PRIMARY KEY NOT NULL, profile_id text DEFAULT 'default' NOT NULL, name text DEFAULT '订阅链接' NOT NULL, token text DEFAULT '' NOT NULL, token_hash text NOT NULL, encrypted_source text DEFAULT '' NOT NULL, status text DEFAULT 'active' NOT NULL, created_at integer NOT NULL, revoked_at integer, deleted_at integer)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_profiles (id text PRIMARY KEY NOT NULL, name text DEFAULT '订阅配置' NOT NULL, encrypted_source text DEFAULT '' NOT NULL, status text DEFAULT 'active' NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_source_snapshots (source_key text PRIMARY KEY NOT NULL, source_url text NOT NULL, content text NOT NULL, node_count integer DEFAULT 0 NOT NULL, updated_at integer NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS clash_airport_sources (id text PRIMARY KEY NOT NULL, name text DEFAULT '机场订阅' NOT NULL, kind text DEFAULT 'url' NOT NULL, source_url text DEFAULT '' NOT NULL, content text DEFAULT '' NOT NULL, hidden integer DEFAULT 0 NOT NULL, status text DEFAULT 'active' NOT NULL, node_count integer, created_at integer NOT NULL, updated_at integer NOT NULL)"),
  ]);
  await addMissingClashLinkColumns();
  await db.batch([
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS clash_links_token_hash_unique ON clash_links (token_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_links_status_idx ON clash_links (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_links_profile_idx ON clash_links (profile_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_profiles_status_idx ON clash_profiles (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS clash_airport_sources_status_idx ON clash_airport_sources (status)"),
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
