import { getReadyRawDb } from "../../db";
import { buildShadowrocketRuleConfigFromClash } from "./clash-config";
import { getSourceSnapshot } from "./clash-links";
import { cloneRuleSetBindings, listRuleSetBindings, replaceRuleSetBindings } from "./rule-sets";
// @ts-expect-error Vite imports this bundled recovery asset as plain text.
import recoveryContent from "./haozi-recovery.conf?raw";

export const DEFAULT_RULE_CONFIG_ID = "default";
const HAOZI_RULE_CONFIG_ID = "haozi-custom";
const HAOZI_RULE_CONFIG_NAME = "MWPRO";
const HAOZI_LEGACY_RULE_CONFIG_NAME = "耗子专属";
const HAOZI_PROFILE_NAME = "耗子专用";
const MW_DEFAULT_TEMPLATE_MERGE_MIGRATION_ID = "rule-config:mw-default-template-merge-v1";
const GROUP_VISIBILITY_MIGRATION_ID = "rule-config:group-visibility-v1";
const PROTECTED_GROUP_KEYS = new Set(["proxies", "final", "cn"]);

export type RuleConfigRow = {
  id: string;
  name: string;
  content: string;
  status: "active" | "deleted";
  is_template_default: number;
  created_at: number;
  updated_at: number;
  profile_count?: number;
};

export type RuleGroupVisibilityRow = {
  rule_config_id: string;
  group_name: string;
  visible: number;
  created_at: number;
  updated_at: number;
};

export type RuleGroupVisibility = { groupName: string; visible: boolean };

export async function listRuleGroupVisibility(configId: string) {
  const result = await (await getReadyRawDb()).prepare(
    "SELECT rule_config_id, group_name, visible, created_at, updated_at FROM rule_group_settings WHERE rule_config_id = ? ORDER BY lower(group_name), group_name"
  ).bind(configId).all<RuleGroupVisibilityRow>();
  return result.results || [];
}

export async function replaceRuleGroupVisibility(configId: string, settings: RuleGroupVisibility[]) {
  const db = await getReadyRawDb();
  const hidden = new Map<string, string>();
  for (const setting of settings) {
    const groupName = String(setting.groupName || "").trim();
    if (!groupName || setting.visible !== false) continue;
    const key = groupName.toLowerCase();
    if (!hidden.has(key)) hidden.set(key, groupName);
  }
  const now = Date.now();
  await db.prepare("DELETE FROM rule_group_settings WHERE rule_config_id = ?").bind(configId).run();
  if (hidden.size) {
    await db.batch(Array.from(hidden.values()).map((groupName) => db.prepare(
      "INSERT INTO rule_group_settings (rule_config_id, group_name, visible, created_at, updated_at) VALUES (?, ?, 0, ?, ?)"
    ).bind(configId, groupName, now, now)));
  }
}

export async function migrateLegacyGroupVisibility() {
  const db = await getReadyRawDb();
  const marker = await db.prepare("SELECT id FROM rule_set_migrations WHERE id = ? LIMIT 1").bind(GROUP_VISIBILITY_MIGRATION_ID).first<{ id: string }>();
  if (marker) return;
  const legacyHidden = await db.prepare(
    "SELECT id FROM rule_sets WHERE status <> 'deleted' AND visible = 0 AND (lower(trim(name)) = lower(trim(?)) OR lower(trim(name)) = lower(trim(?))) LIMIT 1"
  ).bind("CN-国内直连（综合）", "CN国内直连").first<{ id: string }>();
  if (legacyHidden) {
    const configs = (await db.prepare("SELECT id FROM rule_configs WHERE status <> 'deleted'").all<{ id: string }>()).results || [];
    const now = Date.now();
    await db.batch(configs.map((config) => db.prepare(
      "INSERT OR IGNORE INTO rule_group_settings (rule_config_id, group_name, visible, created_at, updated_at) VALUES (?, 'CN', 0, ?, ?)"
    ).bind(config.id, now, now)));
  }
  await db.prepare("INSERT OR IGNORE INTO rule_set_migrations (id, version, created_at) VALUES (?, 1, ?)").bind(GROUP_VISIBILITY_MIGRATION_ID, Date.now()).run();
}

export async function getRuleConfig(id = DEFAULT_RULE_CONFIG_ID) {
  return (await getReadyRawDb()).prepare(
    "SELECT id, name, content, status, is_template_default, created_at, updated_at FROM rule_configs WHERE id = ? AND status <> 'deleted' LIMIT 1"
  ).bind(id).first<RuleConfigRow>();
}

export async function listRuleConfigs() {
  const result = await (await getReadyRawDb()).prepare(
    "SELECT rc.id, rc.name, rc.content, rc.status, rc.is_template_default, rc.created_at, rc.updated_at, COUNT(cp.id) AS profile_count FROM rule_configs rc LEFT JOIN clash_profiles cp ON cp.rule_config_id = rc.id AND cp.status <> 'deleted' WHERE rc.status <> 'deleted' GROUP BY rc.id ORDER BY CASE WHEN rc.id = 'default' THEN 0 ELSE 1 END, rc.created_at ASC"
  ).all<RuleConfigRow>();
  return result.results;
}

export async function ensureDefaultRuleConfig(content: string) {
  const existing = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  if (existing) return existing;
  const now = Date.now();
  await (await getReadyRawDb()).prepare(
    "INSERT INTO rule_configs (id, name, content, status, is_template_default, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)"
  ).bind(DEFAULT_RULE_CONFIG_ID, "默认规则", content, now, now).run();
  return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
}

function sectionBounds(content: string, sectionName: string) {
  const lines = content.split(/\r?\n/);
  const wanted = sectionName.toLowerCase();
  const start = lines.findIndex((line) => {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    return match?.[1].trim().toLowerCase() === wanted;
  });
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
}

function assignmentEntries(content: string, sectionName: string) {
  const bounds = sectionBounds(content, sectionName);
  const entries = new Map<string, { key: string; line: string }>();
  if (!bounds) return entries;
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = bounds.lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!entries.has(key)) entries.set(key, { key, line });
  }
  return entries;
}

function ruleKey(line: string) {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 2 || parts[0].toUpperCase() === "FINAL") return "";
  return `${parts[0].toUpperCase()}\u0000${parts[1].toLowerCase()}\u0000${parts.slice(3).map((part) => part.toLowerCase()).join(",")}`;
}

function ruleEntries(content: string) {
  const bounds = sectionBounds(content, "Rule");
  const entries = new Map<string, { key: string; line: string }>();
  if (!bounds) return entries;
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const line = bounds.lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const key = ruleKey(line);
    if (key && !entries.has(key)) entries.set(key, { key, line });
  }
  return entries;
}

function sameLine(left: string | undefined, right: string | undefined) {
  return (left || "").trim().replace(/\s+/g, " ") === (right || "").trim().replace(/\s+/g, " ");
}

function mergeMwContent(defaultContent: string, currentMwContent: string, recovery: string) {
  let content = defaultContent;
  const defaultGroups = assignmentEntries(defaultContent, "Proxy Group");
  const currentGroups = assignmentEntries(currentMwContent, "Proxy Group");
  const recoveryGroups = assignmentEntries(recovery, "Proxy Group");
  const preferredGroups = new Map<string, string>();
  const groupKeys = new Set([...defaultGroups.keys(), ...currentGroups.keys(), ...recoveryGroups.keys()]);
  for (const key of groupKeys) {
    const base = defaultGroups.get(key)?.line;
    const current = currentGroups.get(key)?.line;
    const restored = recoveryGroups.get(key)?.line;
    if (PROTECTED_GROUP_KEYS.has(key) && base) {
      preferredGroups.set(key, base);
    } else if (current && (!base || !sameLine(current, base))) {
      preferredGroups.set(key, current);
    } else if (restored && (!base || !sameLine(restored, base))) {
      preferredGroups.set(key, restored);
    } else if (base || current || restored) {
      preferredGroups.set(key, base || current || restored || "");
    }
  }
  const groupBounds = sectionBounds(content, "Proxy Group");
  if (groupBounds) {
    const lines = [...groupBounds.lines];
    const existing = new Set<string>();
    for (let index = groupBounds.start + 1; index < groupBounds.end; index += 1) {
      const line = lines[index].trim();
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      existing.add(key);
      const replacement = preferredGroups.get(key);
      if (replacement && !PROTECTED_GROUP_KEYS.has(key)) lines[index] = replacement;
    }
    const additions: string[] = [];
    for (const [key, line] of preferredGroups) {
      if (line && !existing.has(key)) additions.push(line);
    }
    lines.splice(groupBounds.end, 0, ...additions);
    content = lines.join(content.includes("\r\n") ? "\r\n" : "\n");
  }

  const defaultRules = ruleEntries(defaultContent);
  const currentRules = ruleEntries(currentMwContent);
  const recoveryRules = ruleEntries(recovery);
  const preferredRules = new Map<string, string>();
  const ruleKeys = new Set([...defaultRules.keys(), ...currentRules.keys(), ...recoveryRules.keys()]);
  for (const key of ruleKeys) {
    const base = defaultRules.get(key)?.line;
    const current = currentRules.get(key)?.line;
    const restored = recoveryRules.get(key)?.line;
    if (current && (!base || !sameLine(current, base))) preferredRules.set(key, current);
    else if (restored && (!base || !sameLine(restored, base))) preferredRules.set(key, restored);
    else if (base || current || restored) preferredRules.set(key, base || current || restored || "");
  }
  const ruleBounds = sectionBounds(content, "Rule");
  if (ruleBounds) {
    const lines = [...ruleBounds.lines];
    const existing = new Set<string>();
    let finalIndex = ruleBounds.end;
    for (let index = ruleBounds.start + 1; index < ruleBounds.end; index += 1) {
      const line = lines[index].trim();
      if (line.toUpperCase().startsWith("FINAL,")) {
        finalIndex = index;
        continue;
      }
      const key = ruleKey(line);
      if (!key) continue;
      existing.add(key);
      const replacement = preferredRules.get(key);
      if (replacement && !sameLine(replacement, line)) lines[index] = replacement;
    }
    const additions: string[] = [];
    for (const [key, line] of preferredRules) {
      if (line && !existing.has(key)) additions.push(line);
    }
    lines.splice(finalIndex, 0, ...additions);
    content = lines.join(content.includes("\r\n") ? "\r\n" : "\n");
  }
  return content;
}

async function findHaoziConfig() {
  const db = await getReadyRawDb();
  return (await getRuleConfig(HAOZI_RULE_CONFIG_ID)) || await db.prepare(
    "SELECT id, name, content, status, is_template_default, created_at, updated_at FROM rule_configs WHERE name = ? AND status <> 'deleted' LIMIT 1"
  ).bind(HAOZI_LEGACY_RULE_CONFIG_NAME).first<RuleConfigRow>();
}

/** Keep default as the only copy template across all scheme pages. */
export async function ensureDefaultRuleConfigTemplate() {
  const db = await getReadyRawDb();
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE rule_configs SET is_template_default = 0, updated_at = ? WHERE status <> 'deleted'").bind(now),
    db.prepare("UPDATE rule_configs SET is_template_default = 1, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(now, DEFAULT_RULE_CONFIG_ID),
  ]);
  return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
}

/** One-time migration: share default functionality while restoring MW-only content. */
export async function ensureMwDefaultTemplateMerge() {
  const db = await getReadyRawDb();
  const defaultConfig = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  const mwConfig = await findHaoziConfig();
  if (!defaultConfig || !mwConfig || mwConfig.id === DEFAULT_RULE_CONFIG_ID) return mwConfig || defaultConfig;
  const marker = await db.prepare("SELECT id FROM rule_set_migrations WHERE id = ? LIMIT 1").bind(MW_DEFAULT_TEMPLATE_MERGE_MIGRATION_ID).first<{ id: string }>();
  if (marker) return mwConfig;

  const mergedContent = mergeMwContent(defaultConfig.content, mwConfig.content, String(recoveryContent || ""));
  const defaultBindings = await listRuleSetBindings(defaultConfig.id);
  const mwBindings = await listRuleSetBindings(mwConfig.id);
  const bindings = mwBindings.map((item) => ({ groupName: item.group_name, ruleSetId: item.rule_set_id }));
  const existingBindingKeys = new Set(bindings.map((item) => `${item.groupName.toLowerCase()}\u0000${item.ruleSetId}`));
  const mwBindingGroups = new Set(bindings.map((item) => item.groupName.toLowerCase()));
  for (const item of defaultBindings) {
    // A MW group with its own rule-set selection is authoritative. Only copy
    // default bindings for groups that had no MW selection at all.
    if (mwBindingGroups.has(item.group_name.toLowerCase())) continue;
    const key = `${item.group_name.toLowerCase()}\u0000${item.rule_set_id}`;
    if (!existingBindingKeys.has(key)) {
      bindings.push({ groupName: item.group_name, ruleSetId: item.rule_set_id });
      existingBindingKeys.add(key);
    }
  }
  const now = Date.now();
  if (mergedContent !== mwConfig.content) {
    await db.prepare("UPDATE rule_configs SET content = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(mergedContent, now, mwConfig.id).run();
  }
  await replaceRuleSetBindings(mwConfig.id, bindings);
  await db.prepare("INSERT OR IGNORE INTO rule_set_migrations (id, version, created_at) VALUES (?, ?, ?)").bind(MW_DEFAULT_TEMPLATE_MERGE_MIGRATION_ID, 1, now).run();
  return getRuleConfig(mwConfig.id);
}

/**
 * Split the old single default scheme into the user's private scheme and the
 * new Flower-based default scheme. The migration is keyed by the stable
 * scheme ID, not its editable display name. Once the private scheme exists,
 * this function must never rewrite its name, content, or profile assignments.
 */
export async function ensureRuleConfigAssignments() {
  const db = await getReadyRawDb();
  const currentDefault = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  if (!currentDefault) return null;

  // The name is user-editable. Never use it as the migration identity, or a
  // later rename such as “MWPRO” would make the migration run again.
  let haozi = await getRuleConfig(HAOZI_RULE_CONFIG_ID);
  if (!haozi) {
    // Compatibility for a partially migrated database where the stable ID was
    // not created yet. This lookup is only used to adopt the legacy record;
    // once adopted, all later requests use the stable ID above.
    haozi = await db.prepare(
      "SELECT id, name, content, status, is_template_default, created_at, updated_at FROM rule_configs WHERE name = ? AND status <> 'deleted' LIMIT 1"
    ).bind(HAOZI_LEGACY_RULE_CONFIG_NAME).first<RuleConfigRow>();
  }

  if (haozi) {
    // This is the normal path. Existing user choices are authoritative: do
    // not rename the scheme, copy default content into it, or reset any
    // subscription bindings on every page load or config refresh.
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
  const haoziId = existingId?.id || HAOZI_RULE_CONFIG_ID;
  if (existingId) {
    await db.prepare(
      "UPDATE rule_configs SET name = ?, content = ?, status = 'active', updated_at = ? WHERE id = ?"
    ).bind(HAOZI_RULE_CONFIG_NAME, currentDefault.content, now, haoziId).run();
  } else {
    await db.prepare(
      "INSERT INTO rule_configs (id, name, content, status, is_template_default, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)"
    ).bind(haoziId, HAOZI_RULE_CONFIG_NAME, currentDefault.content, now, now).run();
  }

  await db.batch([
    db.prepare("UPDATE rule_configs SET name = ?, content = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind("默认规则", flowerContent, now, DEFAULT_RULE_CONFIG_ID),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name = ? AND status <> 'deleted'").bind(haoziId, now, HAOZI_PROFILE_NAME),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name <> ? AND status <> 'deleted'").bind(DEFAULT_RULE_CONFIG_ID, now, HAOZI_PROFILE_NAME),
  ]);
  return getRuleConfig(DEFAULT_RULE_CONFIG_ID);
}

/**
 * Restore the user's original private scheme from the local backup captured
 * before the old migration overwrote it. This is intentionally explicit and
 * separate from the normal startup path so a future page load can never
 * replace later user edits again.
 */
export async function restoreHaoziRuleConfig() {
  const db = await getReadyRawDb();
  const current = await getRuleConfig(HAOZI_RULE_CONFIG_ID);
  if (!current) throw new Error("找不到 MWPRO 方案");
  const content = String(recoveryContent || "").trim();
  if (!content.includes("[Proxy Group]") || !content.includes("[Rule]")) {
    throw new Error("本地恢复文件缺少必要配置段");
  }
  const now = Date.now();
  await db.batch([
    db.prepare("UPDATE rule_configs SET name = ?, content = ?, status = 'active', updated_at = ? WHERE id = ?").bind("MWPRO", content, now, HAOZI_RULE_CONFIG_ID),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name = ? AND status <> 'deleted'").bind(HAOZI_RULE_CONFIG_ID, now, HAOZI_PROFILE_NAME),
    db.prepare("UPDATE clash_profiles SET rule_config_id = ?, updated_at = ? WHERE name <> ? AND status <> 'deleted'").bind(DEFAULT_RULE_CONFIG_ID, now, HAOZI_PROFILE_NAME),
  ]);
  return getRuleConfig(HAOZI_RULE_CONFIG_ID);
}

export async function createRuleConfig(name: string, content: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeName = name.trim().slice(0, 80) || "规则方案";
  await (await getReadyRawDb()).prepare(
    "INSERT INTO rule_configs (id, name, content, status, is_template_default, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)"
  ).bind(id, safeName, content, now, now).run();
  const template = await getRuleConfig(DEFAULT_RULE_CONFIG_ID);
  if (template?.id && template.id !== id) {
    await cloneRuleSetBindings(template.id, id);
    const visibility = await listRuleGroupVisibility(template.id);
    if (visibility.length) {
      await replaceRuleGroupVisibility(id, visibility.map((row) => ({
        groupName: row.group_name,
        visible: row.visible !== 0,
      })));
    }
  }
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

export async function setRuleConfigTemplateDefault(id: string) {
  const current = await getRuleConfig(id);
  if (!current) throw new Error("规则方案不存在");
  if (id !== DEFAULT_RULE_CONFIG_ID) throw new Error("默认方案固定作为新方案模板，不能切换");
  return ensureDefaultRuleConfigTemplate();
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
  await ensureDefaultRuleConfigTemplate();
}
