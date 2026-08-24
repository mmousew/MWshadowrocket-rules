import { getReadyRawDb } from "../../db";

export const TEMP_RULE_TYPES = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "RULE-SET",
  "GEOSITE",
  "IP-CIDR",
  "IP-CIDR6",
  "GEOIP",
] as const;

export type TempRuleInput = {
  configId: string;
  groupName: string;
  type: string;
  value: string;
  policy?: string;
  options?: string[];
};

export type TempRuleRow = {
  id: string;
  rule_config_id: string;
  group_name: string;
  type: string;
  value: string;
  policy: string;
  options: string;
  created_at: number;
  updated_at: number;
};

export type TempRuleClient = {
  id: string;
  configId: string;
  groupName: string;
  type: string;
  value: string;
  policy: string;
  options: string[];
  createdAt: number;
  updatedAt: number;
};

function cleanOptions(options: unknown) {
  if (!Array.isArray(options)) return [];
  return options.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
}

function parseOptions(raw: string) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return cleanOptions(parsed);
  } catch {
    return [];
  }
}

export function tempRuleToClient(row: TempRuleRow): TempRuleClient {
  return {
    id: row.id,
    configId: row.rule_config_id,
    groupName: row.group_name,
    type: row.type,
    value: row.value,
    policy: row.policy,
    options: parseOptions(row.options),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeInput(input: TempRuleInput) {
  const configId = String(input.configId || "").trim();
  const groupName = String(input.groupName || "").trim();
  const type = String(input.type || "").trim().toUpperCase();
  const value = String(input.value || "").trim();
  const policy = String(input.policy || groupName).trim() || groupName;
  if (!configId || !groupName) throw new Error("缺少方案或分组");
  if (!(TEMP_RULE_TYPES as readonly string[]).includes(type)) throw new Error(`不支持的临时规则类型：${type}`);
  if (!value) throw new Error("临时规则内容不能为空");
  if (value.length > 2048) throw new Error("临时规则内容过长");
  return { configId, groupName, type, value, policy, options: cleanOptions(input.options) };
}

export async function listGroupTempRules(configId: string, groupName?: string) {
  const db = await getReadyRawDb();
  const normalizedConfigId = String(configId || "").trim();
  if (!normalizedConfigId) return [] as TempRuleClient[];
  const rows = groupName
    ? await db.prepare("SELECT id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at FROM group_temp_rules WHERE rule_config_id = ? AND LOWER(group_name) = LOWER(?) ORDER BY created_at ASC, id ASC").bind(normalizedConfigId, String(groupName).trim()).all<TempRuleRow>()
    : await db.prepare("SELECT id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at FROM group_temp_rules WHERE rule_config_id = ? ORDER BY created_at ASC, id ASC").bind(normalizedConfigId).all<TempRuleRow>();
  return (rows.results || []).map(tempRuleToClient);
}

export async function createGroupTempRule(input: TempRuleInput) {
  const value = normalizeInput(input);
  const db = await getReadyRawDb();
  const duplicate = await db.prepare("SELECT id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at FROM group_temp_rules WHERE rule_config_id = ? AND LOWER(group_name) = LOWER(?) AND type = ? AND value = ? AND options = ? LIMIT 1").bind(value.configId, value.groupName, value.type, value.value, JSON.stringify(value.options)).first<TempRuleRow>();
  if (duplicate) return tempRuleToClient(duplicate);
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO group_temp_rules (id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, value.configId, value.groupName, value.type, value.value, value.policy, JSON.stringify(value.options), now, now).run();
  const created = await db.prepare("SELECT id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at FROM group_temp_rules WHERE id = ? LIMIT 1").bind(id).first<TempRuleRow>();
  if (!created) throw new Error("临时规则保存失败");
  return tempRuleToClient(created);
}

export async function updateGroupTempRule(id: string, input: Omit<TempRuleInput, "configId" | "groupName"> & { configId: string; groupName: string }) {
  const value = normalizeInput(input);
  const db = await getReadyRawDb();
  const existing = await db.prepare("SELECT id FROM group_temp_rules WHERE id = ? AND rule_config_id = ? LIMIT 1").bind(String(id || ""), value.configId).first<{ id: string }>();
  if (!existing) throw new Error("找不到这条临时规则");
  const duplicate = await db.prepare("SELECT id FROM group_temp_rules WHERE rule_config_id = ? AND LOWER(group_name) = LOWER(?) AND type = ? AND value = ? AND options = ? AND id <> ? LIMIT 1").bind(value.configId, value.groupName, value.type, value.value, JSON.stringify(value.options), id).first<{ id: string }>();
  if (duplicate) throw new Error("当前分组已经有相同的临时规则");
  const now = Date.now();
  await db.prepare("UPDATE group_temp_rules SET group_name = ?, type = ?, value = ?, policy = ?, options = ?, updated_at = ? WHERE id = ? AND rule_config_id = ?").bind(value.groupName, value.type, value.value, value.policy, JSON.stringify(value.options), now, id, value.configId).run();
  const updated = await db.prepare("SELECT id, rule_config_id, group_name, type, value, policy, options, created_at, updated_at FROM group_temp_rules WHERE id = ? LIMIT 1").bind(id).first<TempRuleRow>();
  if (!updated) throw new Error("临时规则更新失败");
  return tempRuleToClient(updated);
}

export async function deleteGroupTempRule(id: string, configId: string) {
  const db = await getReadyRawDb();
  await db.prepare("DELETE FROM group_temp_rules WHERE id = ? AND rule_config_id = ?").bind(String(id || ""), String(configId || "").trim()).run();
}
