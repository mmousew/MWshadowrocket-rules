import { getReadyRawDb } from "../../db";

const encoder = new TextEncoder();
export type ClashLinkStatus = "active" | "revoked" | "deleted";
export type ClashProfileStatus = "active" | "deleted";
export type ClashProfileRow = { id: string; name: string; encrypted_source: string; status: ClashProfileStatus; created_at: number; updated_at: number };

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Buffer.from(digest).toString("hex");
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("base64url");
}

export async function createClashLink(encryptedSource: string, name = "订阅链接", profileId = "default") {
  const db = await getReadyRawDb();
  const token = randomToken();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db.prepare("INSERT INTO clash_links (id, profile_id, name, token, token_hash, encrypted_source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)").bind(id, profileId, name, token, await hashToken(token), encryptedSource, createdAt).run();
  return { id, name, token, status: "active" as const, createdAt, revokedAt: null };
}

export async function syncActiveClashSources(encryptedSource: string, profileId = "default") {
  await (await getReadyRawDb()).prepare("UPDATE clash_links SET encrypted_source = ? WHERE status = 'active' AND profile_id = ?").bind(encryptedSource, profileId).run();
}

export async function ensureDefaultClashProfile() {
  const db = await getReadyRawDb();
  const existing = await db.prepare("SELECT id, name, encrypted_source, status, created_at, updated_at FROM clash_profiles WHERE id = 'default' LIMIT 1").first<ClashProfileRow>();
  if (existing) return existing;
  const source = await db.prepare("SELECT encrypted_source, created_at FROM clash_links WHERE profile_id = 'default' AND status <> 'deleted' AND encrypted_source <> '' ORDER BY created_at ASC LIMIT 1").first<{ encrypted_source: string; created_at: number }>();
  const now = Date.now();
  await db.prepare("INSERT INTO clash_profiles (id, name, encrypted_source, status, created_at, updated_at) VALUES ('default', ?, ?, 'active', ?, ?)").bind("花云400G", source?.encrypted_source || "", source?.created_at || now, now).run();
  return { id: "default", name: "花云400G", encrypted_source: source?.encrypted_source || "", status: "active" as const, created_at: source?.created_at || now, updated_at: now };
}

export async function listClashProfiles() {
  await ensureDefaultClashProfile();
  const result = await (await getReadyRawDb()).prepare("SELECT id, name, encrypted_source, status, created_at, updated_at FROM clash_profiles WHERE status <> 'deleted' ORDER BY created_at ASC").all<ClashProfileRow>();
  return result.results;
}

export async function getClashProfile(id: string) {
  await ensureDefaultClashProfile();
  return (await getReadyRawDb()).prepare("SELECT id, name, encrypted_source, status, created_at, updated_at FROM clash_profiles WHERE id = ? AND status <> 'deleted' LIMIT 1").bind(id).first<ClashProfileRow>();
}

export async function createClashProfile(name: string, encryptedSource: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeName = name.trim().slice(0, 80) || "订阅配置";
  await (await getReadyRawDb()).prepare("INSERT INTO clash_profiles (id, name, encrypted_source, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").bind(id, safeName, encryptedSource, now, now).run();
  return { id, name: safeName, encrypted_source: encryptedSource, status: "active" as const, created_at: now, updated_at: now };
}

export async function updateClashProfileSource(id: string, encryptedSource: string) {
  const now = Date.now();
  await (await getReadyRawDb()).prepare("UPDATE clash_profiles SET encrypted_source = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(encryptedSource, now, id).run();
  await syncActiveClashSources(encryptedSource, id);
}

export async function renameClashProfile(id: string, name: string) {
  await (await getReadyRawDb()).prepare("UPDATE clash_profiles SET name = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(name.trim().slice(0, 80) || "订阅配置", Date.now(), id).run();
}

export async function renameClashLink(id: string, name: string) {
  await (await getReadyRawDb()).prepare("UPDATE clash_links SET name = ? WHERE id = ? AND status <> 'deleted'").bind(name.trim().slice(0, 80) || "订阅链接", id).run();
}

export async function findClashLink(token: string) {
  return (await getReadyRawDb()).prepare("SELECT id, profile_id, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE token_hash = ? LIMIT 1")
    .bind(await hashToken(token)).first<{ id: string; profile_id: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
}

export async function listClashLinks() {
  const result = await (await getReadyRawDb()).prepare("SELECT id, profile_id, name, token, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE status <> 'deleted' ORDER BY created_at DESC").all<{ id: string; profile_id: string; name: string; token: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
  return result.results;
}

export async function updateClashLink(id: string, status: "revoked" | "deleted") {
  const now = Date.now();
  await (await getReadyRawDb()).prepare("UPDATE clash_links SET status = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END WHERE id = ?").bind(status, status, now, status, now, id).run();
}

const snapshotEncoder = new TextEncoder();
type SnapshotClient = "clash" | "shadowrocket";

async function getLegacySourceKey(sourceUrl: string) {
  const digest = await crypto.subtle.digest("SHA-256", snapshotEncoder.encode(sourceUrl));
  return Buffer.from(digest).toString("hex");
}

export async function getSourceKey(sourceUrl: string, client: SnapshotClient = "clash") {
  const digest = await crypto.subtle.digest("SHA-256", snapshotEncoder.encode(`${client}\n${sourceUrl}`));
  return Buffer.from(digest).toString("hex");
}

export async function saveSourceSnapshot(sourceUrl: string, content: string, nodeCount: number, client: SnapshotClient = "clash") {
  const sourceKey = await getSourceKey(sourceUrl, client);
  await (await getReadyRawDb()).prepare(
    "INSERT INTO clash_source_snapshots (source_key, source_url, content, node_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET source_url = excluded.source_url, content = excluded.content, node_count = excluded.node_count, updated_at = excluded.updated_at"
  ).bind(sourceKey, sourceUrl, content, nodeCount, Date.now()).run();
}

export async function getSourceSnapshot(sourceUrl: string, client: SnapshotClient = "clash") {
  const sourceKey = await getSourceKey(sourceUrl, client);
  const db = await getReadyRawDb();
  const snapshot = await db.prepare("SELECT source_url, content, node_count, updated_at FROM clash_source_snapshots WHERE source_key = ? LIMIT 1")
    .bind(sourceKey)
    .first<{ source_url: string; content: string; node_count: number; updated_at: number }>();
  // Existing Clash snapshots used the pre-client-specific key. Keep them
  // available after the cache split so a temporary airport outage does not
  // blank an otherwise working Clash subscription.
  if (snapshot) return snapshot;
  // Shadowrocket can consume a Clash snapshot after the source has been
  // converted by the server. This is important for converter URLs that
  // reject a Shadowrocket User-Agent while their Clash response remains
  // available. The output builder will translate it into native format.
  const clashSourceKey = await getSourceKey(sourceUrl, "clash");
  const clashSnapshot = await db.prepare("SELECT source_url, content, node_count, updated_at FROM clash_source_snapshots WHERE source_key = ? LIMIT 1")
    .bind(clashSourceKey)
    .first<{ source_url: string; content: string; node_count: number; updated_at: number }>();
  if (clashSnapshot) return clashSnapshot;
  const legacySourceKey = await getLegacySourceKey(sourceUrl);
  return db.prepare("SELECT source_url, content, node_count, updated_at FROM clash_source_snapshots WHERE source_key = ? LIMIT 1")
    .bind(legacySourceKey)
    .first<{ source_url: string; content: string; node_count: number; updated_at: number }>();
}
