import { getReadyRawDb } from "../../db";

export const DEFAULT_RULE_CONFIG_ID = "default";

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
