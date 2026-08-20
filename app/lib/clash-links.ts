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

export async function createClashLink(encryptedSource: string) {
  const db = getRawDb();
  const token = randomToken();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db.prepare("INSERT INTO clash_links (id, token, token_hash, encrypted_source, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").bind(id, token, await hashToken(token), encryptedSource, createdAt).run();
  return { id, token, status: "active" as const, createdAt, revokedAt: null };
}

export async function findClashLink(token: string) {
  return getRawDb().prepare("SELECT id, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE token_hash = ? LIMIT 1")
    .bind(await hashToken(token)).first<{ id: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
}

export async function listClashLinks() {
  const result = await getRawDb().prepare("SELECT id, token, encrypted_source, status, created_at, revoked_at, deleted_at FROM clash_links WHERE status <> 'deleted' ORDER BY created_at DESC").all<{ id: string; token: string; encrypted_source: string; status: ClashLinkStatus; created_at: number; revoked_at: number | null; deleted_at: number | null }>();
  return result.results;
}

export async function updateClashLink(id: string, status: "revoked" | "deleted") {
  const now = Date.now();
  await getRawDb().prepare("UPDATE clash_links SET status = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END WHERE id = ?").bind(status, status, now, status, now, id).run();
}
