import { getReadyRawDb } from "../../db";
import { buildShadowrocketRuleConfigFromClash } from "./clash-config";
import { getSourceSnapshot } from "./clash-links";

export const DEFAULT_RULE_CONFIG_ID = "default";
const HAOZI_RULE_CONFIG_NAME = "耗子专属";
const HAOZI_PROFILE_NAME = "耗子专用";

export type RuleConfigRow = {
  id: string;
  name: string;
  content: string;
  status: "active" | "deleted";
  created_at: number;
  updated_at: number;
  profile_count?: number;
};

export async function getRuleConfig(id = DEFAULT_RULE_CONFIG_ID) {
  return (await getReadyRawDb()).prepare(
    "SELECT id, name, content, status, created_at, updated_at FROM rule_configs WHERE id = ? AND status <> 'deleted' LIMIT 1"
  ).bind(id).first<RuleConfigRow>();
}

export async function listRuleConfigs() {
  const result = await (await getReadyRawDb()).prepare(
    "SELECT rc.id, rc.name, rc.content, rc.status, rc.created_at, rc.updated_at, COUNT(cp.id) AS profile_count FROM rule_configs rc LEFT JOIN clash_profiles cp ON cp.rule_config_id = rc.id AND cp.status <> 'deleted' WHERE rc.status <> 'deleted' GROUP BY rc.id ORDER BY CASE WHEN rc.id = 'default' THEN 0 ELSE 1 END, rc.created_at ASC"
  ).all<RuleConfigRow>();
  return result.results;
}

export async function ensureDefaultRuleConfig(content: string) {
  const existing = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  if (existing) return existing;
  const now = Date.now();
  await (await getReadyRawDb()).prepare(
    "INSERT INTO rule_configs (id, name, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).bind(DEFAULT_RULE_CONFIG_ID, "默认规则", content, now, now).run();
  return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
}

/**
 * Split the old single default scheme into the user's private scheme and the
 * new Flower-based default scheme. This is intentionally idempotent: once the
 * named Haozi scheme exists, later requests only repair profile assignments.
 */
export async function ensureRuleConfigAssignments() {
  const db = await getReadyRawDb();
  const currentDefault = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  if (!currentDefault) return null;

  const haozi = await db.prepare(
    "SELECT id, name, content, status, created_at, updated_at FROM rule_configs WHERE name = ? AND status <> 'deleted' LIMIT 1"
  ).bind(HAOZI_RULE_CONFIG_NAME).first<RuleConfigRow>();

  if (haozi) {
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name = ? AND status <> 'deleted'").bind(haozi.id, now, HAOZI_PROFILE_NAME),
      db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name <> ? AND status <> 'deleted'").bind(DEFAULT_RULE_CONFIG_ID, now, HAOZI_PROFILE_NAME),
    ]);
    return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  }

  // The Flower URL is often protected or unavailable to a server-side fetch.
  // Use the last verified Clash snapshot instead of making the migration
  // depend on a live airport request.
  let flowerContent = "";
  try {
    const flowerSource = await db.prepare(
      "SELECT source_url, content FROM clash_airport_sources WHERE status <> 'deleted' AND (name LIKE '%花云%' OR source_url LIKE '%api-huacloud.com/sub%') ORDER BY updated_at DESC LIMIT 1"
    ).first<{ source_url: string; content: string }>();
    const snapshot = flowerSource?.source_url
      ? await getSourceSnapshot(flowerSource.source_url, "clash")
      : await db.prepare(
        "SELECT source_url, content FROM clash_source_snapshots WHERE source_url LIKE '%api-huacloud.com/sub%' AND content <> '' ORDER BY updated_at DESC LIMIT 1"
      ).first<{ source_url: string; content: string }>();
    const sourceContent = snapshot?.content || flowerSource?.content || "";
    if (sourceContent.trim()) flowerContent = buildShadowrocketRuleConfigFromClash(sourceContent, "花云默认规则");
  } catch {
    flowerContent = "";
  }
  if (!flowerContent) return currentDefault;

  const now = Date.now();
  const existingId = await db.prepare("SELECT id FROM rule_configs WHERE id = ? LIMIT 1").bind("haozi-custom").first<{ id: string }>();
  const haoziId = existingId?.id || "haozi-custom";
  if (existingId) {
    await db.prepare(
      "UPDATE rule_configs SET name = ?, content = ?, status = 'active', updated_at = ? WHERE id = ?"
    ).bind(HAOZI_RULE_CONFIG_NAME, currentDefault.content, now, haoziId).run();
  } else {
    await db.prepare(
      "INSERT INTO rule_configs (id, name, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).bind(haoziId, HAOZI_RULE_CONFIG_NAME, currentDefault.content, now, now).run();
  }

  await db.batch([
    db.prepare("UPDATE rule_configs SET name = ?, content = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind("默认规则", flowerContent, now, DEFAULT_RULE_CONFIG_ID),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name = ? AND status <> 'deleted'").bind(haoziId, now, HAOZI_PROFILE_NAME),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name <> ? AND status <> 'deleted'").bind(DEFAULT_RULE_CONFIG_ID, now, HAOZI_PROFILE_NAME),
  ]);
  return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
}

export async function createRuleConfig(name: string, content: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeName = name.trim().slice(0, 80) || "规则方案";
  await (await getReadyRawDb()).prepare(
    "INSERT INTO rule_configs (id, name, content, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).bind(id, safeName, content, now, now).run();
  return getRuleConfig(id);
}

export async function updateRuleConfig(id: string, changes: { name?: string; content?: string }) {
  const current = await getRuleConfig(id);
  if (!current) throw new Error("规则方案不存在");
  const name = typeof changes.name === "string" ? changes.name.trim().slice(0, 80) || "规则方案" : current.name;
  const content = typeof changes.content === "string" ? changes.content : current.content;
  await (await getReadyRawDb()).prepare(
    "UPDATE rule_configs SET name = ?, content = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'"
  ).bind(name, content, Date.now(), id).run();
  return getRuleConfig(id);
}

export async function deleteRuleConfig(id: string) {
  if (id === DEFAULT_RULE_CONFIG_ID) throw new Error("默认规则不能删除，请先新增并切换方案");
  const current = await getRuleConfig(id);
  if (!current) throw new Error("规则方案不存在");
  const db = await getReadyRawDb();
  await db.batch([
    db.prepare("UPDATE clash_profiles SET rule_config_id = 'default', updated_at = ? WHERE rule_config_id = ? AND status <> 'deleted'").bind(Date.now(), id),
    db.prepare("UPDATE rule_configs SET status = 'deleted', updated_at = ? WHERE id = ?").bind(Date.now(), id),
  ]);
}
