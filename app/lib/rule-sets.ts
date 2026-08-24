import { getReadyRawDb } from "../../db";
import { dedupeEntries, normalizePlatformSources, parseRuleSetEntries, type RuleSetEntry, type RuleSetPlatformSources } from "./rule-set-core";

export type RuleSetRow = { id: string; name: string; description: string; kind: string; entries: RuleSetEntry[]; platformSources: RuleSetPlatformSources; source: string; status: string; visible: number; enabled: number; sort_order: number; created_at: number; updated_at: number };
export type RuleSetBindingRow = { id: string; rule_config_id: string; group_name: string; rule_set_id: string; sort_order: number; created_at: number; updated_at: number };
export type RuleSetUsageRow = { rule_set_id: string; rule_config_id: string; config_name: string; group_names: string[] };

const MIGRATION_ID = "rule-set-library-v1";
const DEDUPE_MIGRATION_ID = "rule-set-library-dedupe-v1";
export const CHINA_DIRECT_RULE_SET_NAME = "CN-国内直连（综合）";
const CHINA_DIRECT_RULE_SET_ALIASES = [CHINA_DIRECT_RULE_SET_NAME, "CN国内直连"];
const SEED_NAMES = ["YouTube", "Disney", "Hbomax", "Netflix", "Bahamut", "Bilibili", "Spotify", "Steam", "Telegram", "Google", "Microsoft", "OpenAI", "PayPal", "TIKTOK", "Apple", "UK", "CA", "KR", "CN", "DE", "JP", "SG", "TW", "US", "HK"];
const CHINA_SHADOWROCKET_URL = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMax/ChinaMax.list";
const CHINA_SHADOWROCKET_DOMAIN_URL = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMax/ChinaMax_Domain.list";
const CHINA_CLASH_DIRECT_URL = "https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt";
const CHINA_CLASH_CNCIDR_URL = "https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/cncidr.txt";
const CHINA_DIRECT_SOURCE_PAGE = "https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/ChinaMax";
const CHINA_DIRECT_PLATFORM_SOURCES: RuleSetPlatformSources = {
  shadowrocket: [
    ...parseRuleSetEntries(`RULE-SET,${CHINA_SHADOWROCKET_URL}`),
    ...parseRuleSetEntries(`DOMAIN-SET,${CHINA_SHADOWROCKET_DOMAIN_URL}`),
  ],
  clash: [
    ...parseRuleSetEntries(`RULE-SET,${CHINA_CLASH_DIRECT_URL}`),
    ...parseRuleSetEntries(`RULE-SET,${CHINA_CLASH_CNCIDR_URL}`),
  ],
};
const CHINA_DIRECT_ENTRIES: RuleSetEntry[] = CHINA_DIRECT_PLATFORM_SOURCES.shadowrocket || [];

function mapRow(row: Omit<RuleSetRow, "entries" | "platformSources"> & { entries: string; platform_sources?: string }) {
  let entries: RuleSetEntry[] = [];
  try { entries = parseRuleSetEntries(JSON.parse(row.entries || "[]")); } catch { entries = parseRuleSetEntries(row.entries || ""); }
  return { ...row, platformSources: normalizePlatformSources(row.platform_sources), entries };
}

function toClient(row: RuleSetRow | { id: string; name: string; description: string; kind: string; entries: RuleSetEntry[]; platformSources?: RuleSetPlatformSources; source: string; status: string; visible?: number | boolean; enabled?: number | boolean; sortOrder: number; createdAt: number; updatedAt: number }) {
  const source = "sort_order" in row ? { sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at } : { sortOrder: row.sortOrder, createdAt: row.createdAt, updatedAt: row.updatedAt };
  return { id: row.id, name: row.name, description: row.description, kind: row.kind, entries: row.entries, platformSources: row.platformSources || {}, source: row.source, status: row.status, visible: row.visible !== false && row.visible !== 0, enabled: row.enabled !== false && row.enabled !== 0, isBuiltin: row.kind === "builtin", entryCount: row.entries.length, ...source };
}

export async function listRuleSets() {
  const result = await (await getReadyRawDb()).prepare("SELECT id, name, description, kind, entries, platform_sources, source, status, visible, enabled, sort_order, created_at, updated_at FROM rule_sets WHERE status <> 'deleted' ORDER BY sort_order ASC, created_at ASC").all<Omit<RuleSetRow, "entries" | "platformSources"> & { entries: string; platform_sources?: string }>();
  return result.results.map(mapRow);
}

export async function listRuleSetBindings(configId: string) {
  const result = await (await getReadyRawDb()).prepare("SELECT id, rule_config_id, group_name, rule_set_id, sort_order, created_at, updated_at FROM rule_set_bindings WHERE rule_config_id = ? ORDER BY group_name COLLATE NOCASE, sort_order ASC, created_at ASC, id ASC").bind(configId).all<RuleSetBindingRow>();
  return result.results;
}

export async function listRuleSetUsages() {
  const result = await (await getReadyRawDb()).prepare("SELECT b.rule_set_id, b.rule_config_id, c.name AS config_name, b.group_name FROM rule_set_bindings b INNER JOIN rule_configs c ON c.id = b.rule_config_id AND c.status <> 'deleted' ORDER BY c.name COLLATE NOCASE, b.group_name COLLATE NOCASE").all<{ rule_set_id: string; rule_config_id: string; config_name: string; group_name: string }>();
  const usages = new Map<string, RuleSetUsageRow>();
  for (const item of result.results) {
    const key = `${item.rule_set_id}\u0000${item.rule_config_id}`;
    const current = usages.get(key) || { rule_set_id: item.rule_set_id, rule_config_id: item.rule_config_id, config_name: item.config_name, group_names: [] };
    if (!current.group_names.some((name) => name.toLowerCase() === item.group_name.toLowerCase())) current.group_names.push(item.group_name);
    usages.set(key, current);
  }
  return Array.from(usages.values());
}

export async function replaceRuleSetBindings(configId: string, bindings: Array<{ groupName: string; ruleSetId: string }>) {
  const db = await getReadyRawDb();
  // Older databases may still have the former one-binding-per-group index.
  // Remove it here too so a save can immediately persist multiple rule sets.
  await db.prepare("DROP INDEX IF EXISTS rule_set_bindings_config_group_unique_idx").run();
  const clean: Array<{ groupName: string; ruleSetId: string }> = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const groupName = String(binding.groupName || "").trim();
    const ruleSetId = String(binding.ruleSetId || "").trim();
    const key = `${groupName.toLowerCase()}\u0000${ruleSetId}`;
    if (groupName && ruleSetId && !seen.has(key)) {
      seen.add(key);
      clean.push({ groupName, ruleSetId });
    }
  }
  const now = Date.now();
  await db.prepare("DELETE FROM rule_set_bindings WHERE rule_config_id = ?").bind(configId).run();
  if (clean.length) await db.batch(clean.map((binding, sortOrder) => db.prepare("INSERT INTO rule_set_bindings (id, rule_config_id, group_name, rule_set_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), configId, binding.groupName, binding.ruleSetId, sortOrder, now, now)));
  return listRuleSetBindings(configId);
}

export async function cloneRuleSetBindings(fromConfigId: string, toConfigId: string) {
  const bindings = await listRuleSetBindings(fromConfigId);
  return replaceRuleSetBindings(toConfigId, bindings.map((item) => ({ groupName: item.group_name, ruleSetId: item.rule_set_id })));
}

export async function createRuleSet(input: { name: string; description?: string; entries: string | RuleSetEntry[]; platformSources?: RuleSetPlatformSources | string; source?: string }) {
  const db = await getReadyRawDb();
  const now = Date.now();
  const entries = parseRuleSetEntries(input.entries);
  const count = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM rule_sets WHERE status <> 'deleted'").first<{ value: number }>();
  const name = input.name.trim().slice(0, 100) || "规则集";
  const duplicate = await db.prepare("SELECT id FROM rule_sets WHERE lower(trim(name)) = lower(trim(?)) AND status <> 'deleted' LIMIT 1").bind(name).first<{ id: string }>();
  if (duplicate) throw new Error("规则集名称已存在，请直接编辑现有规则集");
  const platformSources = normalizePlatformSources(input.platformSources);
  const row = { id: crypto.randomUUID(), name, description: String(input.description || "").trim().slice(0, 300), kind: "managed", entries, platformSources, source: String(input.source || "").trim().slice(0, 500), status: "active", sortOrder: Number(count?.value || -1) + 1, createdAt: now, updatedAt: now };
  await db.prepare("INSERT INTO rule_sets (id, name, description, kind, entries, platform_sources, source, status, visible, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)").bind(row.id, row.name, row.description, row.kind, JSON.stringify(row.entries), JSON.stringify(row.platformSources), row.source, row.status, row.sortOrder, now, now).run();
  return row;
}

export async function updateRuleSet(id: string, input: { name?: string; description?: string; entries?: string | RuleSetEntry[]; platformSources?: RuleSetPlatformSources | string; source?: string; visible?: boolean; enabled?: boolean }) {
  const current = (await listRuleSets()).find((row) => row.id === id);
  if (!current) throw new Error("规则集不存在");
  if (current.kind === "builtin" && input.name !== undefined && input.name.trim() !== current.name) throw new Error("系统规则集名称不能修改");
  const entries = input.entries === undefined ? current.entries : parseRuleSetEntries(input.entries);
  const platformSources = input.platformSources === undefined ? current.platformSources : normalizePlatformSources(input.platformSources);
  const db = await getReadyRawDb();
  const name = input.name === undefined ? current.name : input.name.trim().slice(0, 100) || current.name;
  const duplicate = await db.prepare("SELECT id FROM rule_sets WHERE lower(trim(name)) = lower(trim(?)) AND id <> ? AND status <> 'deleted' LIMIT 1").bind(name, id).first<{ id: string }>();
  if (duplicate) throw new Error("规则集名称已存在，请直接编辑现有规则集");
  const row = { ...current, name, description: input.description === undefined ? current.description : String(input.description).trim().slice(0, 300), source: input.source === undefined ? current.source : String(input.source).trim().slice(0, 500), entries, platformSources, visible: input.visible === undefined ? current.visible : Number(input.visible), enabled: input.enabled === undefined ? current.enabled : Number(input.enabled), updatedAt: Date.now() };
  await db.prepare("UPDATE rule_sets SET name = ?, description = ?, entries = ?, platform_sources = ?, source = ?, visible = ?, enabled = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(row.name, row.description, JSON.stringify(row.entries), JSON.stringify(row.platformSources), row.source, row.visible, row.enabled, row.updatedAt, id).run();
  return row;
}

export async function deleteRuleSet(id: string) {
  const db = await getReadyRawDb();
  const current = await db.prepare("SELECT name, kind FROM rule_sets WHERE id = ? AND status <> 'deleted' LIMIT 1").bind(id).first<{ name: string; kind: string }>();
  if (current?.kind === "builtin" || CHINA_DIRECT_RULE_SET_ALIASES.some((name) => current?.name?.trim().toLowerCase() === name.toLowerCase())) throw new Error("系统内置规则集不可删除，请使用隐藏或停用");
  const referenced = await db.prepare("SELECT rule_config_id, group_name FROM rule_set_bindings WHERE rule_set_id = ? ORDER BY rule_config_id, group_name").bind(id).all<{ rule_config_id: string; group_name: string }>();
  if (referenced.results.length) throw new Error(`规则集仍被使用：${referenced.results.map((item) => `${item.rule_config_id}/${item.group_name}`).join("、")}`);
  await db.prepare("UPDATE rule_sets SET status = 'deleted', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

function extractSchemeRuleSets(content: string) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[Rule]");
  if (start < 0) return new Map<string, RuleSetEntry[]>();
  const result = new Map<string, RuleSetEntry[]>();
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) break;
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 3 || parts[0].toUpperCase() === "FINAL") continue;
    const entry = parseRuleSetEntries(parts.slice(0, 2).join(","))[0];
    if (!entry) continue;
    const policy = parts[2];
    const list = result.get(policy.toLowerCase()) || [];
    list.push({ ...entry, options: parts.slice(3).filter(Boolean) });
    result.set(policy.toLowerCase(), list);
  }
  return result;
}

function findPolicyName(content: string, policyKey: string) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) break;
    const match = lines[index].match(/^\s*([^=]+?)\s*=\s*/);
    if (match && match[1].trim().toLowerCase() === policyKey) return match[1].trim();
  }
  return policyKey;
}

type ReadyDb = Awaited<ReturnType<typeof getReadyRawDb>>;

async function insertSeedRuleSet(db: ReadyDb, name: string, entries: RuleSetEntry[], description = "", source = "", kind = "managed", platformSources: RuleSetPlatformSources = {}) {
  const existing = await db.prepare("SELECT id FROM rule_sets WHERE lower(name) = lower(?) AND status <> 'deleted' LIMIT 1").bind(name).first<{ id: string }>();
  if (existing) return existing.id;
  const now = Date.now();
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM rule_sets WHERE status <> 'deleted'").first<{ value: number }>();
  const id = crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO rule_sets (id, name, description, kind, entries, platform_sources, source, status, visible, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?, ?)").bind(id, name, description, kind, JSON.stringify(entries), JSON.stringify(platformSources), source, Number(max?.value || -1) + 1, now, now).run();
  const inserted = await db.prepare("SELECT id FROM rule_sets WHERE lower(name) = lower(?) AND status <> 'deleted' LIMIT 1").bind(name).first<{ id: string }>();
  return inserted?.id || id;
}

async function dedupeRuleSetLibrary(db: ReadyDb) {
  // Older deployments created a unique (config, group) index when one group
  // could only call one rule set. Drop it on every request before any write;
  // otherwise the new multi-select binding cannot be persisted.
  await db.prepare("DROP INDEX IF EXISTS rule_set_bindings_config_group_unique_idx").run();
  const marker = await db.prepare("SELECT id FROM rule_set_migrations WHERE id = ? LIMIT 1").bind(DEDUPE_MIGRATION_ID).first<{ id: string }>();
  if (marker) return;

  const sets = (await db.prepare("SELECT id, name, description, entries, platform_sources, source, updated_at, created_at FROM rule_sets WHERE status <> 'deleted' ORDER BY lower(name), updated_at DESC, created_at DESC, id ASC").all<{ id: string; name: string; description: string; entries: string; platform_sources?: string; source: string; updated_at: number; created_at: number }>()).results;
  const byName = new Map<string, typeof sets>();
  for (const set of sets) {
    const key = set.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) || []), set]);
  }

  for (const sameNameSets of byName.values()) {
    if (sameNameSets.length < 2) continue;
    const canonical = sameNameSets[0];
    const mergedEntries = dedupeEntries(sameNameSets.flatMap((set) => {
      try { return parseRuleSetEntries(JSON.parse(set.entries || "[]")); } catch { return parseRuleSetEntries(set.entries || ""); }
    }));
    const mergedPlatformSources: RuleSetPlatformSources = {};
    for (const platform of ["shadowrocket", "clash"] as const) {
      const merged = dedupeEntries(sameNameSets.flatMap((set) => normalizePlatformSources(set.platform_sources)[platform] || []));
      if (merged.length) mergedPlatformSources[platform] = merged;
    }
    const description = sameNameSets.map((set) => set.description.trim()).find(Boolean) || "";
    const source = sameNameSets.map((set) => set.source.trim()).find(Boolean) || "";
    await db.prepare("UPDATE rule_sets SET entries = ?, platform_sources = ?, description = ?, source = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(JSON.stringify(mergedEntries), JSON.stringify(mergedPlatformSources), description, source, Date.now(), canonical.id).run();
    for (const duplicate of sameNameSets.slice(1)) {
      await db.prepare("UPDATE rule_set_bindings SET rule_set_id = ? WHERE rule_set_id = ?").bind(canonical.id, duplicate.id).run();
      await db.prepare("UPDATE rule_sets SET status = 'deleted', updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(Date.now(), duplicate.id).run();
    }
  }

  const bindings = (await db.prepare("SELECT id, rule_config_id, group_name, rule_set_id, sort_order, updated_at, created_at FROM rule_set_bindings ORDER BY rule_config_id, lower(group_name), sort_order ASC, updated_at DESC, created_at DESC, id ASC").all<{ id: string; rule_config_id: string; group_name: string; rule_set_id: string; sort_order: number; updated_at: number; created_at: number }>()).results;
  const seenBindings = new Set<string>();
  const duplicateBindingIds: string[] = [];
  for (const binding of bindings) {
    const key = `${binding.rule_config_id}\u0000${binding.group_name.trim().toLowerCase()}\u0000${binding.rule_set_id}`;
    if (seenBindings.has(key)) duplicateBindingIds.push(binding.id);
    else seenBindings.add(key);
  }
  if (duplicateBindingIds.length) await db.batch(duplicateBindingIds.map((id) => db.prepare("DELETE FROM rule_set_bindings WHERE id = ?").bind(id)));

  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS rule_sets_active_name_unique_idx ON rule_sets (name COLLATE NOCASE) WHERE status <> 'deleted'").run();
  await db.prepare("INSERT OR IGNORE INTO rule_set_migrations (id, version, created_at) VALUES (?, 1, ?)").bind(DEDUPE_MIGRATION_ID, Date.now()).run();
}

function ensureProxyGroup(content: string, line: string) {
  const name = line.split("=")[0].trim().toLowerCase();
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((item) => item.trim().toLowerCase() === "[proxy group]");
  if (start >= 0) {
    const end = (() => {
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) return index;
      }
      return lines.length;
    })();
    const proxyLines: string[] = [];
    let inserted = false;
    let changed = false;
    for (let index = start + 1; index < end; index += 1) {
      const current = lines[index];
      const match = lines[index].match(/^\s*([^=]+?)\s*=\s*/);
      if (match && match[1].trim().toLowerCase() === name) {
        if (!inserted) {
          proxyLines.push(line);
          inserted = true;
          if (current.trim() !== line.trim()) changed = true;
        } else {
          changed = true;
        }
      } else {
        proxyLines.push(current);
      }
    }
    if (!inserted) {
      proxyLines.push(line);
      changed = true;
    }
    if (!changed) return content;
    return [...lines.slice(0, start + 1), ...proxyLines, ...lines.slice(end)].join("\n");
  }
  const ruleIndex = lines.findIndex((item) => item.trim() === "[Rule]");
  if (ruleIndex >= 0) {
    lines.splice(ruleIndex, 0, line, "");
    return lines.join("\n");
  }
  return `${content.replace(/\s*$/, "")}\n\n[Proxy Group]\n${line}\n`;
}

async function ensureChinaDirectRuleSet(db: ReadyDb) {
  const candidates = (await db.prepare(
    "SELECT id, name, entries, platform_sources, source, description, status, visible, enabled, updated_at, created_at FROM rule_sets WHERE lower(trim(name)) = lower(trim(?)) OR lower(trim(name)) = lower(trim(?)) ORDER BY updated_at DESC, created_at DESC, id ASC"
  ).bind(CHINA_DIRECT_RULE_SET_ALIASES[0], CHINA_DIRECT_RULE_SET_ALIASES[1]).all<{ id: string; name: string; entries: string; platform_sources?: string; source: string; description: string; status: string; visible: number; enabled: number; updated_at: number; created_at: number }>()).results;

  // Only aliases with the protected name are merged. A different rule set
  // intentionally bound to CN must remain an independent binding.
  const relatedIds = Array.from(new Set(candidates.map((item) => item.id)));

  const activeCanonical = candidates.find((row) => row.status !== "deleted" && row.name.trim().toLowerCase() === CHINA_DIRECT_RULE_SET_NAME.toLowerCase());
  const activeAlias = candidates.find((row) => row.status !== "deleted");
  const deletedCanonical = candidates.find((row) => row.name.trim().toLowerCase() === CHINA_DIRECT_RULE_SET_NAME.toLowerCase());
  const chosen = activeCanonical || activeAlias || deletedCanonical;
  const now = Date.now();
  let chosenId = chosen?.id || "";

  if (!chosenId) {
    chosenId = await insertSeedRuleSet(db, CHINA_DIRECT_RULE_SET_NAME, CHINA_DIRECT_ENTRIES, "中国大陆直连综合规则；小火箭与 Clash 使用各自适配的官方规则来源。", CHINA_DIRECT_SOURCE_PAGE, "builtin", CHINA_DIRECT_PLATFORM_SOURCES);
  } else {
    // Keep one protected canonical row and reset its platform sources to the
    // known-good formats. Do not merge legacy China/ACL entries back in:
    // those historical duplicates were the source of repeated and conflicting
    // domestic routes.
    await db.prepare("UPDATE rule_sets SET name = ?, description = ?, kind = 'builtin', entries = ?, platform_sources = ?, source = ?, status = 'active', visible = CASE WHEN status = 'deleted' THEN 1 ELSE visible END, enabled = CASE WHEN status = 'deleted' THEN 1 ELSE enabled END, updated_at = ? WHERE id = ?").bind(CHINA_DIRECT_RULE_SET_NAME, "中国大陆直连综合规则；小火箭与 Clash 使用各自适配的官方规则来源。", JSON.stringify(CHINA_DIRECT_ENTRIES), JSON.stringify(CHINA_DIRECT_PLATFORM_SOURCES), CHINA_DIRECT_SOURCE_PAGE, now, chosenId).run();
  }

  const otherIds = relatedIds.filter((id) => id !== chosenId);
  if (otherIds.length) {
    await db.batch([
      db.prepare(`UPDATE rule_set_bindings SET rule_set_id = ?, updated_at = ? WHERE rule_set_id IN (${otherIds.map(() => "?").join(",")})`).bind(chosenId, now, ...otherIds),
      db.prepare(`UPDATE rule_sets SET status = 'deleted', updated_at = ? WHERE id IN (${otherIds.map(() => "?").join(",")})`).bind(now, ...otherIds),
    ]);
  }
  return chosenId;
}

async function ensureChinaDirectBindings(db: ReadyDb, chinaRuleSetId: string) {
  const configs = (await db.prepare("SELECT id, content FROM rule_configs WHERE status <> 'deleted' ORDER BY created_at ASC").all<{ id: string; content: string }>()).results;
  const contentUpdates = [] as Array<ReturnType<typeof db.prepare>>;
  for (const config of configs) {
    const updatedContent = ensureProxyGroup(config.content, "CN = select,DIRECT");
    if (updatedContent !== config.content) {
      contentUpdates.push(db.prepare("UPDATE rule_configs SET content = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(updatedContent, Date.now(), config.id));
    }
  }
  if (contentUpdates.length) await db.batch(contentUpdates);

  for (const config of configs) {

    const bindings = (await db.prepare("SELECT id, rule_set_id, group_name, sort_order, created_at, updated_at FROM rule_set_bindings WHERE rule_config_id = ? AND lower(trim(group_name)) = 'cn' ORDER BY sort_order ASC, updated_at DESC, created_at DESC, id ASC").bind(config.id).all<{ id: string; rule_set_id: string; group_name: string; sort_order: number; created_at: number; updated_at: number }>()).results;
    const seenRuleSetIds = new Set<string>();
    const uniqueBindings = bindings.filter((binding) => {
      if (!binding.rule_set_id || seenRuleSetIds.has(binding.rule_set_id)) return false;
      seenRuleSetIds.add(binding.rule_set_id);
      return true;
    });
    const duplicateBindings = bindings.filter((binding) => !uniqueBindings.some((item) => item.id === binding.id));
    const keep = uniqueBindings.find((binding) => binding.rule_set_id === chinaRuleSetId) || uniqueBindings[0];
    const now = Date.now();
    if (duplicateBindings.length) {
      await db.batch(duplicateBindings.map((binding) => db.prepare("DELETE FROM rule_set_bindings WHERE id = ?").bind(binding.id)));
    }
    if (keep) {
      await db.prepare("UPDATE rule_set_bindings SET group_name = 'CN', rule_set_id = ?, sort_order = ?, updated_at = ? WHERE id = ?").bind(chinaRuleSetId, keep.sort_order || 0, now, keep.id).run();
    } else {
      await db.prepare("INSERT OR IGNORE INTO rule_set_bindings (id, rule_config_id, group_name, rule_set_id, sort_order, created_at, updated_at) VALUES (?, ?, 'CN', ?, 0, ?, ?)").bind(crypto.randomUUID(), config.id, chinaRuleSetId, now, now).run();
    }
  }
}

/**
 * Repair the protected domestic-direct set and bind it to every active scheme.
 *
 * This is intentionally idempotent and does not depend on migration markers:
 * users may rename, hide, disable, or otherwise edit the set, while the
 * system still needs to keep its identity protected and the default CN route
 * pointed at the same row.
 */
export async function repairChinaDirectState() {
  const db = await getReadyRawDb();
  const chinaRuleSetId = await ensureChinaDirectRuleSet(db);
  await ensureChinaDirectBindings(db, chinaRuleSetId);
  const ruleSet = await db.prepare(
    "SELECT id, name, kind, status, visible, enabled FROM rule_sets WHERE id = ? LIMIT 1"
  ).bind(chinaRuleSetId).first<{ id: string; name: string; kind: string; status: string; visible: number; enabled: number }>();
  const bindings = (await db.prepare(
    "SELECT rule_config_id, group_name, rule_set_id FROM rule_set_bindings WHERE rule_set_id = ? AND lower(trim(group_name)) = 'cn' ORDER BY rule_config_id"
  ).bind(chinaRuleSetId).all<{ rule_config_id: string; group_name: string; rule_set_id: string }>()).results;
  return { chinaRuleSetId, ruleSet, bindings };
}

export async function ensureRuleSetLibrary() {
  const db = await getReadyRawDb();
  // Keep the default CN repair independent from the larger library migration.
  // A legacy duplicate, an old index, or malformed historical rule content
  // must not make the repair disappear behind the route's compatibility
  // fallback.
  let chinaRuleSetId = "";
  try {
    const repaired = await repairChinaDirectState();
    chinaRuleSetId = repaired.chinaRuleSetId;
  } catch (error) {
    console.error("[rule-sets] all-scheme CN repair failed", error);
  }
  try {
    await dedupeRuleSetLibrary(db);
  } catch (error) {
    console.error("[rule-sets] dedupe migration skipped", error);
  }
  const marker = await db.prepare("SELECT id FROM rule_set_migrations WHERE id = ? LIMIT 1").bind(MIGRATION_ID).first<{ id: string }>();
  if (!marker) {
    // The initial library is a one-time migration. Do not run these seed
    // inserts on every read, otherwise a user-deleted preset is recreated
    // the next time the library or a subscription is loaded.
    const configs = (await db.prepare("SELECT id, name, content FROM rule_configs WHERE status <> 'deleted' ORDER BY created_at ASC").all<{ id: string; name: string; content: string }>()).results;
    const schemeSets = new Map<string, Map<string, string>>();
    for (const config of configs) {
      const extracted = extractSchemeRuleSets(config.content);
      const bindingMap = new Map<string, string>();
      for (const [policyKey, entries] of extracted) {
        const policyName = findPolicyName(config.content, policyKey);
        const setId = await insertSeedRuleSet(db, policyName, entries, `从「${config.name}」迁移的规则集`);
        bindingMap.set(policyKey, setId);
      }
      schemeSets.set(config.id, bindingMap);
    }
    for (const name of SEED_NAMES) await insertSeedRuleSet(db, name, [], "预置规则集，可在这里编辑");
    await insertSeedRuleSet(db, CHINA_DIRECT_RULE_SET_NAME, CHINA_DIRECT_ENTRIES, "中国大陆直连综合规则；小火箭与 Clash 使用各自适配的官方规则来源。", CHINA_DIRECT_SOURCE_PAGE, "builtin", CHINA_DIRECT_PLATFORM_SOURCES);
    for (const [configId, bindings] of schemeSets) {
      const existing = await listRuleSetBindings(configId);
      if (existing.length) continue;
      await replaceRuleSetBindings(configId, Array.from(bindings.entries()).map(([groupName, ruleSetId]) => ({ groupName, ruleSetId })));
    }
    await db.prepare("INSERT OR IGNORE INTO rule_set_migrations (id, version, created_at) VALUES (?, 1, ?)").bind(MIGRATION_ID, Date.now()).run();
  }
  if (!chinaRuleSetId) {
    try {
      const repaired = await repairChinaDirectState();
      chinaRuleSetId = repaired.chinaRuleSetId;
    } catch (error) {
      console.error("[rule-sets] all-scheme CN repair retry failed", error);
    }
  }
  // The initial repair must happen before the one-time library migration so
  // the migration can discover legacy CN references. Run it once more after
  // every migration path has finished: concurrent config/library requests or
  // a legacy migration must never leave only the currently viewed scheme with
  // the CN proxy group line.
  if (chinaRuleSetId) {
    try {
      await repairChinaDirectState();
    } catch (error) {
      console.error("[rule-sets] final all-scheme CN repair failed", error);
    }
  }
  return listRuleSets();
}

export { toClient };
