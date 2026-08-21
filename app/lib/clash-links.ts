import { getRawDb } from "../../db";

const encoder = new TextEncoder();
export type ClashLinkStatus = "active" | "revoked" | "deleted";

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Buffer.from(digest).toString("hex");
}

function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString("base64url");
}

export async function createClashLink(encryptedSource: string, name = "订阅链接") {
  const db = getRawDb();
  const token = randomToken();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db.prepare("INSERT INTO clash_links (id, name, token, token_hash, encrypted_source, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)").bind(id, name, token, await hashToken(token), encryptedSource, createdAt).run();
  return { id, name, token, status: "active" as const, createdAt, revokedAt: null };
}

export async function syncActiveClashSources(encryptedSource: string) {
  await getRawDb().prepare("UPDATE clash_links SET encrypted_source = ? WHERE status = 'active'").bind(encryptedSource).run();
}

export async function renameClashLink(id: string, name: string) {
  await getRawDb().prepare("UPDATE clash_links SET name = ? WHERE id = ? AND status <> 'deleted'").bind(name.trim().slice(0, 80) || "订阅链接", id).run();
}

export async function findClashLink(token: string) {
  return getRawDb().prepare("SELECT id, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE token_hash = ? LIMIT 1")
    .bind(await hashToken(token)).first<{ id: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
}

export async function listClashLinks() {
  const result = await getRawDb().prepare("SELECT id, name, token, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE status <> 'deleted' ORDER BY created_at DESC").all<{ id: string; name: string; token: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
  return result.results;
}

export async function updateClashLink(id: string, status: "revoked" | "deleted") {
  const now = Date.now();
  await getRawDb().prepare("UPDATE clash_links SET status = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END WHERE id = ?").bind(status, status, now, status, now, id).run();
}

const snapshotEncoder = new TextEncoder();

export async function getSourceKey(sourceUrl: string) {
  const digest = await crypto.subtle.digest("SHA-256", snapshotEncoder.encode(sourceUrl));
  return Buffer.from(digest).toString("hex");
}

export async function saveSourceSnapshot(sourceUrl: string, content: string, nodeCount: number) {
  const sourceKey = await getSourceKey(sourceUrl);
  await getRawDb().prepare(
    "INSERT INTO clash_source_snapshots (source_key, source_url, content, node_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET source_url = excluded.source_url, content = excluded.content, node_count = excluded.node_count, updated_at = excluded.updated_at"
  ).bind(sourceKey, sourceUrl, content, nodeCount, Date.now()).run();
}

export async function getSourceSnapshot(sourceUrl: string) {
  const sourceKey = await getSourceKey(sourceUrl);
  return getRawDb().prepare("SELECT source_url, content, node_count, updated_at FROM clash_source_snapshots WHERE source_key = ? LIMIT 1")
    .bind(sourceKey)
    .first<{ source_url: string; content: string; node_count: number; updated_at: number }>();
}
