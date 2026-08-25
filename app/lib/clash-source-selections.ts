import { getReadyRawDb } from "../../db";

export type SourceSelectionMode = "all" | "keyword" | "manual";

export type ClashSourceSelection = {
  profileId: string;
  sourceId: string;
  mode: SourceSelectionMode;
  keywords: string;
  nodeIds: string[];
};

function normalizeMode(value: unknown): SourceSelectionMode {
  return value === "keyword" || value === "manual" ? value : "all";
}

function parseNodeIds(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim()).map((item) => item.trim());
    } catch { /* legacy empty value */ }
  }
  return [];
}

function rowToSelection(row: Record<string, unknown>): ClashSourceSelection {
  return {
    profileId: String(row.profile_id || "default"),
    sourceId: String(row.source_id || ""),
    mode: normalizeMode(row.mode),
    keywords: String(row.keywords || ""),
    nodeIds: parseNodeIds(row.node_ids),
  };
}

export async function listProfileSourceSelections(profileId: string) {
  const db = await getReadyRawDb();
  const result = await db.prepare("SELECT profile_id, source_id, mode, keywords, node_ids FROM clash_profile_source_selections WHERE profile_id = ? ORDER BY source_id").bind(profileId).all<Record<string, unknown>>();
  return (result.results || []).map(rowToSelection);
}

export async function getProfileSourceSelection(profileId: string, sourceId: string) {
  const db = await getReadyRawDb();
  const row = await db.prepare("SELECT profile_id, source_id, mode, keywords, node_ids FROM clash_profile_source_selections WHERE profile_id = ? AND source_id = ? LIMIT 1").bind(profileId, sourceId).first<Record<string, unknown>>();
  return row ? rowToSelection(row) : null;
}

export async function upsertProfileSourceSelection(input: {
  profileId: string;
  sourceId: string;
  mode?: unknown;
  keywords?: unknown;
  nodeIds?: unknown;
}) {
  const db = await getReadyRawDb();
  const now = Date.now();
  const mode = normalizeMode(input.mode);
  const keywords = typeof input.keywords === "string" ? input.keywords.trim().slice(0, 500) : "";
  const nodeIds = [...new Set(parseNodeIds(input.nodeIds))].slice(0, 5000);
  const id = `${input.profileId}:${input.sourceId}`;
  await db.prepare(`INSERT INTO clash_profile_source_selections (id, profile_id, source_id, mode, keywords, node_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, source_id) DO UPDATE SET mode = excluded.mode, keywords = excluded.keywords, node_ids = excluded.node_ids, updated_at = excluded.updated_at`).bind(id, input.profileId, input.sourceId, mode, keywords, JSON.stringify(nodeIds), now, now).run();
  return { profileId: input.profileId, sourceId: input.sourceId, mode, keywords, nodeIds } satisfies ClashSourceSelection;
}

export async function deleteProfileSourceSelection(profileId: string, sourceId: string) {
  const db = await getReadyRawDb();
  await db.prepare("DELETE FROM clash_profile_source_selections WHERE profile_id = ? AND source_id = ?").bind(profileId, sourceId).run();
}
