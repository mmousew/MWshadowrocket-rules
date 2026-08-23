import { getReadyRawDb } from "../../db";
import { parseRuleSetEntries, type RuleSetEntry } from "./rule-set-core";

export type RuleSetRow = { id: string; name: string; description: string; kind: string; entries: RuleSetEntry[]; source: string; status: string; sort_order: number; created_at: number; updated_at: number };
export type RuleSetBindingRow = { id: string; rule_config_id: string; group_name: string; rule_set_id: string; created_at: number; updated_at: number };

const MIGRATION_ID = "rule-set-library-v1";
const SEED_NAMES = ["YouTube", "Disney", "Hbomax", "Netflix", "Bahamut", "Bilibili", "Spotify", "Steam", "Telegram", "Google", "Microsoft", "OpenAI", "PayPal", "TIKTOK", "Apple", "UK", "CA", "KR", "CN", "DE", "JP", "SG", "TW", "US", "HK"];
const CHINA_MAX_NO_IP_URL = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/ChinaMaxNoIP/ChinaMaxNoIP.list";
const CHINA_DIRECT_ENTRIES: RuleSetEntry[] = [
  `RULE-SET,${CHINA_MAX_NO_IP_URL}`, "RULE-SET,acl:ChinaIp", "RULE-SET,acl:ChinaDomain", "RULE-SET,acl:ChinaCompanyIp", "RULE-SET,acl:UnBan", "RULE-SET,acl:SteamCN", "RULE-SET,acl:Download", "RULE-SET,acl:ChinaMedia", "GEOSITE,paypal@cn", "GEOSITE,paypal", "DOMAIN-SUFFIX,wise.com", "DOMAIN-SUFFIX,ifastgb.com", "DOMAIN-SUFFIX,myfin.bg", "DOMAIN-SUFFIX,shunzhengjinfu.com", "DOMAIN-SUFFIX,dtcpay.com", "DOMAIN-SUFFIX,dtcpayment.com",
].map((line) => parseRuleSetEntries(line)[0]).filter(Boolean) as RuleSetEntry[];

function mapRow(row: Omit<RuleSetRow, "entries"> & { entries: string }) {
  let entries: RuleSetEntry[] = [];
  try { entries = parseRuleSetEntries(JSON.parse(row.entries || "[]")); } catch { entries = parseRuleSetEntries(row.entries || ""); }
  return { ...row, entries };
}

function toClient(row: RuleSetRow | { id: string; name: string; description: string; kind: string; entries: RuleSetEntry[]; source: string; status: string; sortOrder: number; createdAt: number; updatedAt: number }) {
  const source = "sort_order" in row ? { sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at } : { sortOrder: row.sortOrder, createdAt: row.createdAt, updatedAt: row.updatedAt };
  return { id: row.id, name: row.name, description: row.description, kind: row.kind, entries: row.entries, source: row.source, status: row.status, entryCount: row.entries.length, ...source };
}

export async function listRuleSets() {
  const result = await (await getReadyRawDb()).prepare("SELECT id, name, description, kind, entries, source, status, sort_order, created_at, updated_at FROM rule_sets WHERE status <> 'deleted' ORDER BY sort_order ASC, created_at ASC").all<Omit<RuleSetRow, "entries"> & { entries: string }>();
  return result.results.map(mapRow);
}

export async function listRuleSetBindings(configId: string) {
  const result = await (await getReadyRawDb()).prepare("SELECT id, rule_config_id, group_name, rule_set_id, created_at, updated_at FROM rule_set_bindings WHERE rule_config_id = ? ORDER BY group_name COLLATE NOCASE").bind(configId).all<RuleSetBindingRow>();
  return result.results;
}

export async function replaceRuleSetBindings(configId: string, bindings: Array<{ groupName: string; ruleSetId: string }>) {
  const db = await getReadyRawDb();
  const clean = new Map<string, { groupName: string; ruleSetId: string }>();
  for (const binding of bindings) {
    const groupName = String(binding.groupName || "").trim();
    const ruleSetId = String(binding.ruleSetId || "").trim();
    if (groupName && ruleSetId) clean.set(groupName.toLowerCase(), { groupName, ruleSetId });
  }
  const now = Date.now();
  await db.prepare("DELETE FROM rule_set_bindings WHERE rule_config_id = ?").bind(configId).run();
  if (clean.size) await db.batch(Array.from(clean.values()).map((binding) => db.prepare("INSERT INTO rule_set_bindings (id, rule_config_id, group_name, rule_set_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), configId, binding.groupName, binding.ruleSetId, now, now)));
  return listRuleSetBindings(configId);
}

export async function cloneRuleSetBindings(fromConfigId: string, toConfigId: string) {
  const bindings = await listRuleSetBindings(fromConfigId);
  return replaceRuleSetBindings(toConfigId, bindings.map((item) => ({ groupName: item.group_name, ruleSetId: item.rule_set_id })));
}

export async function createRuleSet(input: { name: string; description?: string; entries: string | RuleSetEntry[]; source?: string }) {
  const db = await getReadyRawDb();
  const now = Date.now();
  const entries = parseRuleSetEntries(input.entries);
  const count = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM rule_sets WHERE status <> 'deleted'").first<{ value: number }>();
  const row = { id: crypto.randomUUID(), name: input.name.trim().slice(0, 100) || "规则集", description: String(input.description || "").trim().slice(0, 300), kind: "managed", entries, source: String(input.source || "").trim().slice(0, 500), status: "active", sortOrder: Number(count?.value || -1) + 1, createdAt: now, updatedAt: now };
  await db.prepare("INSERT INTO rule_sets (id, name, description, kind, entries, source, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(row.id, row.name, row.description, row.kind, JSON.stringify(row.entries), row.source, row.status, row.sortOrder, now, now).run();
  return row;
}

export async function updateRuleSet(id: string, input: { name?: string; description?: string; entries?: string | RuleSetEntry[]; source?: string }) {
  const current = (await listRuleSets()).find((row) => row.id === id);
  if (!current) throw new Error("规则集不存在");
  const entries = input.entries === undefined ? current.entries : parseRuleSetEntries(input.entries);
  const row = { ...current, name: input.name === undefined ? current.name : input.name.trim().slice(0, 100) || current.name, description: input.description === undefined ? current.description : String(input.description).trim().slice(0, 300), source: input.source === undefined ? current.source : String(input.source).trim().slice(0, 500), entries, updatedAt: Date.now() };
  await (await getReadyRawDb()).prepare("UPDATE rule_sets SET name = ?, description = ?, entries = ?, source = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(row.name, row.description, JSON.stringify(row.entries), row.source, row.updatedAt, id).run();
  return row;
}

export async function deleteRuleSet(id: string) {
  const db = await getReadyRawDb();
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

async function insertSeedRuleSet(db: ReadyDb, name: string, entries: RuleSetEntry[], description = "", source = "") {
  const existing = await db.prepare("SELECT id FROM rule_sets WHERE lower(name) = lower(?) AND status <> 'deleted' LIMIT 1").bind(name).first<{ id: string }>();
  if (existing) return existing.id;
  const now = Date.now();
  const max = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM rule_sets WHERE status <> 'deleted'").first<{ value: number }>();
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO rule_sets (id, name, description, kind, entries, source, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'managed', ?, ?, 'active', ?, ?, ?)").bind(id, name, description, JSON.stringify(entries), source, Number(max?.value || -1) + 1, now, now).run();
  return id;
}

export async function ensureRuleSetLibrary() {
  const db = await getReadyRawDb();
  const marker = await db.prepare("SELECT id FROM rule_set_migrations WHERE id = ? LIMIT 1").bind(MIGRATION_ID).first<{ id: string }>();
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
  await insertSeedRuleSet(db, "CN-国内直连（综合）", CHINA_DIRECT_ENTRIES, "中国大陆直连与常用国内服务规则集合；包含每日更新的 ChinaMaxNoIP 公共规则集", CHINA_MAX_NO_IP_URL);
  if (!marker) {
    for (const [configId, bindings] of schemeSets) {
      const existing = await listRuleSetBindings(configId);
      if (existing.length) continue;
      await replaceRuleSetBindings(configId, Array.from(bindings.entries()).map(([groupName, ruleSetId]) => ({ groupName, ruleSetId })));
    }
    await db.prepare("INSERT INTO rule_set_migrations (id, version, created_at) VALUES (?, 1, ?)").bind(MIGRATION_ID, Date.now()).run();
  }
  return listRuleSets();
}

export { toClient };
