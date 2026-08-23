"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import QRCode from "qrcode";

type View = "overview" | "groups" | "rules" | "sets" | "configs" | "clash" | "airports" | "conflicts";
type Group = { index: number; name: string; kind: string; items: string[] };
type Rule = { index: number; type: string; value: string; policy: string; options: string[] };
type CatalogResult = { name: string; file: string; url: string; source: string };
type RuleConfigRecord = { id: string; name: string; content: string; status: "active" | "deleted"; is_template_default?: number; created_at: number; updated_at: number; profile_count?: number };
type Editor =
  | { mode: "group"; index: number | null; name: string; items: string; isNew?: boolean; regularKinds?: string[]; regularItems?: Record<string, string>; customEnabled?: boolean; customName?: string; customItems?: string }
  | { mode: "rule"; index: number | null; type: string; value: string; policy: string; options: string };
type GroupDeleteImpact = { rules: Rule[]; finalRule: Rule | null; parentGroups: Group[] };
type DeleteTarget = { kind: "group"; group: Group; impact: GroupDeleteImpact } | { kind: "rule"; rule: Rule };
type AirportSourceRecord = { id: string; name: string; kind: "url" | "content"; sourceUrl: string; hidden: boolean; nodeCount: number | null; createdAt: number; updatedAt: number };
type AirportNodeRecord = { id: string; name: string; type: string; server: string; port: number | null; status: "valid" | "invalid" | "unloaded"; reason: string; latency?: number };

const RULE_TYPES = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "RULE-SET", "GEOSITE", "IP-CIDR", "IP-CIDR6", "GEOIP"];
const RULE_TYPE_META: Record<string, { label: string; hint: string }> = {
  DOMAIN: { label: "完整域名", hint: "只匹配这一个完整网址，例如 api.example.com。" },
  "DOMAIN-SUFFIX": { label: "域名后缀", hint: "匹配主域名及所有子域名，最常用，例如 example.com。" },
  "DOMAIN-KEYWORD": { label: "域名关键词", hint: "域名中出现该关键词就匹配，范围较大，请谨慎使用。" },
  "RULE-SET": { label: "在线规则集", hint: "引用公开维护的整套规则，更新配置时会自动获取。" },
  GEOSITE: { label: "内置 geosite", hint: "填写内置规则名称，例如 google、paypal@cn；保存时会自动生成 RULE-SET,geosite:名称。" },
  "IP-CIDR": { label: "IPv4 地址段", hint: "匹配一段 IPv4 地址，通常由规则维护者提供。" },
  "IP-CIDR6": { label: "IPv6 地址段", hint: "匹配一段 IPv6 地址，通常由规则维护者提供。" },
  GEOIP: { label: "国家或地区 IP", hint: "按照 IP 所属国家或地区匹配，例如 CN。" },
};
const BUILTINS = ["DIRECT", "PROXY", "PROXIES", "REJECT", "REJECT-DROP", "REJECT-NO-DROP"];
const GROUP_KIND_OPTIONS = [
  { value: "select", label: "手动选择", hint: "由你手动指定节点" },
  { value: "url-test", label: "自动选择", hint: "按测速结果选择较快节点" },
  { value: "fallback", label: "故障转移", hint: "当前节点故障时自动切换" },
  { value: "load-balance", label: "负载均衡", hint: "在多个节点之间分配连接" },
] as const;
const DEFAULT_GROUP_HEALTH_OPTIONS = [
  "url=https://www.gstatic.com/generate_204",
  "interval=300",
  "tolerance=50",
];
const GROUP_HEALTH_OPTION_KEYS = /^(?:url|interval|tolerance|timeout|lazy|strategy|max-failed-times)=/i;
// 机场配置里的国家组通常使用代码名，不能只识别中文名称。
// 这些组也会被 Final 等策略组用来指定最终流量走向。
const COUNTRY_GROUP_NAMES = new Set([
  "日本", "加拿大", "英国", "香港", "韩国", "德国", "法国", "新加坡", "美国",
  "JP", "CA", "UK", "HK", "KR", "DE", "FR", "SG", "US", "TW", "CN",
]);
function catalogFileHint(file: string) {
  if (file.includes("_Resolve")) return "解析版（通常不需要优先选）";
  if (file.includes("_Domain")) return "纯域名补充版（大型规则可能需要一并添加）";
  return "标准版（推荐）";
}

function splitRuleLine(line: string) {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of line) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  parts.push(current.trim());
  return parts;
}

function policyKey(value: string) {
  return value.trim().toLowerCase();
}

function policyExists(policy: string, groups: Group[]) {
  const key = policyKey(policy);
  return BUILTINS.some((item) => policyKey(item) === key) || groups.some((group) => policyKey(group.name) === key);
}

function defaultGroupItems(kind: string) {
  return [kind, "include-all-proxies=true", "DIRECT", ...(kind === "select" ? [] : DEFAULT_GROUP_HEALTH_OPTIONS)].join("\n");
}

function readGroupFilter(raw: string, countryGroups: string[]) {
  const values = raw.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return {
    values,
    kind: values[0] || "select",
    selectedCountries: new Set(values.slice(1).filter((item) => countryGroups.includes(item))),
    includeAll: values.includes("include-all-proxies=true"),
    keyword: values.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length) || "",
  };
}

function updateGroupItems(raw: string, countryGroups: string[], changes: { kind?: string; country?: string; keyword?: string; includeAll?: boolean }) {
  const current = readGroupFilter(raw, countryGroups);
  const kind = changes.kind || current.kind;
  const countries = new Set(current.selectedCountries);
  if (changes.country) {
    if (countries.has(changes.country)) countries.delete(changes.country);
    else countries.add(changes.country);
  }
  let extras = current.values.slice(1).filter((item) => !countryGroups.includes(item) && !item.startsWith("policy-regex-filter=") && item !== "include-all-proxies=true");
  if (changes.kind && ["url-test", "fallback", "load-balance"].includes(kind) && !extras.some((item) => /^url=/i.test(item))) {
    extras = [...DEFAULT_GROUP_HEALTH_OPTIONS, ...(kind === "load-balance" ? ["strategy=consistent-hashing"] : [])];
  }
  if (changes.kind === "select") extras = extras.filter((item) => !GROUP_HEALTH_OPTION_KEYS.test(item));
  const includeItems = changes.includeAll === undefined ? (current.includeAll ? ["include-all-proxies=true"] : []) : changes.includeAll ? ["include-all-proxies=true"] : [];
  const keyword = changes.keyword === undefined ? current.keyword : changes.keyword.trim();
  const keywordItems = keyword ? [`policy-regex-filter=${keyword}`] : [];
  return [kind, ...includeItems, ...Array.from(countries), ...keywordItems, ...extras].join("\n");
}

function groupOptionLabel(kind: string) {
  return GROUP_KIND_OPTIONS.find((option) => option.value === kind)?.label || kind;
}
const nav: { id: View; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "configs", label: "方案" },
  { id: "clash", label: "私有订阅" },
  { id: "airports", label: "机场列表" },
  { id: "conflicts", label: "检查" },
];
const schemeTabs: { id: View; label: string; description: string }[] = [
  { id: "groups", label: "分组", description: "管理代理策略和节点筛选" },
  { id: "rules", label: "域名", description: "管理域名匹配和执行策略" },
  { id: "sets", label: "规则", description: "管理在线规则集和 geosite" },
];
const knownViews: View[] = [...nav.map((item) => item.id), ...schemeTabs.map((item) => item.id)];

function parseConfig(content: string) {
  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  const groups: Group[] = [];
  const rules: Rule[] = [];
  let finalRule: Rule | null = null;
  let finalRuleCount = 0;
  lines.forEach((raw, index) => {
    if (index > groupStart && index < ruleStart) {
      const match = raw.match(/^\s*([^#=]+?)\s*=\s*(.+)$/);
      if (match) {
        const items = match[2].split(",").map((item) => item.trim()).filter(Boolean);
        groups.push({ index, name: match[1].trim(), kind: items[0] || "select", items: items.slice(1) });
      }
    }
    if (index > ruleStart && raw.trim() && !raw.trim().startsWith("#")) {
      const parts = splitRuleLine(raw);
      if (parts[0].toUpperCase() === "FINAL" && parts[1]) {
        finalRuleCount += 1;
        finalRule = { index, type: "FINAL", value: "", policy: parts[1], options: parts.slice(2) };
        return;
      }
      if (parts.length >= 3) rules.push({ index, type: parts[0], value: parts[1], policy: parts[2], options: parts.slice(3) });
    }
  });
  return { lines, groups, rules, finalRule, finalRuleCount, groupStart, ruleStart };
}

function getConflicts(groups: Group[], rules: Rule[]) {
  const conflicts: string[] = [];
  const groupKeys = new Set<string>();
  groups.forEach((group) => {
    const key = policyKey(group.name);
    if (groupKeys.has(key)) conflicts.push(`代理分组名称重复（忽略大小写）：${group.name}`);
    groupKeys.add(key);
  });
  rules.forEach((rule) => {
    const key = `${rule.type},${rule.value}`;
    if (!policyExists(rule.policy, groups)) {
      conflicts.push(`${key} 引用了不存在的策略「${rule.policy}」`);
    }
  });
  return Array.from(new Set(conflicts));
}

function getDuplicateRuleCount(rules: Rule[]) {
  const policiesByRule = new Map<string, Set<string>>();
  rules.forEach((rule) => {
    const key = `${rule.type},${rule.value}`;
    const policies = policiesByRule.get(key) || new Set<string>();
    policies.add(rule.policy);
    policiesByRule.set(key, policies);
  });
  return Array.from(policiesByRule.values()).filter((policies) => policies.size > 1).length;
}

function replaceLine(content: string, index: number, value: string) {
  const lines = content.split(/\r?\n/);
  lines[index] = value;
  return lines.join("\n");
}

function insertLine(content: string, index: number, value: string) {
  const lines = content.split(/\r?\n/);
  lines.splice(index, 0, value);
  return lines.join("\n");
}

export default function Home() {
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return "overview";
    const saved = new URL(window.location.href).searchParams.get("view") as View | null;
    return saved && knownViews.includes(saved) ? saved : "overview";
  });
  const [content, setContent] = useState("");
  const [sha, setSha] = useState("");
  const [repository, setRepository] = useState("mmousew/MWshadowrocket-rules");
  const [branch, setBranch] = useState("rules/initial-region-module");
  const [sourceUrl, setSourceUrl] = useState("https://github.com/mmousew/MWshadowrocket-rules");
  const [saveEnabled, setSaveEnabled] = useState(false);
  const [ruleConfigs, setRuleConfigs] = useState<RuleConfigRecord[]>([]);
  const [selectedRuleConfigId, setSelectedRuleConfigId] = useState(() => typeof window === "undefined" ? "default" : new URL(window.location.href).searchParams.get("config") || "default");
  const [ruleConfigBusy, setRuleConfigBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [bulkTargetPolicy, setBulkTargetPolicy] = useState("");
  const [selectedRuleIndexes, setSelectedRuleIndexes] = useState<number[]>([]);
  const [selectionKey, setSelectionKey] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [toast, setToast] = useState("");
  const [draggingGroup, setDraggingGroup] = useState("");
  const [dragTargetGroup, setDragTargetGroup] = useState("");
  const dragSourceRef = useRef("");
  const dragTargetRef = useRef("");
  const loginStatus = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("login_error");
  const loginError = loginStatus ? (loginStatus === "forbidden" ? "这个 GitHub 账号没有管理权限，请改用 mmousew 登录。" : "GitHub 登录没有完成，请重新尝试。") : "";

  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "overview") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [view]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedRuleConfigId === "default") url.searchParams.delete("config");
    else url.searchParams.set("config", selectedRuleConfigId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [selectedRuleConfigId]);

  useEffect(() => {
    const requestedConfigId = new URL(window.location.href).searchParams.get("config");
    Promise.all([
      fetch("/api/config", { cache: "no-store" }),
      fetch(`/api/rule-config${requestedConfigId ? `?id=${encodeURIComponent(requestedConfigId)}` : ""}`, { cache: "no-store" }),
    ])
      .then(async ([configResponse, ruleConfigResponse]) => {
        const data = await configResponse.json();
        if (configResponse.status === 401 || ruleConfigResponse.status === 401) { setAuthRequired(true); setLoading(false); return; }
        if (!configResponse.ok) throw new Error(data.error || "读取配置失败");
        const ruleConfigData = await ruleConfigResponse.json();
        if (!ruleConfigResponse.ok) throw new Error(ruleConfigData.error || "读取规则方案失败");
        const configs = (ruleConfigData.configs || []) as RuleConfigRecord[];
        const selectedId = ruleConfigData.selectedId || configs[0]?.id || "default";
        const selected = configs.find((config) => config.id === selectedId) || configs[0];
        setContent(selected?.content || data.content); setSha(data.sha); setRepository(data.repository); setBranch(data.branch);
        setSourceUrl(data.sourceUrl); setSaveEnabled(data.saveEnabled); setRuleConfigs(configs); setSelectedRuleConfigId(selected?.id || "default"); setLoading(false);
      })
      .catch((cause) => { setError(cause instanceof Error ? cause.message : "读取配置失败"); setLoading(false); });
  }, []);

  const parsed = useMemo(() => parseConfig(content), [content]);
  const conflicts = useMemo(() => {
    const issues = getConflicts(parsed.groups, parsed.rules);
    if (parsed.finalRuleCount > 1) issues.push("配置中存在多个 FINAL 兜底规则，请只保留最后一条");
    if (parsed.finalRule && !policyExists(parsed.finalRule.policy, parsed.groups)) {
      issues.push(`FINAL 引用了不存在的策略「${parsed.finalRule.policy}」`);
    }
    return Array.from(new Set(issues));
  }, [parsed.groups, parsed.rules, parsed.finalRule, parsed.finalRuleCount]);
  const duplicateRuleCount = useMemo(() => getDuplicateRuleCount(parsed.rules), [parsed.rules]);
  const selectedRuleConfig = useMemo(() => ruleConfigs.find((config) => config.id === selectedRuleConfigId), [ruleConfigs, selectedRuleConfigId]);
  const isSchemeView = schemeTabs.some((item) => item.id === view);
  const ruleSets = useMemo(() => parsed.rules.filter((rule) => rule.type === "RULE-SET"), [parsed.rules]);
  const domainRules = useMemo(() => parsed.rules.filter((rule) => rule.type !== "RULE-SET" && rule.type !== "FINAL"), [parsed.rules]);
  const policies = useMemo(() => [...parsed.groups.map((group) => group.name), ...BUILTINS], [parsed.groups]);
  const ruleCountForPolicy = (policy: string) => parsed.rules.filter((rule) => policyKey(rule.policy) === policyKey(policy)).length + (parsed.finalRule && policyKey(parsed.finalRule.policy) === policyKey(policy) ? 1 : 0);
  const filteredGroups = parsed.groups.filter((group) => `${group.name} ${group.items.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const viewingGroup = view === "rules" && parsed.groups.some((group) => group.name === query) ? query : "";
  const activeRules = viewingGroup ? parsed.rules.filter((rule) => rule.policy === viewingGroup) : view === "sets" ? ruleSets : domainRules;
  const filteredRules = activeRules.filter((rule) => viewingGroup || `${rule.type} ${rule.value} ${rule.policy}`.toLowerCase().includes(query.toLowerCase()));
  const viewingFinal = Boolean(viewingGroup && parsed.finalRule && policyKey(parsed.finalRule.policy) === policyKey(viewingGroup));
  const visibleRuleCount = filteredRules.length + (viewingFinal ? 1 : 0);
  const filteredRuleKey = filteredRules.map((rule) => rule.index).join(",");
  const effectiveSelectedRuleIndexes = selectionKey === filteredRuleKey ? selectedRuleIndexes : filteredRules.map((rule) => rule.index);

  function markContent(next: string) { setContent(next); setDirty(true); setToast(`「${ruleConfigs.find((config) => config.id === selectedRuleConfigId)?.name || "当前方案"}」修改已暂存，保存后生效`); }

  function selectRuleConfig(id: string, openEditor = false) {
    const config = ruleConfigs.find((item) => item.id === id);
    if (!config) return;
    setSelectedRuleConfigId(config.id);
    setContent(config.content);
    setDirty(false);
    setQuery("");
    setError("");
    setToast(`已切换到「${config.name}」`);
    if (openEditor) setView("groups");
  }

  async function createRuleConfig(name: string) {
    const safeName = name.trim();
    if (!safeName) return setError("请输入规则方案名称");
    setRuleConfigBusy(true); setError("");
    try {
      const response = await fetch("/api/rule-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: safeName }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || "新增规则方案失败");
      setRuleConfigs((current) => [...current, data.config]);
      setSelectedRuleConfigId(data.config.id);
      setContent(data.config.content);
      setDirty(false);
      setQuery("");
      setView("groups");
      setToast(`已新增「${data.config.name}」，现在可以编辑它的分组和规则`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新增规则方案失败");
    } finally { setRuleConfigBusy(false); }
  }

  async function renameRuleConfig(id: string, name: string) {
    const safeName = name.trim();
    if (!safeName) return setError("规则方案名称不能为空");
    try {
      const response = await fetch("/api/rule-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name: safeName }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || "保存方案名称失败");
      setRuleConfigs((current) => current.map((config) => config.id === id ? data.config : config));
      setToast("方案名称已保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存方案名称失败");
    }
  }

  async function setRuleConfigDefault(id: string) {
    const config = ruleConfigs.find((item) => item.id === id);
    if (!config || config.is_template_default) return;
    setRuleConfigBusy(true); setError("");
    try {
      const response = await fetch("/api/rule-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, setDefault: true }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || "设置默认方案失败");
      setRuleConfigs((data.configs || []) as RuleConfigRecord[]);
      setToast(`已将「${config.name}」设为复制默认方案`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设置默认方案失败");
    } finally { setRuleConfigBusy(false); }
  }

  async function deleteRuleConfig(id: string) {
    const config = ruleConfigs.find((item) => item.id === id);
    if (!config || id === "default" || !window.confirm(`删除「${config.name}」？使用它的订阅会自动改用默认规则。`)) return;
    setRuleConfigBusy(true); setError("");
    try {
      const response = await fetch("/api/rule-config", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除规则方案失败");
      const nextConfigs = (data.configs || []) as RuleConfigRecord[];
      setRuleConfigs(nextConfigs);
      if (selectedRuleConfigId === id) selectRuleConfig(nextConfigs[0]?.id || "default", true);
      setToast(`「${config.name}」已删除`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除规则方案失败");
    } finally { setRuleConfigBusy(false); }
  }

  async function recoverHaoziRuleConfig(id: string) {
    if (id !== "haozi-custom" || !window.confirm("恢复本地备份到 MWPRO？这会替换 MWPRO 当前分组和规则，不会修改默认方案或机场节点。")) return;
    setRuleConfigBusy(true); setError("");
    try {
      const response = await fetch("/api/rule-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, recoverHaozi: true }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || "恢复 MWPRO 失败");
      setRuleConfigs((data.configs || []) as RuleConfigRecord[]);
      if (selectedRuleConfigId === id) { setContent(data.config.content); setDirty(false); }
      setToast("MWPRO 原始分组和规则已恢复，耗子专用已重新绑定");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复 MWPRO 失败");
    } finally { setRuleConfigBusy(false); }
  }

  function openNew() {
    if (view === "groups") setEditor({
      mode: "group",
      index: null,
      name: "",
      items: defaultGroupItems("url-test"),
      isNew: true,
      regularKinds: ["url-test"],
      regularItems: { "url-test": defaultGroupItems("url-test") },
      customEnabled: false,
      customName: "",
      customItems: defaultGroupItems("select"),
    });
    else {
      const selectedPolicy = parsed.groups.some((group) => group.name === query) ? query : "国内直连";
      setEditor({ mode: "rule", index: null, type: view === "sets" ? "RULE-SET" : "DOMAIN-SUFFIX", value: "", policy: selectedPolicy, options: "" });
    }
  }

  function showGroupRules(group: Group) {
    setView("rules");
    setQuery(group.name);
  }

  function editGroup(group: Group) {
    setEditor({ mode: "group", index: group.index, name: group.name, items: [group.kind, ...group.items].join("\n") });
  }

  function editRule(rule: Rule) {
    setEditor({ mode: "rule", index: rule.index, type: rule.type, value: rule.value, policy: rule.policy, options: rule.options.join(",") });
  }

  function reorderGroup(sourceName: string, targetName: string) {
    if (!sourceName || !targetName || sourceName === targetName || query) return;
    const sourcePosition = parsed.groups.findIndex((group) => group.name === sourceName);
    const targetPosition = parsed.groups.findIndex((group) => group.name === targetName);
    if (sourcePosition < 0 || targetPosition < 0) return;

    const groupLines = parsed.groups.map((group) => parsed.lines[group.index]);
    const [movedLine] = groupLines.splice(sourcePosition, 1);
    groupLines.splice(targetPosition, 0, movedLine);
    const nextLines = [...parsed.lines];
    parsed.groups.forEach((group, position) => { nextLines[group.index] = groupLines[position]; });
    markContent(nextLines.join("\n"));
    setToast(`「${sourceName}」已移动，保存后同步新顺序`);
  }

  function finishGroupDrag(sourceName = dragSourceRef.current, targetName = dragTargetRef.current) {
    reorderGroup(sourceName, targetName);
    dragSourceRef.current = "";
    dragTargetRef.current = "";
    setDraggingGroup("");
    setDragTargetGroup("");
  }

  function startNativeGroupDrag(event: DragEvent<HTMLButtonElement>, group: Group) {
    if (query) return event.preventDefault();
    dragSourceRef.current = group.name;
    setDraggingGroup(group.name);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", group.name);
  }

  function startTouchGroupDrag(event: PointerEvent<HTMLButtonElement>, group: Group) {
    if (query) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSourceRef.current = group.name;
    dragTargetRef.current = group.name;
    setDraggingGroup(group.name);
    setDragTargetGroup(group.name);
  }

  function moveTouchGroupDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!dragSourceRef.current) return;
    event.preventDefault();
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-group-name]");
    const targetName = row?.dataset.groupName || "";
    if (targetName) {
      dragTargetRef.current = targetName;
      setDragTargetGroup(targetName);
    }
  }

  function moveGroupWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, group: Group) {
    if (query || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const position = parsed.groups.findIndex((item) => item.name === group.name);
    const target = parsed.groups[position + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) reorderGroup(group.name, target.name);
  }

  function moveGroupByOffset(group: Group, offset: -1 | 1) {
    if (query) return;
    const position = parsed.groups.findIndex((item) => item.name === group.name);
    const target = parsed.groups[position + offset];
    if (target) reorderGroup(group.name, target.name);
  }

  function submitEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    if (editor.mode === "group") {
      if (editor.index === null && editor.isNew) {
        const selectedKinds = Array.from(new Set(editor.regularKinds || []));
        const regularLines = selectedKinds.map((kind) => ({ name: groupOptionLabel(kind), items: (editor.regularItems?.[kind] || defaultGroupItems(kind)).split(/\n|,/).map((item) => item.trim()).filter(Boolean) }));
        const customEnabled = Boolean(editor.customEnabled);
        const customName = (editor.customName || "").trim();
        const customItems = (editor.customItems || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean);
        if (customEnabled && !customName) return setError("已启用自定义分组，请填写自定义分组名称");
        if (customEnabled && !customItems.length) return setError("自定义分组配置不能为空");
        if (!regularLines.length && !customEnabled) return setError("请至少选择一个常规分组，或启用自定义分组");

        const existingNames = new Set(parsed.groups.map((group) => policyKey(group.name)));
        const duplicateRegulars = regularLines.filter((line) => existingNames.has(policyKey(line.name))).map((line) => line.name);
        if (duplicateRegulars.length) return setError(`常规分组「${duplicateRegulars.join("、")}」已经存在，不能重复添加`);
        if (customEnabled && existingNames.has(policyKey(customName))) return setError(`自定义分组「${customName}」已经存在，请换一个名称`);
        if (customEnabled && regularLines.some((line) => policyKey(line.name) === policyKey(customName))) return setError(`自定义分组「${customName}」与常规分组名称重复，请换一个名称`);

        const lines = [...regularLines.map((line) => `${line.name} = ${line.items.join(",")}`)];
        if (customEnabled) lines.push(`${customName} = ${customItems.join(",")}`);
        const nextLines = content.split(/\r?\n/);
        nextLines.splice(parsed.ruleStart, 0, ...lines);
        markContent(nextLines.join("\n"));
        setEditor(null); setError("");
        return;
      }
      const name = editor.name.trim();
      const items = editor.items.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
      if (!name || !items.length) return setError("分组名称和配置项不能为空");
      const line = `${name} = ${items.join(",")}`;
      if (editor.index === null) {
        markContent(insertLine(content, parsed.ruleStart, `${line}\n`));
      } else {
        const oldName = parsed.groups.find((group) => group.index === editor.index)?.name || name;
        let next = replaceLine(content, editor.index, line);
        if (oldName !== name) {
          const nextLines = next.split(/\r?\n/).map((raw) => {
            if (!raw.trim() || raw.trim().startsWith("#")) return raw;
            if (raw.includes("=")) {
              const [left, right] = raw.split(/=(.*)/s);
              const tokens = right.split(",").map((token) => token.trim() === oldName ? name : token.trim());
              return `${left.trim()} = ${tokens.join(",")}`;
            }
            const parts = raw.split(",");
            if (parts[0]?.trim() === "FINAL" && parts[1]?.trim() === oldName) parts[1] = name;
            else if (parts[2]?.trim() === oldName) parts[2] = name;
            return parts.join(",");
          });
          next = nextLines.join("\n");
        }
        markContent(next);
      }
    } else {
      const values = editor.type === "DOMAIN-SUFFIX"
        ? Array.from(new Set(editor.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)))
        : [editor.value.trim()].filter(Boolean);
      if (!values.length || !editor.policy) return setError("规则内容和策略不能为空");
      const options = editor.options.split(",").map((item) => item.trim()).filter(Boolean);
      const newLines = values.map((value) => {
        if (editor.type === "GEOSITE") {
          const geosite = value.replace(/^geosite:/i, "");
          return ["RULE-SET", `geosite:${geosite}`, editor.policy, ...options].join(",");
        }
        return [editor.type, value, editor.policy, ...options].join(",");
      });
      if (editor.index === null) {
        const importIndex = parsed.lines.findIndex((raw) => raw.includes("BEGIN Flower_SS"));
        const finalIndex = parsed.lines.findIndex((raw) => raw.startsWith("FINAL,"));
        const target = importIndex > parsed.ruleStart ? importIndex : finalIndex;
        const lines = content.split(/\r?\n/);
        lines.splice(target, 0, ...newLines);
        markContent(lines.join("\n"));
      } else {
        const lines = content.split(/\r?\n/);
        lines.splice(editor.index, 1, ...newLines);
        markContent(lines.join("\n"));
      }
    }
    setEditor(null); setError("");
  }

  function importCatalogRules(items: CatalogResult[], policy: string) {
    const existing = new Set(parsed.rules.filter((rule) => rule.type === "RULE-SET" && rule.policy === policy).map((rule) => rule.value));
    const additions = items.filter((item) => !existing.has(item.url));
    if (!additions.length) {
      setToast(`「${policy}」里已经有这些规则集，无需重复导入`);
      setEditor(null);
      return;
    }
    const importIndex = parsed.lines.findIndex((raw) => raw.includes("BEGIN Flower_SS"));
    const finalIndex = parsed.lines.findIndex((raw) => raw.startsWith("FINAL,"));
    const target = importIndex > parsed.ruleStart ? importIndex : finalIndex;
    const lines = content.split(/\r?\n/);
    lines.splice(target, 0, ...additions.map((item) => `RULE-SET,${item.url},${policy}`));
    markContent(lines.join("\n"));
    setEditor(null);
    setToast(`已将 ${additions.length} 个规则集导入「${policy}」，保存后生效`);
  }

  function transferFilteredRules(targetPolicy: string) {
    if (!query.trim() || !filteredRules.length || !targetPolicy) return;
    const selected = new Set(effectiveSelectedRuleIndexes);
    const transferable = filteredRules.filter((rule) => selected.has(rule.index) && rule.policy !== targetPolicy);
    if (!selected.size) {
      setToast("请至少勾选一条规则");
      return;
    }
    if (!transferable.length) {
      setToast(`搜索结果已经全部属于「${targetPolicy}」`);
      return;
    }
    const lines = [...parsed.lines];
    transferable.forEach((rule) => {
      lines[rule.index] = [rule.type, rule.value, targetPolicy, ...rule.options].join(",");
    });
    markContent(lines.join("\n"));
    setSelectionKey("");
    setToast(`已将 ${transferable.length} 条搜索结果转移到「${targetPolicy}」，保存后生效`);
  }

  function toggleRuleSelection(index: number) {
    setSelectionKey(filteredRuleKey);
    setSelectedRuleIndexes((current) => {
      const base = selectionKey === filteredRuleKey ? current : filteredRules.map((rule) => rule.index);
      return base.includes(index) ? base.filter((item) => item !== index) : [...base, index];
    });
  }

  function removeGroup(group: Group) {
    const key = policyKey(group.name);
    const impact: GroupDeleteImpact = {
      rules: parsed.rules.filter((rule) => policyKey(rule.policy) === key),
      finalRule: parsed.finalRule && policyKey(parsed.finalRule.policy) === key ? parsed.finalRule : null,
      parentGroups: parsed.groups.filter((item) => item.index !== group.index && item.items.some((itemName) => policyKey(itemName) === key)),
    };
    setDeleteTarget({ kind: "group", group, impact });
  }

  function removeRule(rule: Rule) {
    setDeleteTarget({ kind: "rule", rule });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const lines = content.split(/\r?\n/);
    if (deleteTarget.kind === "rule") {
      lines.splice(deleteTarget.rule.index, 1);
    } else {
      const targetKey = policyKey(deleteTarget.group.name);
      const groupIndexes = new Set(parsed.groups.map((group) => group.index));
      const parentGroupIndexes = new Set(deleteTarget.impact.parentGroups.map((group) => group.index));
      const ruleIndexes = new Set(deleteTarget.impact.rules.map((rule) => rule.index));
      lines.splice(0, lines.length, ...lines.flatMap((raw, index) => {
        if (index === deleteTarget.group.index) return [];
        if (groupIndexes.has(index) && parentGroupIndexes.has(index)) {
          const separator = raw.indexOf("=");
          if (separator > 0) {
            const groupItems = splitRuleLine(raw.slice(separator + 1));
            const kind = groupItems.shift() || "select";
            const remaining = groupItems.filter((item) => policyKey(item) !== targetKey);
            if (!remaining.length) remaining.push("DIRECT");
            return [`${raw.slice(0, separator).trim()} = ${[kind, ...remaining].join(",")}`];
          }
        }
        if (ruleIndexes.has(index)) return [];
        if (deleteTarget.impact.finalRule?.index === index) return ["FINAL,DIRECT"];
        return [raw];
      }));
    }
    markContent(lines.join("\n"));
    setDeleteTarget(null);
  }

  async function save() {
    if (conflicts.length) return setView("conflicts");
    setSaving(true); setError("");
    try {
      let githubSaved = false;
      if (selectedRuleConfigId === "default" && saveEnabled) {
        const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, sha, message: "Update rules from MW Rules manager" }) });
        const data = await response.json();
        if (!response.ok) throw new Error([data.error, ...(data.details || [])].join("\n"));
        setSha(data.sha || sha); githubSaved = true;
      }
      const response = await fetch("/api/rule-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: selectedRuleConfigId, content }) });
      const data = await response.json();
      if (!response.ok || !data.config) throw new Error(data.error || "保存规则方案失败");
      setRuleConfigs((current) => current.map((config) => config.id === selectedRuleConfigId ? data.config : config));
      setDirty(false); setToast(githubSaved ? "默认方案已保存到 GitHub，订阅更新后即可生效" : "规则方案已保存，绑定它的订阅更新后即可生效");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="loading"><span className="brandMark">MW</span><p>正在读取 GitHub 配置…</p></div>;
  if (authRequired) return <main className="loginShell"><section className="loginCard"><span className="brandMark">MW</span><p className="eyebrow">PRIVATE RULE MANAGER</p><h1>小火箭规则管理</h1><p>仅允许 GitHub 用户 <strong>mmousew</strong> 登录。登录后才能查看和修改配置。</p>{loginError && <div className="loginError">{loginError}</div>}<a className="githubLogin" href="/api/auth/github/start"><span>◆</span> 使用 GitHub 登录</a><small>不会读取密码，也不会授权其他账号进入。</small></section></main>;

  return (
    <main className="shell">
      <header className="siteHeader">
        <div className="brand"><span className="brandMark">MW</span><span>Rules</span></div>
        <nav aria-label="主导航">{nav.map((item) => <button key={item.id} onClick={() => { setView(item.id); setQuery(""); }} className={`navItem ${view === item.id ? "active" : ""}`}>{item.label}</button>)}</nav>
        <div className="repoCard"><span className="statusDot" /><div><strong>{repository}</strong><small>{branch}</small></div></div><a className="siteLogout" href="/api/auth/github/logout">退出</a>
      </header>

      <section className="content">
        <header className="topbar">
          <div className="titleBlock"><div><p className="eyebrow">{isSchemeView ? `RULE SCHEME · ${selectedRuleConfig?.name || "当前方案"}` : "SHADOWROCKET CONFIGURATION"}</p><h1>{isSchemeView ? selectedRuleConfig?.name || "当前方案" : nav.find((item) => item.id === view)?.label}</h1></div></div>
          <div className="topActions"><button className="ghost" onClick={() => setPreview(true)}>预览配置</button>{(["groups", "rules", "sets"] as View[]).includes(view) && <button className="primary" onClick={openNew}>＋ 新增</button>}<button className={`saveButton ${dirty ? "ready" : ""}`} disabled={!dirty || saving} onClick={save}>{saving ? "保存中…" : selectedRuleConfigId === "default" && saveEnabled ? "保存到 GitHub" : "保存方案"}</button></div>
        </header>

        {error && !editor && <div className="errorBanner"><span>!</span><pre>{error}</pre><button onClick={() => setError("")}>×</button></div>}
        {toast && <div className="toast" onAnimationEnd={() => setToast("")}>{toast}</div>}

        {view === "overview" && <>
          <div className={`notice ${conflicts.length ? "warning" : ""}`}><span>{conflicts.length ? "!" : "✓"}</span><div><strong>{conflicts.length ? `发现 ${conflicts.length} 个问题` : "配置状态正常"}</strong><p>{conflicts.length ? "有规则引用了不存在的策略，请先处理。" : duplicateRuleCount ? `机场原始规则有 ${duplicateRuleCount} 处重叠，按文件顺序执行，不影响保存。` : saveEnabled ? "已连接 GitHub，可直接编辑并保存。" : "已连接只读数据，配置写入凭据后即可在线保存。"}</p></div><button onClick={() => setView("conflicts")}>查看检查结果</button></div>
          <section className="metrics"><article><span>国家与节点组</span><strong>{parsed.groups.filter((group) => group.items.some((item) => item.startsWith("policy-regex-filter"))).length}</strong><small>动态匹配机场节点</small></article><article><span>全部分组</span><strong>{parsed.groups.length}</strong><small>国家、服务与策略</small></article><article><span>有效规则</span><strong>{(parsed.rules.length + (parsed.finalRule ? 1 : 0)).toLocaleString()}</strong><small>包含最后的兜底规则</small></article><article><span>规则冲突</span><strong className={conflicts.length ? "bad" : "ok"}>{conflicts.length}</strong><small>{duplicateRuleCount ? `另有 ${duplicateRuleCount} 处重叠提示` : "保存前自动检查"}</small></article></section>
          <section className="panel"><div className="panelHead"><div><h2>常用分组</h2><p>节点筛选和分流规则分别管理，但会在这里汇总显示。</p></div><button className="textButton" onClick={() => setView("groups")}>查看全部 →</button></div><div className="groupGrid">{parsed.groups.filter((group) => ["德国", "Google", "PayPal", parsed.finalRule?.policy].includes(group.name)).map((group, i) => <GroupCard key={group.name} group={group} ruleCount={ruleCountForPolicy(group.name)} tone={["mint", "blue", "amber", "rose"][i]} onEdit={() => editGroup(group)} onRules={() => showGroupRules(group)} />)}</div></section>
          <section className="panel compact"><div className="panelHead"><div><h2>工作方式</h2><p>每次保存先检查冲突，再生成一条可追溯的 GitHub 提交。</p></div></div><div className="activity"><span className="activityIcon">↻</span><div><strong>在线配置与小火箭保持同一来源</strong><p>保存后在设备上更新配置即可生效</p></div><a href={sourceUrl} target="_blank" rel="noreferrer">打开仓库</a></div></section>
        </>}

        {isSchemeView && <section className="schemeWorkspace" aria-label={`${selectedRuleConfig?.name || "当前方案"}方案编辑区`}>
          <div className="schemeWorkspaceIntro"><div><strong>{selectedRuleConfig?.name || "当前方案"}</strong><p>这套方案的分组、域名和规则彼此独立，修改后只影响绑定此方案的订阅。</p></div><button type="button" className="ghost schemeBack" onClick={() => setView("configs")}>返回方案列表</button></div>
          <div className="schemeTabs" role="tablist" aria-label="方案内容"><span className="schemeTabsLabel">方案内容</span>{schemeTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} className={view === tab.id ? "active" : ""} onClick={() => { setView(tab.id); setQuery(""); }}><strong>{tab.label}</strong><small>{tab.description}</small></button>)}</div>
        </section>}

        {(isSchemeView) && <>
          <div className="toolbar"><label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "groups" ? "搜索分组或节点关键词" : "搜索域名、规则集或策略"} /></label>{view !== "groups" && query.trim() && filteredRules.length > 0 && <div className="bulkTransfer"><label className="selectAll"><input type="checkbox" checked={effectiveSelectedRuleIndexes.length === filteredRules.length} onChange={(event) => { setSelectionKey(filteredRuleKey); setSelectedRuleIndexes(event.target.checked ? filteredRules.map((rule) => rule.index) : []); }} />全选</label><span>转移到</span><select value={bulkTargetPolicy || policies[0] || ""} onChange={(event) => setBulkTargetPolicy(event.target.value)} aria-label="批量转移目标分组">{policies.map((policy) => <option key={policy}>{policy}</option>)}</select><button type="button" onClick={() => transferFilteredRules(bulkTargetPolicy || policies[0] || "")}>转移选中 {effectiveSelectedRuleIndexes.length} 条</button></div>}<span>{view === "groups" ? filteredGroups.length : visibleRuleCount} 项</span></div>
          {view === "groups" ? <><p className={`dragHelp ${query ? "disabled" : ""}`}>{query ? "清空搜索后可以拖拽调整完整分组顺序" : "按住左侧或整行拖动排序；也可以用上移/下移"}</p><div className="listPanel">{filteredGroups.map((group) => { const linked = parsed.rules.filter((rule) => rule.policy === group.name); const isFinalGroup = parsed.finalRule?.policy === group.name; const linkedCount = linked.length + (isFinalGroup ? 1 : 0); return <div
            className={`listRow groupListRow ${draggingGroup === group.name ? "dragging" : ""} ${dragTargetGroup === group.name && draggingGroup !== group.name ? "dropTarget" : ""}`}
            data-group-name={group.name}
            key={`${group.index}-${group.name}`}
            onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button")) return; startTouchGroupDrag(event, group); }}
            onPointerMove={moveTouchGroupDrag}
            onPointerUp={() => finishGroupDrag()}
            onPointerCancel={() => finishGroupDrag("", "")}
            onDragOver={(event) => { if (!dragSourceRef.current) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; dragTargetRef.current = group.name; setDragTargetGroup(group.name); }}
            onDrop={(event) => { event.preventDefault(); finishGroupDrag(event.dataTransfer.getData("text/plain") || dragSourceRef.current, group.name); }}
          ><button
            type="button"
            className="dragHandle"
            draggable={false}
            disabled={Boolean(query)}
            aria-label={`拖动调整「${group.name}」的顺序`}
            title={query ? "清空搜索后可排序" : "拖动排序，或使用上下方向键"}
            onDragStart={(event) => startNativeGroupDrag(event, group)}
            onDragEnd={() => finishGroupDrag("", "")}
            onPointerDown={(event) => startTouchGroupDrag(event, group)}
            onPointerMove={moveTouchGroupDrag}
            onPointerUp={() => finishGroupDrag()}
            onPointerCancel={() => finishGroupDrag("", "")}
            onKeyDown={(event) => moveGroupWithKeyboard(event, group)}
          ><span aria-hidden="true">⠿</span></button><div className="rowMain"><strong>{group.name}</strong><p>{isFinalGroup ? `系统兜底规则 · 未匹配流量会进入「${group.name}」 · 可在“节点筛选”中配置节点` : linked.length ? `${linked.length} 条分流规则 · ${linked.slice(0, 4).map((rule) => rule.value).join(" · ")}` : `${group.kind} · ${group.items.join(" · ")}`}</p></div><div className="reorderButtons" aria-label={`调整「${group.name}」顺序`}><button type="button" className="reorderButton" onClick={() => moveGroupByOffset(group, -1)} disabled={Boolean(query) || parsed.groups[0]?.name === group.name} aria-label={`上移「${group.name}」`} title="上移">↑</button><button type="button" className="reorderButton" onClick={() => moveGroupByOffset(group, 1)} disabled={Boolean(query) || parsed.groups.at(-1)?.name === group.name} aria-label={`下移「${group.name}」`} title="下移">↓</button></div><span className="pill">{linkedCount} 条规则</span><button onClick={() => showGroupRules(group)}>查看规则</button><button onClick={() => editGroup(group)}>节点筛选</button><button className="danger" onClick={() => removeGroup(group)}>删除</button></div>; })}</div></>
          : <>{viewingFinal && <div className="listNote finalRuleNote">这是系统兜底规则：未匹配到其它规则的流量会进入「{viewingGroup}」分组。它不是重复的代理分组，可通过“节点筛选”配置这个分组使用的节点。</div>}<div className="listPanel">{filteredRules.map((rule) => <div className="listRow" key={`${rule.index}-${rule.value}`}><input className="ruleSelect" type="checkbox" checked={effectiveSelectedRuleIndexes.includes(rule.index)} onChange={() => toggleRuleSelection(rule.index)} aria-label={`选择规则 ${rule.value}`} /><span className={`ruleType ${rule.type === "RULE-SET" ? "set" : ""}`}>{rule.type}<small>{RULE_TYPE_META[rule.type]?.label}</small></span><div className="rowMain"><strong>{rule.value}</strong><p>策略：{rule.policy}{rule.options.length ? ` · ${rule.options.join(", ")}` : ""}</p></div><span className="policy">{rule.policy}</span><button onClick={() => editRule(rule)}>编辑</button><button className="danger" onClick={() => removeRule(rule)}>删除</button></div>)}</div></>}
        </>}

        {view === "configs" && <RuleConfigManager configs={ruleConfigs} selectedId={selectedRuleConfigId} busy={ruleConfigBusy} onEdit={(id) => selectRuleConfig(id, true)} onCreate={(name) => void createRuleConfig(name)} onRename={(id, name) => void renameRuleConfig(id, name)} onSetDefault={(id) => void setRuleConfigDefault(id)} onRecover={(id) => void recoverHaoziRuleConfig(id)} onDelete={(id) => void deleteRuleConfig(id)} />}

        {view === "clash" && <ClashSubscription />}
        {view === "airports" && <ClashSubscription mode="airports" />}

        {view === "conflicts" && <section className="panel audit"><div className={`auditMark ${conflicts.length ? "warn" : ""}`}>{conflicts.length ? "!" : "✓"}</div><h2>{conflicts.length ? "需要处理后才能保存" : "配置检查通过"}</h2><p>{conflicts.length ? "以下规则需要确认策略名称。" : duplicateRuleCount ? `机场规则中有 ${duplicateRuleCount} 处重复匹配，这是机场原始配置的正常重叠，按规则顺序执行，不阻止保存。` : "代理分组引用与规则顺序均通过检查。"}</p>{conflicts.length > 0 && <ul>{conflicts.map((item) => <li key={item}>{item}</li>)}</ul>}<button className="ghost" onClick={() => setPreview(true)}>查看原始配置</button></section>}
      </section>

      {editor && <EditorModal editor={editor} setEditor={setEditor} policies={policies} countryGroups={parsed.groups.filter((group) => COUNTRY_GROUP_NAMES.has(group.name)).map((group) => group.name)} error={error} onSubmit={submitEditor} onImportCatalog={importCatalogRules} />}
      {deleteTarget && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭删除确认" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }} onKeyDown={(event) => { if (event.key === "Escape") setDeleteTarget(null); }}><section className="confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="confirmMark">!</span><h2 id="delete-title">确认删除？</h2><p>{deleteTarget.kind === "group" ? `将删除代理分组「${deleteTarget.group.name}」，并清理当前方案内的引用。` : `将删除规则「${deleteTarget.rule.value}」。`}</p>{deleteTarget.kind === "group" && <ul className="deleteImpactList"><li>{deleteTarget.impact.rules.length} 条规则会被移除</li><li>{deleteTarget.impact.parentGroups.length} 个分组会移除对它的引用{deleteTarget.impact.parentGroups.length ? "，空分组会自动保留 DIRECT" : ""}</li>{deleteTarget.impact.finalRule && <li>FINAL 会自动改为 DIRECT，保证配置仍可用</li>}</ul>}<small>删除会先暂存，点击“保存到 GitHub”后才会正式生效。</small><footer><button className="ghost" onClick={() => setDeleteTarget(null)}>取消</button><button className="deleteConfirm" onClick={confirmDelete}>确认删除</button></footer></section></div>}
      {preview && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭配置预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(false); }} onKeyDown={(event) => { if (event.key === "Escape") setPreview(false); }}><section className="previewModal" role="dialog" aria-modal="true" aria-labelledby="preview-title"><header><div><h2 id="preview-title">配置预览</h2><p>{content.split(/\r?\n/).length.toLocaleString()} 行 · {repository}</p></div><button onClick={() => setPreview(false)}>×</button></header><pre>{content}</pre></section></div>}
    </main>
  );
}

function LegacyClashSubscription() {
  type LinkRecord = { id: string; name: string; url: string; status: "active" | "revoked"; createdAt: number; revokedAt: number | null; legacy?: boolean };
  type SourceRecord = { index: number; name: string; kind: "url" | "content"; value: string | null; hidden: boolean; nodes: number | null };
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [airportSources, setAirportSources] = useState<SourceRecord[]>([]);
  const [extraSourceUrl, setExtraSourceUrl] = useState("");
  const [extraSourceFile, setExtraSourceFile] = useState<File | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [editingSource, setEditingSource] = useState<number | null>(null);
  const [editingSourceUrl, setEditingSourceUrl] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [qrLink, setQrLink] = useState("");
  const [qrLabel, setQrLabel] = useState("");
  const [pendingLinkAction, setPendingLinkAction] = useState<{ id: string; action: "revoke" | "delete" } | null>(null);

  useEffect(() => {
    fetch("/api/clash/link", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取订阅链接失败");
      setLinks(data.links || []);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "读取订阅链接失败"));
  }, []);

  useEffect(() => {
    fetch("/api/clash/source", { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取机场来源失败");
      setAirportSources(data.sources || []);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "读取机场来源失败"));
  }, []);

  async function copyLink(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function changeLink(id: string, action: "revoke" | "delete") {
    const response = await fetch(`/api/clash/link/${encodeURIComponent(id)}`, { method: action === "delete" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: action === "revoke" ? JSON.stringify({ action }) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作失败");
    if (action === "delete") setLinks((current) => current.filter((item) => item.id !== id));
    else setLinks((current) => current.map((item) => item.id === id ? { ...item, status: "revoked" } : item));
  }

  async function confirmLinkAction() {
    if (!pendingLinkAction) return;
    const action = pendingLinkAction;
    setPendingLinkAction(null);
    try { await changeLink(action.id, action.action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  }

  async function renameLink(id: string, name: string) {
    const response = await fetch(`/api/clash/link/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename", name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存名称失败");
    setLinks((current) => current.map((item) => item.id === id ? { ...item, name: name.trim() || "订阅链接" } : item));
  }

  async function addAirportSource(event: FormEvent) {
    event.preventDefault();
    if (!extraSourceUrl.trim() && !extraSourceFile) return setError("请输入订阅地址或选择 YAML 文件");
    setSourceBusy(true); setError("");
    try {
      const form = new FormData();
      form.set("sourceUrl", extraSourceUrl.trim());
      if (extraSourceFile) form.append("sourceFile", extraSourceFile, extraSourceFile.name);
      const response = await fetch("/api/clash/source", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "添加订阅来源失败");
      setAirportSources(data.sources || []); setExtraSourceUrl(""); setExtraSourceFile(null);
      if (data.link) setLinks((current) => [data.link, ...current]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加订阅来源失败"); }
    finally { setSourceBusy(false); }
  }

  async function createNewLink() {
    setSourceBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "new-link" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "生成新链接失败");
      if (data.link) setLinks((current) => [data.link, ...current]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "生成新链接失败"); }
    finally { setSourceBusy(false); }
  }

  async function removeAirportSource(index: number) {
    if (!window.confirm("删除这个机场来源后，现有订阅链接都会同步更新，确定删除吗？")) return;
    setSourceBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除订阅来源失败");
      setAirportSources(data.sources || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除订阅来源失败"); }
    finally { setSourceBusy(false); }
  }

  async function toggleAirportSource(index: number, hidden: boolean) {
    setSourceBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index, hidden }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新订阅来源失败");
      setAirportSources(data.sources || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新订阅来源失败"); }
    finally { setSourceBusy(false); }
  }

  async function renameAirportSource(index: number, name: string) {
    const response = await fetch("/api/clash/source", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index, name: name.trim() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存来源名称失败");
    setAirportSources(data.sources || []);
  }

  function startEditAirportSource(source: SourceRecord) {
    setEditingSource(source.index);
    setEditingSourceUrl(source.kind === "url" ? (source.value || "") : "");
  }

  async function saveAirportSourceEdit(index: number) {
    if (!editingSourceUrl.trim()) return setError("请输入新的机场订阅地址");
    setSourceBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index, value: editingSourceUrl.trim() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新机场地址失败");
      setAirportSources(data.sources || []);
      setEditingSource(null);
      setEditingSourceUrl("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新机场地址失败"); }
    finally { setSourceBusy(false); }
  }

  async function refreshCurrentConfig() {
    setSourceBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "refresh" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新当前配置失败");
      setAirportSources(data.sources || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新当前配置失败"); }
    finally { setSourceBusy(false); }
  }

  function shadowrocketUrl(value: string) {
    const token = value.split("/api/clash/")[1]?.split(/[?#]/, 1)[0];
    return token ? `https://656577.xyz/mw-shadowrocket.php?token=${encodeURIComponent(token)}` : value.replace("/api/clash/", "/api/shadowrocket/");
  }

  function clashRelayUrl(value: string) {
    const token = value.split("/api/clash/")[1]?.split(/[?#]/, 1)[0];
    return token ? `https://656577.xyz/mw-clash.php?token=${encodeURIComponent(token)}&compat=clashxmeta` : value;
  }

  async function showQr(value: string, label: string) {
    setError("");
    try {
      setQrCode(await QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17231e", light: "#ffffff" } }));
      setQrLink(value);
      setQrLabel(label);
    } catch {
      setError(`${label}二维码生成失败，请稍后重试`);
    }
  }

  return <section className="clashPanel"><div className="clashBadge">META</div><p className="eyebrow">PRIVATE SUBSCRIPTION</p><h2>ClashX Meta 私有订阅</h2><p className="clashIntro">在下面添加机场订阅或上传 YAML 文件。首次添加会自动生成链接，后续添加会同步到现有链接。</p>{error && <div className="clashError">{error}</div>}<section className="sourceManager"><div className="sourceManagerHead"><div><h3>当前机场来源</h3><p>这里显示已经添加成功的机场；添加或删除会同步到现有订阅链接。</p></div></div><div className="sourceList">{airportSources.length ? airportSources.map((source) => <div className={`sourceRow ${source.hidden ? "sourceHidden" : ""}`} key={source.index}><div><input className="sourceNameInput" value={source.name} onChange={(event) => setAirportSources((current) => current.map((item) => item.index === source.index ? { ...item, name: event.target.value } : item))} onBlur={() => void renameAirportSource(source.index, source.name).catch((cause) => setError(cause instanceof Error ? cause.message : "保存来源名称失败"))} aria-label="机场来源名称" /><small>{source.hidden ? "已隐藏显示 · " : ""}{source.kind === "content" ? `本地文件 · ${source.nodes ?? 0} 个节点` : "在线订阅地址"}</small></div>{editingSource === source.index && source.kind === "url" && <div className="sourceEditRow"><input value={editingSourceUrl} onChange={(event) => setEditingSourceUrl(event.target.value)} placeholder="新的机场订阅地址" aria-label="新的机场订阅地址" /><button type="button" className="primary" disabled={sourceBusy} onClick={() => void saveAirportSourceEdit(source.index)}>保存</button><button type="button" className="ghost" disabled={sourceBusy} onClick={() => { setEditingSource(null); setEditingSourceUrl(""); }}>取消</button></div>}<button type="button" className="ghost" disabled={sourceBusy || (!source.hidden && airportSources.filter((item) => !item.hidden).length <= 1)} onClick={() => void toggleAirportSource(source.index, !source.hidden)}>{source.hidden ? "取消隐藏" : "隐藏"}</button>{source.kind === "url" && <button type="button" className="ghost" disabled={sourceBusy} onClick={() => startEditAirportSource(source)}>编辑</button>}<button type="button" className="danger" disabled={sourceBusy || airportSources.length <= 1} onClick={() => void removeAirportSource(source.index)}>删除</button></div>) : <p className="clashLoading">还没有读取到机场来源。</p>}</div><form className="sourceAddForm" onSubmit={addAirportSource}><div className="sourceAddFields"><label>新增订阅地址<input value={extraSourceUrl} onChange={(event) => setExtraSourceUrl(event.target.value)} placeholder="https://新的机场订阅地址" /></label><label className="filePicker">或者上传 YAML 文件<input type="file" accept=".yaml,.yml,.conf,text/plain,application/yaml" onChange={(event) => setExtraSourceFile(event.target.files?.[0] || null)} /></label>{extraSourceFile && <div className="selectedFiles">已选择：{extraSourceFile.name}</div>}<button className="primary addSourceButton" type="submit" disabled={sourceBusy}>{sourceBusy ? "处理中…" : "添加到当前配置"}</button></div><div className="sourceActionRow"><button className="primary" type="button" disabled={sourceBusy || airportSources.length === 0} onClick={() => void createNewLink()}>生成新链接</button><button className="ghost" type="button" disabled={sourceBusy || airportSources.length === 0} onClick={() => void refreshCurrentConfig()}>更新当前配置</button></div></form></section><div className="clashLinkList">{links.length ? links.map((item) => <article className={`clashLinkCard ${item.status === "revoked" ? "revoked" : ""}`} key={item.id}><div className="clashCardActions">{item.status === "active" && <button type="button" className="ghost" onClick={() => setPendingLinkAction({ id: item.id, action: "revoke" })}>失效</button>}<button type="button" className="danger" onClick={() => setPendingLinkAction({ id: item.id, action: "delete" })}>删除</button></div><div className="clashLinkMeta"><input className="clashNameInput" value={item.name} onChange={(event) => setLinks((current) => current.map((link) => link.id === item.id ? { ...link, name: event.target.value } : link))} onBlur={() => void renameLink(item.id, item.name).catch((cause) => setError(cause instanceof Error ? cause.message : "保存名称失败"))} aria-label="订阅备注名称" /><span>{item.status === "active" ? "已启用" : "已失效"} · {item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "历史链接"}</span></div><label className="clientLinkLabel">CLASH 地址<div className="clientLinkRow"><input readOnly value={clashRelayUrl(item.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(clashRelayUrl(item.url))}>复制</button></div></label><label className="clientLinkLabel">小火箭地址<div className="clientLinkRow"><input readOnly value={shadowrocketUrl(item.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(shadowrocketUrl(item.url))}>复制</button></div></label><div className="clashActions">{item.status === "active" && <button type="button" className="ghost" onClick={() => void showQr(clashRelayUrl(item.url), "CLASH")}>CLASH 二维码</button>}{item.status === "active" && <button type="button" className="ghost" onClick={() => void showQr(shadowrocketUrl(item.url), "小火箭")}>小火箭二维码</button>}</div></article>) : <p className="clashLoading">还没有订阅链接，请在上方添加第一条机场来源。</p>}</div><ul><li>两个地址共用同一个订阅令牌，失效或删除会同时停止访问。</li><li>CLASH 地址返回 YAML，小火箭地址返回 Shadowrocket 配置。</li><li>同一条链接会随 GitHub 规则和机场节点更新。</li></ul>{pendingLinkAction && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭订阅操作确认" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingLinkAction(null); }} onKeyDown={(event) => { if (event.key === "Escape") setPendingLinkAction(null); }}><section className="confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="link-action-title"><span className="confirmMark">!</span><h2 id="link-action-title">确认{pendingLinkAction.action === "delete" ? "删除" : "使链接失效"}？</h2><p>{pendingLinkAction.action === "delete" ? "删除后将无法恢复这条订阅链接。" : "失效后这条订阅链接将无法继续获取配置。"}</p><footer><button className="ghost" type="button" onClick={() => setPendingLinkAction(null)}>取消</button><button className="deleteConfirm" type="button" onClick={() => void confirmLinkAction()}>确认</button></footer></section></div>}{qrCode && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭二维码" onMouseDown={(event) => { if (event.target === event.currentTarget) { setQrCode(""); setQrLink(""); setQrLabel(""); } }} onKeyDown={(event) => { if (event.key === "Escape") { setQrCode(""); setQrLink(""); setQrLabel(""); } }}><section className="qrModal" role="dialog" aria-modal="true" aria-labelledby="qr-title"><header><div><h2 id="qr-title">{qrLabel} 订阅二维码</h2><p>使用对应客户端扫描</p></div><button type="button" onClick={() => { setQrCode(""); setQrLink(""); setQrLabel(""); }}>×</button></header><img src={qrCode} alt={`${qrLabel} 私有订阅二维码`} /><button type="button" className="ghost qrCopy" onClick={() => void copyLink(qrLink)}>{copied ? "已复制订阅链接" : "复制订阅链接"}</button></section></div>}</section>;
}

void LegacyClashSubscription;

function RuleConfigManager({ configs, selectedId, busy, onEdit, onCreate, onRename, onSetDefault, onRecover, onDelete }: {
  configs: RuleConfigRecord[];
  selectedId: string;
  busy: boolean;
  onEdit: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onSetDefault: (id: string) => void;
  onRecover: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return <section className="panel ruleConfigPanel">
    <div className="panelHead"><div><h2>规则方案列表</h2><p>每个方案都是独立的一整套分组、域名和规则。进入方案后再编辑，不会互相覆盖。</p></div><span className="configCount">{configs.length} 个方案</span></div>
    <div className="ruleConfigHint"><strong>当前方案：{configs.find((config) => config.id === selectedId)?.name || "默认规则"}</strong><span>点击“编辑方案”后，在方案内部切换分组、域名、规则；新增方案会复制标记为默认的方案。</span></div>
    <div className="ruleConfigList">{configs.map((config) => <article className={`ruleConfigCard ${config.id === selectedId ? "selected" : ""}`} key={config.id}>
      <div className="ruleConfigMain"><input value={drafts[config.id] ?? config.name} onChange={(event) => setDrafts((current) => ({ ...current, [config.id]: event.target.value }))} onBlur={() => { const name = (drafts[config.id] ?? config.name).trim(); if (name && name !== config.name) onRename(config.id, name); }} aria-label={`${config.name}方案名称`} /><p>{config.id === "default" ? "默认方案" : "独立方案"} · {config.profile_count || 0} 个订阅使用 · {new Date(config.updated_at).toLocaleString("zh-CN")}</p></div>
      <div className="ruleConfigActions">{config.id === selectedId && <span className="configCurrentBadge">当前编辑</span>}{config.is_template_default ? <span className="configTemplateBadge">复制默认</span> : <button type="button" className="ghost" disabled={busy} onClick={() => onSetDefault(config.id)}>设为默认</button>}{config.id === "haozi-custom" && <button type="button" className="ghost" disabled={busy} onClick={() => onRecover(config.id)}>恢复原始规则</button>}<button type="button" className="ghost" disabled={busy} onClick={() => onEdit(config.id)}>编辑方案</button>{config.id !== "default" && <button type="button" className="danger" disabled={busy} onClick={() => onDelete(config.id)}>删除</button>}</div>
    </article>)}</div>
    <form className="ruleConfigCreate" onSubmit={(event) => { event.preventDefault(); const name = newName.trim(); if (!name) return; onCreate(name); setNewName(""); }}><label>新增方案名称<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：工作、备用、家庭" /></label><button type="submit" className="primary" disabled={busy || !newName.trim()}>复制默认方案并新增</button></form>
  </section>;
}

function ClashSubscription({ mode = "private" }: { mode?: "private" | "airports" }) {
  type SourceRecord = { index: number; sourceId: string | null; name: string; kind: "url" | "content"; value: string | null; hidden: boolean; nodes: number | null };
  type ProfileRecord = { id: string; name: string; ruleConfigId: string; ruleConfigName: string; sourceCount: number; nodeCount: number | null; updatedAt: number; sources?: SourceRecord[] };
  type RuleConfigOption = { id: string; name: string };
  type LinkRecord = { id: string; profileId: string; name: string; url: string; status: "active" | "revoked"; createdAt: number; revokedAt: number | null; legacy?: boolean };
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [airportSources, setAirportSources] = useState<AirportSourceRecord[]>([]);
  const [airportPickerOpen, setAirportPickerOpen] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorProfileId, setEditorProfileId] = useState<string | null>(null);
  const [editorSources, setEditorSources] = useState<SourceRecord[]>([]);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [pendingLinkAction, setPendingLinkAction] = useState<{ id: string; action: "revoke" | "delete" } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [qrLink, setQrLink] = useState("");
  const [qrLabel, setQrLabel] = useState("");
  const [ruleConfigs, setRuleConfigs] = useState<RuleConfigOption[]>([]);

  useEffect(() => { void loadPage(); }, []);

  async function loadPage() {
    try {
      const [profileResponse, linkResponse, ruleConfigResponse] = await Promise.all([
        fetch("/api/clash/profile", { cache: "no-store" }),
        fetch("/api/clash/link", { cache: "no-store" }),
        fetch("/api/rule-config", { cache: "no-store" }),
      ]);
      const airportResponse = await fetch("/api/clash/airport", { cache: "no-store" });
      const profileData = await profileResponse.json();
      const linkData = await linkResponse.json();
      const ruleConfigData = await ruleConfigResponse.json();
      const airportData = await airportResponse.json();
      if (!profileResponse.ok) throw new Error(profileData.error || "读取订阅配置失败");
      if (!linkResponse.ok) throw new Error(linkData.error || "读取订阅链接失败");
      if (!ruleConfigResponse.ok) throw new Error(ruleConfigData.error || "读取规则方案失败");
      if (!airportResponse.ok) throw new Error(airportData.error || "读取机场列表失败");
      setProfiles(profileData.profiles || []);
      setLinks(linkData.links || []);
      setRuleConfigs((ruleConfigData.configs || []).map((config: RuleConfigRecord) => ({ id: config.id, name: config.name })));
      setAirportSources(airportData.sources || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取订阅配置失败");
    }
  }

  async function changeProfileRuleConfig(profile: ProfileRecord, ruleConfigId: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: profile.id, ruleConfigId }) });
      const data = await response.json();
      if (!response.ok || !data.profile) throw new Error(data.error || "保存规则方案选择失败");
      setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, ruleConfigId: data.profile.ruleConfigId, ruleConfigName: data.profile.ruleConfigName } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存规则方案选择失败");
    } finally { setBusy(false); }
  }

  function updateProfileSources(profileId: string, sources: SourceRecord[]) {
    const nodeCount = sources.every((source) => source.nodes !== null) ? sources.reduce((total, source) => total + (source.nodes || 0), 0) : null;
    setEditorSources(sources);
    setProfiles((current) => current.map((profile) => profile.id === profileId ? { ...profile, sourceCount: sources.length, nodeCount, updatedAt: Date.now(), sources } : profile));
  }

  async function addProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.set("name", newProfileName.trim() || "订阅配置");
      const response = await fetch("/api/clash/profile", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "新增订阅配置失败");
      const profile = data.profile as ProfileRecord;
      setProfiles((current) => [...current, profile]);
      setNewProfileOpen(false); setNewProfileName("");
      setEditorProfileId(profile.id); setEditorSources(profile.sources || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新增订阅配置失败");
    } finally { setBusy(false); }
  }

  async function openEditor(profile: ProfileRecord) {
    if (editorProfileId === profile.id) {
      setEditorProfileId(null); setAirportPickerOpen(false); return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/clash/source?profileId=${encodeURIComponent(profile.id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取配置来源失败");
      setEditorProfileId(profile.id); setAirportPickerOpen(false);
      updateProfileSources(profile.id, data.sources || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取配置来源失败");
    } finally { setBusy(false); }
  }

  async function addAirportToProfile(source: AirportSourceRecord) {
    if (!editorProfileId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: editorProfileId, airportSourceId: source.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "添加机场失败");
      updateProfileSources(editorProfileId, data.sources || []);
      setAirportPickerOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加机场失败");
    } finally { setBusy(false); }
  }

  async function removeSource(index: number) {
    if (!editorProfileId || !window.confirm("删除这个来源后，只会从当前订阅配置移除，不会删除机场列表中的总来源。确定删除吗？")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: editorProfileId, index }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "移除订阅来源失败");
      updateProfileSources(editorProfileId, data.sources || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除订阅来源失败");
    } finally { setBusy(false); }
  }

  async function refreshProfile(profile: ProfileRecord) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: profile.id, action: "refresh" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新当前配置失败");
      if (editorProfileId === profile.id) updateProfileSources(profile.id, data.sources || []);
      await loadPage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新当前配置失败");
    } finally { setBusy(false); }
  }

  async function createNewLink(profile: ProfileRecord) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/clash/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: profile.id, action: "new-link" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "生成新链接失败");
      if (data.link) setLinks((current) => [data.link, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成新链接失败");
    } finally { setBusy(false); }
  }

  async function changeLink(id: string, action: "revoke" | "delete") {
    const response = await fetch(`/api/clash/link/${encodeURIComponent(id)}`, { method: action === "delete" ? "DELETE" : "PATCH", headers: { "Content-Type": "application/json" }, body: action === "revoke" ? JSON.stringify({ action }) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "操作链接失败");
    if (action === "delete") setLinks((current) => current.filter((item) => item.id !== id));
    else setLinks((current) => current.map((item) => item.id === id ? { ...item, status: "revoked" } : item));
  }

  async function copyLink(value: string) {
    await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  }

  function shadowrocketUrl(value: string) {
    const token = value.split("/api/clash/")[1]?.split(/[?#]/, 1)[0];
    return token ? `https://656577.xyz/mw-shadowrocket.php?token=${encodeURIComponent(token)}` : value.replace("/api/clash/", "/api/shadowrocket/");
  }

  function shadowrocketImportUrl(value: string) {
    return `shadowrocket://config/add/${shadowrocketConfigUrl(value)}`;
  }

  function shadowrocketAddUrl(value: string) {
    return `shadowrocket://add/${shadowrocketUrl(value)}`;
  }

  function shadowrocketConfigUrl(value: string) {
    const token = value.split("/api/clash/")[1]?.split(/[?#]/, 1)[0];
    return token ? `https://656577.xyz/mw-shadowrocket-config.php?token=${encodeURIComponent(token)}` : value.replace("/api/clash/", "/api/shadowrocket-config/");
  }

  function clashRelayUrl(value: string) {
    const token = value.split("/api/clash/")[1]?.split(/[?#]/, 1)[0];
    return token ? `https://656577.xyz/mw-clash.php?token=${encodeURIComponent(token)}&compat=clashxmeta` : value;
  }

  async function showQr(value: string, label: string) {
    try {
      setQrCode(await QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17231e", light: "#ffffff" } }));
      setQrLink(value); setQrLabel(label);
    } catch { setError(`${label}二维码生成失败，请稍后重试`); }
  }

  const profileLinkCard = (link: LinkRecord) => <article className={`clashLinkCard ${link.status === "revoked" ? "revoked" : ""}`} key={link.id}>
    <div className="clashCardActions">{link.status === "active" && <button type="button" className="ghost" onClick={() => setPendingLinkAction({ id: link.id, action: "revoke" })}>失效</button>}<button type="button" className="danger" onClick={() => setPendingLinkAction({ id: link.id, action: "delete" })}>删除</button></div>
    <div className="clashLinkMeta"><span>{link.status === "active" ? "已启用" : "已失效"} · {link.createdAt ? new Date(link.createdAt).toLocaleString("zh-CN") : "历史链接"}</span></div>
    <label className="clientLinkLabel">CLASH 地址<div className="clientLinkRow"><input readOnly value={clashRelayUrl(link.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(clashRelayUrl(link.url))}>复制</button>{link.status === "active" && <button type="button" className="inlineQr" onClick={() => void showQr(clashRelayUrl(link.url), "CLASH")}>二维码</button>}</div></label>
    <label className="clientLinkLabel">小火箭订阅地址<div className="clientLinkRow"><input readOnly value={shadowrocketUrl(link.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(shadowrocketUrl(link.url))}>复制订阅</button>{link.status === "active" && <a className="inlineImport" href={shadowrocketAddUrl(link.url)}>添加订阅</a>}{link.status === "active" && <button type="button" className="inlineQr" onClick={() => void showQr(shadowrocketUrl(link.url), "小火箭订阅")}>二维码</button>}</div></label>
    <label className="clientLinkLabel">小火箭配置地址（仅规则与分组）<div className="clientLinkRow"><input readOnly value={shadowrocketConfigUrl(link.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(shadowrocketConfigUrl(link.url))}>复制配置</button>{link.status === "active" && <a className="inlineImport" href={shadowrocketImportUrl(link.url)}>导入配置</a>}{link.status === "active" && <button type="button" className="inlineQr" onClick={() => void showQr(shadowrocketImportUrl(link.url), "小火箭配置")}>二维码</button>}</div></label>
  </article>;

  const availableAirports = (sources: SourceRecord[]) => airportSources.filter((source) => !source.hidden && !sources.some((entry) => entry.sourceId === source.id || (entry.kind === source.kind && source.kind === "url" && entry.value === source.sourceUrl)));

  return <section className="clashPanel">
    {mode === "private" && <div className="subscriptionHead"><h2>私有订阅</h2><button type="button" className="primary" onClick={() => { setNewProfileOpen((value) => !value); setError(""); }}>＋ 新增订阅配置</button></div>}
    {mode === "private" && <div className="moduleConflictNotice"><strong>小火箭订阅与配置已经分开</strong><span>订阅地址负责首页节点；配置地址只包含规则和分组，不包含节点，可在配置列表单独更新。</span></div>}
    {error && <div className="clashError">{error}</div>}
    {mode === "airports" ? <AirportList sources={airportSources} onSourcesChange={setAirportSources} onError={setError} /> : <>
      {newProfileOpen && <form className="profileCreateForm" onSubmit={addProfile}><label>配置备注名称<input value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder="例如：我的备用机场" /></label><p className="formHint">新增后在编辑来源里从“机场列表”选择要加入的订阅。</p><div className="profileEditorActions"><button className="primary" type="submit" disabled={busy}>{busy ? "处理中…" : "保存并新增配置"}</button><button className="ghost" type="button" onClick={() => setNewProfileOpen(false)}>取消</button></div></form>}
      <section className="profileList">{profiles.length ? profiles.map((profile) => {
        const profileLinks = links.filter((link) => link.profileId === profile.id || (!link.profileId && profile.id === "default"));
        const editing = editorProfileId === profile.id;
        return <article className="profileCard" key={profile.id}>
          <div className="profileCardHead"><div className="profileCardTitle"><input value={profile.name} onChange={(event) => setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, name: event.target.value } : item))} onBlur={() => { const name = profile.name.trim() || "订阅配置"; void fetch("/api/clash/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: profile.id, name }) }).catch(() => setError("保存配置名称失败")); }} aria-label="订阅配置名称" /><p>{profile.sourceCount} 个来源 · {profile.nodeCount == null ? "节点数待更新" : "约 " + profile.nodeCount + " 个节点"} · {profileLinks.length} 条链接</p><label className="profileRuleConfig"><span>规则方案</span><select value={profile.ruleConfigId || "default"} disabled={busy || !ruleConfigs.length} onChange={(event) => void changeProfileRuleConfig(profile, event.target.value)}>{ruleConfigs.map((config) => <option key={config.id} value={config.id}>{config.name}</option>)}</select></label></div><div className="profileCardHeadActions"><button type="button" className="ghost" disabled={busy || profile.sourceCount === 0} onClick={() => void createNewLink(profile)}>＋ 生成新链接</button><button type="button" className="ghost" disabled={busy || profile.sourceCount === 0} onClick={() => void refreshProfile(profile)}>更新当前配置</button><button type="button" className={editing ? "ghost" : "primary"} onClick={() => void openEditor(profile)}>{editing ? "收起编辑器" : "编辑来源"}</button></div></div>
          {editing && <section className="profileEditor"><div className="profileEditorHead"><div><h4>编辑「{profile.name}」的来源</h4><p>这里只能选择机场列表中的来源；移除只影响当前配置。</p></div><button type="button" className="ghost" onClick={() => { setEditorProfileId(null); setAirportPickerOpen(false); }}>关闭</button></div>
            <div className="sourceList">{editorSources.length ? editorSources.map((source) => <div className={`sourceRow ${source.hidden ? "sourceHidden" : ""}`} key={`${profile.id}-${source.index}`}><div><strong>{source.name}</strong><small>{source.kind === "content" ? `本地文件 · ${source.nodes ?? 0} 个节点` : source.value || "在线订阅地址"}</small></div><button type="button" className="danger" disabled={busy} onClick={() => void removeSource(source.index)}>从当前配置移除</button></div>) : <p className="clashLoading">当前还没有来源，请从机场列表选择。</p>}</div>
            <div className="sourceAddForm"><button className="primary addSourceButton" type="button" onClick={() => setAirportPickerOpen((value) => !value)} disabled={busy}>{airportPickerOpen ? "收起机场列表" : "＋ 从机场列表添加"}</button>{airportPickerOpen && <div className="airportPicker">{availableAirports(editorSources).map((source) => <div className="airportPickerRow" key={source.id}><div><strong>{source.name}</strong><small>{source.kind === "url" ? source.sourceUrl : "本地 YAML 文件"} · {source.nodeCount == null ? "节点数待更新" : source.nodeCount + " 个节点"}</small></div><button type="button" className="ghost" disabled={busy} onClick={() => void addAirportToProfile(source)}>添加</button></div>)}{availableAirports(editorSources).length === 0 && <p className="clashLoading">机场列表中没有可添加的订阅，请先去机场列表新增。</p>}</div>}</div>
          </section>}
          {profileLinks.length ? profileLinks.map(profileLinkCard) : <p className="clashLoading">还没有链接，请先添加来源后生成新链接。</p>}
        </article>;
      }) : <p className="clashLoading">还没有订阅配置，请先新增一个配置。</p>}</section>
      <ul><li>机场列表是总表，私有订阅这里只管理关联关系。</li><li>移除来源不会删除机场列表中的订阅；机场列表删除才会同步清理所有关联。</li><li>小火箭先添加订阅，再导入规则配置；配置文件没有节点定义，不会重复生成节点。</li></ul>
    </>}
    {pendingLinkAction && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭订阅操作确认" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingLinkAction(null); }} onKeyDown={(event) => { if (event.key === "Escape") setPendingLinkAction(null); }}><section className="confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="link-action-title"><span className="confirmMark">!</span><h2 id="link-action-title">确认{pendingLinkAction.action === "delete" ? "删除" : "使链接失效"}？</h2><p>{pendingLinkAction.action === "delete" ? "删除后将无法恢复这条订阅链接。" : "失效后这条订阅链接将无法继续获取配置。"}</p><footer><button className="ghost" type="button" onClick={() => setPendingLinkAction(null)}>取消</button><button className="deleteConfirm" type="button" onClick={() => { const action = pendingLinkAction; setPendingLinkAction(null); void changeLink(action.id, action.action).catch((cause) => setError(cause instanceof Error ? cause.message : "操作链接失败")); }}>确认</button></footer></section></div>}
    {qrCode && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭二维码" onMouseDown={(event) => { if (event.target === event.currentTarget) { setQrCode(""); setQrLink(""); setQrLabel(""); } }} onKeyDown={(event) => { if (event.key === "Escape") { setQrCode(""); setQrLink(""); setQrLabel(""); } }}><section className="qrModal" role="dialog" aria-modal="true" aria-labelledby="qr-title"><header><div><h2 id="qr-title">{qrLabel} 二维码</h2><p>{qrLabel === "小火箭订阅" ? "请使用小火箭首页的扫码功能" : "使用对应客户端扫描"}</p></div><button type="button" onClick={() => { setQrCode(""); setQrLink(""); setQrLabel(""); }}>×</button></header><img src={qrCode} alt={`${qrLabel} 私有订阅二维码`} /><button type="button" className="ghost qrCopy" onClick={() => void copyLink(qrLink)}>{copied ? "已复制地址" : "复制二维码地址"}</button></section></div>}
  </section>;
}

function AirportList({ sources, onSourcesChange, onError }: { sources: AirportSourceRecord[]; onSourcesChange: (sources: AirportSourceRecord[]) => void; onError: (message: string) => void }) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [nodesBySource, setNodesBySource] = useState<Record<string, AirportNodeRecord[]>>({});
  const [nodesLoading, setNodesLoading] = useState<Record<string, boolean>>({});
  const [nodesError, setNodesError] = useState<Record<string, string>>({});
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [controllerUrl, setControllerUrl] = useState("http://127.0.0.1:9090");
  const [controllerSecret, setControllerSecret] = useState("");
  const [testNote, setTestNote] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem("mw_clash_controller_url");
    if (saved) setControllerUrl(saved);
  }, []);

  function replaceSource(source: AirportSourceRecord) {
    onSourcesChange(sources.map((item) => item.id === source.id ? source : item));
    setNodesBySource((current) => { const next = { ...current }; delete next[source.id]; return next; });
    setNodesError((current) => { const next = { ...current }; delete next[source.id]; return next; });
  }

  async function loadNodes(source: AirportSourceRecord) {
    if (nodesBySource[source.id] || nodesLoading[source.id]) return;
    setNodesLoading((current) => ({ ...current, [source.id]: true }));
    setNodesError((current) => ({ ...current, [source.id]: "" }));
    try {
      const response = await fetch(`/api/clash/airport/nodes?id=${encodeURIComponent(source.id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取节点失败");
      const nodes = Array.isArray(data.nodes) ? data.nodes as AirportNodeRecord[] : [];
      setNodesBySource((current) => ({ ...current, [source.id]: nodes }));
      return nodes;
    } catch (cause) {
      setNodesError((current) => ({ ...current, [source.id]: cause instanceof Error ? cause.message : "读取节点失败" }));
      return null;
    } finally {
      setNodesLoading((current) => ({ ...current, [source.id]: false }));
    }
  }

  async function openNodes(source: AirportSourceRecord) {
    if (expandedSourceId === source.id) {
      setExpandedSourceId(null);
      return;
    }
    setExpandedSourceId(source.id);
    await loadNodes(source);
  }

  async function testNodes(source: AirportSourceRecord) {
    const nodes = nodesBySource[source.id] || await loadNodes(source);
    if (!nodes?.length) {
      setNodesError((current) => ({ ...current, [source.id]: "没有可测速的节点，请先更新这个机场来源" }));
      return;
    }
    const baseUrl = controllerUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl)) {
      setNodesError((current) => ({ ...current, [source.id]: "ClashX Meta 地址格式不正确" }));
      return;
    }
    setTestingSourceId(source.id);
    setNodesError((current) => ({ ...current, [source.id]: "" }));
    setTestNote("");
    try {
      const headers: HeadersInit = controllerSecret.trim() ? { Authorization: `Bearer ${controllerSecret.trim()}` } : {};
      const proxiesResponse = await fetch(`${baseUrl}/proxies`, { headers, cache: "no-store" });
      const proxiesData = await proxiesResponse.json().catch(() => ({}));
      if (!proxiesResponse.ok) throw new Error(`ClashX Meta 接口返回 ${proxiesResponse.status}`);
      const proxyMap = proxiesData && typeof proxiesData.proxies === "object" && proxiesData.proxies ? proxiesData.proxies as Record<string, unknown> : {};
      const normalizeNodeName = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
      const controllerNodes = Object.entries(proxyMap).map(([key, value]) => {
        const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const name = typeof record.name === "string" ? record.name : key;
        return { key, name, aliases: [normalizeNodeName(key), normalizeNodeName(name)], server: typeof record.server === "string" ? record.server : "", port: Number(record.port) };
      });
      const findControllerNode = (node: AirportNodeRecord) => {
        const normalized = normalizeNodeName(node.name);
        const exact = controllerNodes.find((item) => item.aliases.includes(normalized));
        if (exact) return exact;
        const nameMatches = controllerNodes.filter((item) => item.aliases.some((alias) => alias.includes(normalized) || normalized.includes(alias)));
        if (nameMatches.length === 1) return nameMatches[0];
        const addressMatch = controllerNodes.find((item) => item.server && item.server.toLowerCase() === node.server.toLowerCase() && Number.isInteger(item.port) && item.port === node.port);
        return addressMatch;
      };
      const targetUrl = encodeURIComponent("https://www.gstatic.com/generate_204");
      const tested: AirportNodeRecord[] = [];
      for (let index = 0; index < nodes.length; index += 6) {
        const batch = await Promise.all(nodes.slice(index, index + 6).map(async (node) => {
          const controllerNode = findControllerNode(node);
          if (!controllerNode) return { ...node, status: "unloaded" as const, latency: undefined, reason: "当前 ClashX Meta 配置未加载此节点" };
          try {
            const response = await fetch(`${baseUrl}/proxies/${encodeURIComponent(controllerNode.key)}/delay?timeout=8000&url=${targetUrl}`, { headers, cache: "no-store" });
            const data = await response.json().catch(() => ({}));
            const latency = Number(data?.delay);
            if (!response.ok || !Number.isFinite(latency) || latency <= 0) return { ...node, status: "invalid" as const, latency: undefined, reason: "节点测速失败" };
            return { ...node, status: "valid" as const, latency, reason: "测速成功" };
          } catch {
            return { ...node, status: "invalid" as const, latency: undefined, reason: "无法连接 ClashX Meta" };
          }
        }));
        tested.push(...batch);
      }
      setNodesBySource((current) => ({ ...current, [source.id]: tested }));
      const successCount = tested.filter((node) => node.status === "valid").length;
      const unloadedCount = tested.filter((node) => node.status === "unloaded").length;
      setTestNote(`${source.name} 测速完成：${successCount}/${tested.length} 个节点有响应${unloadedCount ? `，${unloadedCount} 个未加载到当前 ClashX Meta 配置` : ""}。`);
    } catch (cause) {
      setNodesError((current) => ({ ...current, [source.id]: cause instanceof Error ? `${cause.message}。请检查 ClashX Meta 的 external-controller、端口、Secret 和跨域设置` : "无法连接 ClashX Meta，请检查本机测速设置" }));
    } finally {
      setTestingSourceId(null);
    }
  }

  async function addSource(event: FormEvent) {
    event.preventDefault();
    if (!sourceUrl.trim() && !sourceFile) return onError("请填写机场订阅地址或选择 YAML 文件");
    if (sourceUrl.trim() && sourceFile) return onError("请只选择订阅地址或文件其中一种");
    setBusy(true); onError("");
    try {
      const form = new FormData();
      form.set("name", name.trim()); form.set("sourceUrl", sourceUrl.trim());
      if (sourceFile) form.append("sourceFile", sourceFile, sourceFile.name);
      const response = await fetch("/api/clash/airport", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "新增机场失败");
      if (data.source) onSourcesChange([...sources, data.source]);
      setFormOpen(false); setName(""); setSourceUrl(""); setSourceFile(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "新增机场失败");
    } finally { setBusy(false); }
  }

  async function updateSource(source: AirportSourceRecord) {
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/clash/airport", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: source.id, action: "refresh" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新机场失败");
      if (data.source) replaceSource(data.source);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "更新机场失败");
    } finally { setBusy(false); }
  }

  async function toggleHidden(source: AirportSourceRecord) {
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/clash/airport", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: source.id, action: source.hidden ? "unhide" : "hide" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "更新隐藏状态失败");
      if (data.source) replaceSource(data.source);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "更新隐藏状态失败");
    } finally { setBusy(false); }
  }

  async function deleteSource(source: AirportSourceRecord) {
    if (!window.confirm(`删除“${source.name}”后，会从所有私有订阅配置中移除，但不会删除已经生成的链接。确定继续吗？`)) return;
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/clash/airport", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: source.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "删除机场失败");
      onSourcesChange(sources.filter((item) => item.id !== source.id));
      setNodesBySource((current) => { const next = { ...current }; delete next[source.id]; return next; });
      setNodesError((current) => { const next = { ...current }; delete next[source.id]; return next; });
      if (expandedSourceId === source.id) setExpandedSourceId(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "删除机场失败");
    } finally { setBusy(false); }
  }

  async function saveEdit(event: FormEvent, source: AirportSourceRecord) {
    event.preventDefault();
    setBusy(true); onError("");
    try {
      const form = new FormData();
      form.set("id", source.id); form.set("name", editingName.trim());
      if (source.kind === "url") form.set("sourceUrl", editingUrl.trim());
      if (editingFile) form.append("sourceFile", editingFile, editingFile.name);
      const response = await fetch("/api/clash/airport", { method: "PATCH", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存机场信息失败");
      if (data.source) replaceSource(data.source);
      setEditingId(null); setEditingFile(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "保存机场信息失败");
    } finally { setBusy(false); }
  }

  return <section className="airportListPanel">
    <div className="airportListHead"><div><h3>机场列表</h3><p>这里管理所有机场订阅来源；更新会重新读取该机场，删除会同步移除关联。</p></div><button type="button" className="primary" onClick={() => setFormOpen((value) => !value)}>＋ 添加机场</button></div>
    {formOpen && <form className="airportListForm" onSubmit={addSource}><label>机场备注名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：花云400G" /></label><label>订阅地址<input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://机场订阅地址" /></label><label className="filePicker">或者上传 YAML 文件<input type="file" accept=".yaml,.yml,.conf,text/plain,application/yaml" onChange={(event) => setSourceFile(event.target.files?.[0] || null)} /></label>{sourceFile && <div className="selectedFiles">已选择：{sourceFile.name}</div>}<div className="profileEditorActions"><button className="primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存到机场列表"}</button><button type="button" className="ghost" onClick={() => setFormOpen(false)}>取消</button></div></form>}
    <details className="airportTestSettings"><summary>本机测速设置（ClashX Meta）</summary><div className="airportTestSettingsBody"><label>external-controller 地址<input value={controllerUrl} onChange={(event) => setControllerUrl(event.target.value)} placeholder="http://127.0.0.1:9090" /></label><label>Secret（没有可留空）<input type="password" value={controllerSecret} onChange={(event) => setControllerSecret(event.target.value)} placeholder="ClashX Meta 的 secret" autoComplete="off" /></label><button type="button" className="ghost" onClick={() => { const value = controllerUrl.trim().replace(/\/+$/, ""); setControllerUrl(value); window.localStorage.setItem("mw_clash_controller_url", value); setTestNote("测速设置已保存到当前浏览器"); }}>保存测速设置</button><p>测速请求从当前浏览器发往本机 ClashX Meta；需要开启 external-controller，并允许当前网页跨域访问。</p></div></details>
    {testNote && <p className="airportTestNote">{testNote}</p>}
    <div className="airportListRows">{sources.length ? sources.map((source) => {
      const expanded = expandedSourceId === source.id;
      const nodes = nodesBySource[source.id] || [];
      return <div className={`airportListRow ${source.hidden ? "sourceHidden" : ""}`} key={source.id}>
        <div className="airportListMeta"><strong>{source.name}</strong><div className="airportNodeCount">已获取节点 <strong>{source.nodeCount == null ? "—" : source.nodeCount}</strong> 个</div><small>{source.hidden ? "已隐藏 · " : ""}{source.kind === "url" ? source.sourceUrl : "本地 YAML 文件"}</small>{editingId === source.id && <form className="airportEditRow" onSubmit={(event) => void saveEdit(event, source)}>{source.kind === "url" ? <input value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} placeholder="新的订阅地址" aria-label="编辑订阅地址" /> : <label className="filePicker">替换 YAML 文件<input type="file" accept=".yaml,.yml,.conf,text/plain,application/yaml" onChange={(event) => setEditingFile(event.target.files?.[0] || null)} /></label>}<input value={editingName} onChange={(event) => setEditingName(event.target.value)} placeholder="机场备注名称" aria-label="编辑机场备注名称" /><button className="primary" type="submit" disabled={busy}>保存</button><button type="button" className="ghost" disabled={busy} onClick={() => setEditingId(null)}>取消</button></form>}</div>
        <div className="airportListActions"><button type="button" className="ghost" disabled={busy} onClick={() => void toggleHidden(source)}>{source.hidden ? "取消隐藏" : "隐藏"}</button><button type="button" className="ghost" disabled={busy} onClick={() => { setEditingId(source.id); setEditingName(source.name); setEditingUrl(source.sourceUrl); setEditingFile(null); }}>编辑</button><button type="button" className="ghost" disabled={busy} onClick={() => void updateSource(source)}>更新</button><button type="button" className="danger" disabled={busy} onClick={() => void deleteSource(source)}>删除</button></div>
        <div className="airportNodeSection">
          <div className="airportNodeToolbar"><button type="button" className="airportNodeToggle" aria-expanded={expanded} onClick={() => void openNodes(source)}>{expanded ? "收起全部节点" : `查看全部节点${source.nodeCount == null ? "" : `（${source.nodeCount}）`}`}<span>{expanded ? "⌃" : "⌄"}</span></button><button type="button" className="airportNodeTest" disabled={testingSourceId === source.id || nodesLoading[source.id] || busy} onClick={() => void testNodes(source)}>{testingSourceId === source.id ? "测速中…" : "测速"}</button></div>
          {expanded && <div className="airportNodePanel"><p className="airportNodeHint">测速后绿色显示“有效 · 延迟”，红色显示“失效”，黄色表示当前 ClashX Meta 没有加载这个节点；未测速时的绿色只代表配置字段完整。</p>{nodesLoading[source.id] ? <p className="clashLoading">正在读取节点…</p> : nodesError[source.id] ? <p className="airportNodeError">{nodesError[source.id]}</p> : nodes.length ? <div className="airportNodeList">{nodes.map((node) => <div className={`airportNodeRow ${node.status === "valid" ? "nodeValid" : node.status === "unloaded" ? "nodeUnloaded" : "nodeInvalid"}`} key={node.id}><div><strong>{node.name}</strong><small>{node.type} · {node.server}{node.port ? `:${node.port}` : ""}{node.status !== "valid" ? ` · ${node.reason}` : ""}</small></div><span className="nodeStatus">{node.status === "valid" ? `有效${node.latency ? ` · ${node.latency} ms` : ""}` : node.status === "unloaded" ? "未加载" : "失效"}</span></div>)}</div> : <p className="clashLoading">没有读取到节点，请先更新这个机场来源。</p>}</div>}
        </div>
      </div>;
    }) : <p className="clashLoading">机场列表还没有来源，请先添加机场订阅或上传 YAML 文件。</p>}</div>
  </section>;
}

function GroupCard({ group, ruleCount, tone, onEdit, onRules }: { group: Group; ruleCount: number; tone: string; onEdit: () => void; onRules: () => void }) {
  return <article className="groupCard"><div className={`groupIcon ${tone}`}>{group.name.slice(0, 1)}</div><div className="groupBody"><div className="labelRow"><h3>{group.name}</h3><span>{group.items.some((item) => item.startsWith("policy-regex")) ? "节点筛选" : "服务分流"}</span></div><p>{group.items.join(" · ")}</p><button className="ruleLink" onClick={onRules}>{ruleCount} 条关联规则 →</button></div><button className="more" onClick={onEdit} aria-label={`编辑 ${group.name} 节点筛选`}>•••</button></article>;
}

function EditorModalLegacy({ editor, setEditor, policies, countryGroups, error, onSubmit, onImportCatalog }: { editor: Editor; setEditor: (value: Editor | null) => void; policies: string[]; countryGroups: string[]; error: string; onSubmit: (event: FormEvent) => void; onImportCatalog: (items: CatalogResult[], policy: string) => void }) {
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogResult[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  const groupConfig = editor.mode === "group" ? editor.items.split(/\n|,/).map((item) => item.trim()).filter(Boolean) : [];
  const groupKind = groupConfig[0] || "select";
  const selectedCountryGroups = new Set(groupConfig.slice(1).filter((item) => countryGroups.includes(item)));
  const keywordConfig = groupConfig.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length) || "";
  const includeAllProxies = groupConfig.includes("include-all-proxies=true");

  function updateGroupConfig(changes: { kind?: string; country?: string; keyword?: string; includeAll?: boolean }) {
    if (editor.mode !== "group") return;
    const kind = changes.kind || groupKind;
    const countries = new Set(selectedCountryGroups);
    if (changes.country) {
      if (countries.has(changes.country)) countries.delete(changes.country);
      else countries.add(changes.country);
    }
    let extras = groupConfig.slice(1).filter((item) => !countryGroups.includes(item) && !item.startsWith("policy-regex-filter=") && item !== "include-all-proxies=true");
    if (changes.kind && ["url-test", "fallback", "load-balance"].includes(kind) && !extras.some((item) => /^url=/i.test(item))) {
      extras = [...DEFAULT_GROUP_HEALTH_OPTIONS, ...(kind === "load-balance" ? ["strategy=consistent-hashing"] : [])];
    }
    if (changes.kind === "select") extras = extras.filter((item) => !GROUP_HEALTH_OPTION_KEYS.test(item));
    const includeItems = changes.includeAll === undefined ? (includeAllProxies ? ["include-all-proxies=true"] : []) : changes.includeAll ? ["include-all-proxies=true"] : [];
    const keywordItems = changes.keyword === undefined ? (keywordConfig ? [`policy-regex-filter=${keywordConfig}`] : []) : (changes.keyword.trim() ? [`policy-regex-filter=${changes.keyword.trim()}`] : []);
    const nextItems = [kind, ...includeItems, ...Array.from(countries), ...keywordItems, ...extras];
    setEditor({ ...editor, items: nextItems.join("\n") });
  }

  async function searchCatalog() {
    if (!catalogQuery.trim()) return;
    setCatalogLoading(true); setCatalogError("");
    try {
      const response = await fetch(`/api/rule-catalog?q=${encodeURIComponent(catalogQuery.trim())}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "规则集搜索失败");
      setCatalog(data.results || []);
      if (!data.results?.length) setCatalogError("没有找到相关规则集，可以换一个英文或中文关键词。 ");
    } catch (cause) { setCatalogError(cause instanceof Error ? cause.message : "规则集搜索失败"); }
    finally { setCatalogLoading(false); }
  }

  return <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭编辑窗口" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }} onKeyDown={(event) => { if (event.key === "Escape") setEditor(null); }}><form className="editorModal" aria-label="规则编辑器" onSubmit={onSubmit}><header><div><h2>{editor.index === null ? "新增" : "编辑"}{editor.mode === "group" ? "代理分组" : "规则"}</h2><p>保存前会自动检查语法、引用与冲突。</p></div><button type="button" onClick={() => setEditor(null)}>×</button></header>{error && <div className="editorError" role="alert"><span>!</span><pre>{error}</pre></div>}{editor.mode === "group" ? <>
<section className="commonGroupConfig"><div className="groupSectionHeading"><strong>常规分组</strong><small>选择一种常见策略，新增分组默认使用“自动选择”。</small></div><div className="groupKindOptions">{GROUP_KIND_OPTIONS.map((option) => <div key={option.value} className={`groupKindOption ${groupKind === option.value ? "selected" : ""}`} role="radio" tabIndex={0} aria-checked={groupKind === option.value} onClick={() => updateGroupConfig({ kind: option.value })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); updateGroupConfig({ kind: option.value }); } }}><input type="radio" name="group-kind" value={option.value} checked={groupKind === option.value} onChange={() => updateGroupConfig({ kind: option.value })} aria-label={option.label} /><span><strong>{option.label}</strong><small>{option.hint}</small></span></div>)}</div><p className="groupConfigHint">自动选择和故障转移会使用测速地址；默认测速地址和参数可在最下方高级配置中调整。</p></section>
<section className="customGroupConfig"><label>分组名称<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="例如：YouTube" /></label><section className="friendlyGroupConfig"><strong>选择允许使用的国家节点</strong><p>勾选后，这些国家的节点会出现在当前分组中。默认全部不选。</p><div className="countryChecks">{countryGroups.map((country) => <label key={country}><input type="checkbox" checked={selectedCountryGroups.has(country)} onChange={() => updateGroupConfig({ country })} />{country}</label>)}</div><label className="friendlyOption"><input type="checkbox" checked={includeAllProxies} onChange={(event) => updateGroupConfig({ includeAll: event.target.checked })} />包含机场中的全部节点，再按关键词筛选</label><label>节点关键词 <small>用英文竖线 | 分隔，例如：YouTube|Google|美国</small><input value={keywordConfig} onChange={(event) => updateGroupConfig({ keyword: event.target.value })} placeholder="例如：YouTube|youtube|YT" /></label></section></section>
<details className="advancedGroupConfig"><summary>高级配置（一般不需要修改）</summary><label>配置项 <small>每行一个，第一行是类型</small><textarea rows={8} value={editor.items} onChange={(event) => setEditor({ ...editor, items: event.target.value })} /></label></details></>: <><div className="fieldGrid"><label>规则类型<select value={editor.type} onChange={(event) => setEditor({ ...editor, type: event.target.value })}>{RULE_TYPES.map((type) => <option key={type} value={type}>{type} — {RULE_TYPE_META[type].label}</option>)}</select><small className="fieldHint">{RULE_TYPE_META[editor.type]?.hint}</small></label><label>执行策略<select value={editor.policy} onChange={(event) => setEditor({ ...editor, policy: event.target.value })}>{policies.map((policy) => <option key={policy}>{policy}</option>)}</select><small className="fieldHint">决定匹配后走哪个分组、直连或拒绝。</small></label></div>{editor.type === "RULE-SET" && <section className="catalogBox"><strong>从公开规则库搜索</strong><p>数据来自专门适配 Shadowrocket 的 blackmatrix7 公开规则库。</p><div className="catalogSearch"><input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="输入 Google、Netflix、OpenAI、哔哩哔哩…" /><button type="button" className="ghost" onClick={searchCatalog}>{catalogLoading ? "搜索中…" : "搜索"}</button></div>{catalogError && <small className="catalogError">{catalogError}</small>}{catalog.length > 0 && <><button type="button" className="catalogImport" onClick={() => onImportCatalog(catalog, editor.policy)}>一键导入全部 {catalog.length} 个规则集到「{editor.policy}」</button><div className="catalogResults">{catalog.map((item) => <button type="button" key={item.url} className={editor.value === item.url ? "selected" : ""} onClick={() => setEditor({ ...editor, value: item.url })}><span><strong>{item.name}</strong><small>{item.file} · {catalogFileHint(item.file)}</small></span><em>{editor.value === item.url ? "已选择" : "选择"}</em></button>)}</div></>}</section>}{editor.type === "RULE-SET" && <label>{"规则集地址"}<input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder={"可搜索选择，也可以粘贴公开规则集地址"} /></label>}{editor.type === "DOMAIN-SUFFIX" && <label>域名后缀 <small>一行一个，按回车继续添加；保存后会生成多条规则</small><textarea rows={7} value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder={"例如：\nexample.com\nexample.org\nexample.net"} /></label>}{editor.type === "GEOSITE" && <label>geosite 名称 <small>例如 google、paypal，也可以填写 geosite:google</small><input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder="例如：google" /></label>}{editor.type !== "RULE-SET" && editor.type !== "DOMAIN-SUFFIX" && editor.type !== "GEOSITE" && <label>域名或地址<input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder="例如：example.com" /></label>}<label>附加选项 <small>不确定时请留空</small><input value={editor.options} onChange={(event) => setEditor({ ...editor, options: event.target.value })} placeholder="例如：no-resolve（通常可以留空）" /></label></>}<footer><button type="button" className="ghost" onClick={() => setEditor(null)}>取消</button><button className="primary" type="submit">暂存修改</button></footer></form></div>;
}

type EditorModalProps = { editor: Editor; setEditor: (value: Editor | null) => void; policies: string[]; countryGroups: string[]; error: string; onSubmit: (event: FormEvent) => void; onImportCatalog: (items: CatalogResult[], policy: string) => void };
type NewGroupEditor = Extract<Editor, { mode: "group" }>;

function GroupNodeFilter({ raw, countryGroups, onChange }: { raw: string; countryGroups: string[]; onChange: (changes: { country?: string; keyword?: string; includeAll?: boolean }) => void }) {
  const config = readGroupFilter(raw, countryGroups);
  return <section className="friendlyGroupConfig"><strong>节点范围</strong><p>可以包含机场全部节点，也可以按国家和关键词筛选；不勾选则使用分组内的手动配置。</p><div className="countryChecks">{countryGroups.map((country) => <label key={country}><input type="checkbox" checked={config.selectedCountries.has(country)} onChange={() => onChange({ country })} />{country}</label>)}</div><label className="friendlyOption"><input type="checkbox" checked={config.includeAll} onChange={(event) => onChange({ includeAll: event.target.checked })} />包含机场中的全部节点</label><label>节点关键词 <small>用英文竖线 | 分隔，例如：YouTube|Google|美国</small><input value={config.keyword} onChange={(event) => onChange({ keyword: event.target.value })} placeholder="例如：YouTube|youtube|YT" /></label></section>;
}

function NewGroupEditor({ editor, setEditor, countryGroups, error, onSubmit }: { editor: NewGroupEditor; setEditor: (value: Editor | null) => void; countryGroups: string[]; error: string; onSubmit: (event: FormEvent) => void }) {
  const regularKinds = editor.regularKinds || [];
  const regularItems = editor.regularItems || {};
  const customEnabled = Boolean(editor.customEnabled);
  const customItems = editor.customItems || defaultGroupItems("select");

  function toggleRegular(kind: string) {
    const nextKinds = regularKinds.includes(kind) ? regularKinds.filter((item) => item !== kind) : [...regularKinds, kind];
    const nextItems = { ...regularItems };
    if (!nextItems[kind]) nextItems[kind] = defaultGroupItems(kind);
    setEditor({ ...editor, regularKinds: nextKinds, regularItems: nextItems });
  }

  function updateRegular(kind: string, changes: { country?: string; keyword?: string; includeAll?: boolean }) {
    const raw = regularItems[kind] || defaultGroupItems(kind);
    setEditor({ ...editor, regularItems: { ...regularItems, [kind]: updateGroupItems(raw, countryGroups, changes) } });
  }

  function updateCustom(changes: { country?: string; keyword?: string; includeAll?: boolean }) {
    setEditor({ ...editor, customItems: updateGroupItems(customItems, countryGroups, changes) });
  }

  return <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭编辑窗口" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }} onKeyDown={(event) => { if (event.key === "Escape") setEditor(null); }}><form className="editorModal" aria-label="新增代理分组" onSubmit={onSubmit}><header><div><h2>新增代理分组</h2><p>常规分组和自定义分组分别保存，互不影响。</p></div><button type="button" onClick={() => setEditor(null)}>×</button></header>{error && <div className="editorError" role="alert"><span>!</span><pre>{error}</pre></div>}
    <section className="commonGroupConfig"><div className="groupSectionHeading"><strong>常规分组</strong><small>可多选，也可以一个都不选。名称使用预设名称，重复的常规分组不能再次添加。</small></div><div className="groupKindOptions">{GROUP_KIND_OPTIONS.map((option) => <div key={option.value} className={`groupKindOption ${regularKinds.includes(option.value) ? "selected" : ""}`} role="checkbox" tabIndex={0} aria-checked={regularKinds.includes(option.value)} onClick={() => toggleRegular(option.value)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleRegular(option.value); } }}><input type="checkbox" checked={regularKinds.includes(option.value)} onChange={() => toggleRegular(option.value)} onClick={(event) => event.stopPropagation()} aria-label={option.label} /><span><strong>{option.label}</strong><small>{option.hint}</small></span></div>)}</div>{regularKinds.length ? <div className="regularGroupDetails">{regularKinds.map((kind) => <section className="regularGroupCard" key={kind}><div className="regularGroupCardHead"><strong>{groupOptionLabel(kind)}</strong><small>预设名称 · 独立节点范围</small></div><GroupNodeFilter raw={regularItems[kind] || defaultGroupItems(kind)} countryGroups={countryGroups} onChange={(changes) => updateRegular(kind, changes)} /></section>)}</div> : <p className="groupConfigHint">当前未选择常规分组。</p>}</section>
    <section className="customGroupConfig"><div className="groupSectionHeading"><strong>自定义分组</strong><small>与上面的常规分组独立；可以无限新增，但名称仍需唯一，避免规则无法判断。</small></div><label className="friendlyOption customEnableOption"><input type="checkbox" checked={customEnabled} onChange={(event) => setEditor({ ...editor, customEnabled: event.target.checked })} />启用自定义分组</label>{customEnabled && <><label>分组名称<input value={editor.customName || ""} onChange={(event) => setEditor({ ...editor, customName: event.target.value })} placeholder="例如：YouTube" /></label><GroupNodeFilter raw={customItems} countryGroups={countryGroups} onChange={updateCustom} /></>}</section>
    <details className="advancedGroupConfig"><summary>高级配置（一般不需要修改）</summary>{customEnabled ? <label>自定义分组配置项 <small>每行一个，第一行是类型；修改后会覆盖上面的节点范围设置。</small><textarea rows={8} value={customItems} onChange={(event) => setEditor({ ...editor, customItems: event.target.value })} /></label> : <p className="groupConfigHint">启用自定义分组后，这里可以直接编辑它的底层配置。</p>}</details>
    <footer><button type="button" className="ghost" onClick={() => setEditor(null)}>取消</button><button className="primary" type="submit">暂存修改</button></footer></form></div>;
}

function EditorModal(props: EditorModalProps) {
  const isNewGroup = props.editor.mode === "group" && props.editor.index === null && props.editor.isNew;
  return isNewGroup ? <NewGroupEditor editor={props.editor} setEditor={props.setEditor} countryGroups={props.countryGroups} error={props.error} onSubmit={props.onSubmit} /> : <EditorModalLegacy {...props} />;
}
