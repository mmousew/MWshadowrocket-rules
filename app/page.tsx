"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from "react";
import QRCode from "qrcode";

type View = "overview" | "groups" | "rules" | "sets" | "clash" | "airports" | "conflicts";
type Group = { index: number; name: string; kind: string; items: string[] };
type Rule = { index: number; type: string; value: string; policy: string; options: string[] };
type CatalogResult = { name: string; file: string; url: string; source: string };
type Editor =
  | { mode: "group"; index: number | null; name: string; items: string }
  | { mode: "rule"; index: number | null; type: string; value: string; policy: string; options: string };
type DeleteTarget = { kind: "group"; group: Group } | { kind: "rule"; rule: Rule };
type AirportSourceRecord = { id: string; name: string; kind: "url" | "content"; sourceUrl: string; hidden: boolean; nodeCount: number | null; createdAt: number; updatedAt: number };

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
const BUILTINS = ["DIRECT", "PROXY", "REJECT"];
const COUNTRY_GROUP_NAMES = new Set(["日本", "加拿大", "英国", "香港", "韩国", "德国", "法国", "新加坡", "美国"]);
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
const nav: { id: View; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "groups", label: "分组" },
  { id: "rules", label: "域名" },
  { id: "sets", label: "规则" },
  { id: "clash", label: "私有订阅" },
  { id: "airports", label: "机场列表" },
  { id: "conflicts", label: "检查" },
];

function parseConfig(content: string) {
  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  const groups: Group[] = [];
  const rules: Rule[] = [];
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
      if (parts.length >= 3) rules.push({ index, type: parts[0], value: parts[1], policy: parts[2], options: parts.slice(3) });
    }
  });
  return { lines, groups, rules, groupStart, ruleStart };
}

function getConflicts(groups: Group[], rules: Rule[]) {
  const groupNames = new Set(groups.map((group) => group.name));
  const conflicts: string[] = [];
  rules.forEach((rule) => {
    const key = `${rule.type},${rule.value}`;
    if (![...BUILTINS, "REJECT-DROP", "REJECT-NO-DROP"].includes(rule.policy) && !groupNames.has(rule.policy)) {
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
    return saved && nav.some((item) => item.id === saved) ? saved : "overview";
  });
  const [content, setContent] = useState("");
  const [sha, setSha] = useState("");
  const [repository, setRepository] = useState("mmousew/MWshadowrocket-rules");
  const [branch, setBranch] = useState("rules/initial-region-module");
  const [sourceUrl, setSourceUrl] = useState("https://github.com/mmousew/MWshadowrocket-rules");
  const [saveEnabled, setSaveEnabled] = useState(false);
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
    fetch("/api/config", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (response.status === 401) { setAuthRequired(true); setLoading(false); return; }
        if (!response.ok) throw new Error(data.error || "读取配置失败");
        setContent(data.content); setSha(data.sha); setRepository(data.repository); setBranch(data.branch);
        setSourceUrl(data.sourceUrl); setSaveEnabled(data.saveEnabled); setLoading(false);
      })
      .catch((cause) => { setError(cause.message); setLoading(false); });
  }, []);

  const parsed = useMemo(() => parseConfig(content), [content]);
  const conflicts = useMemo(() => getConflicts(parsed.groups, parsed.rules), [parsed.groups, parsed.rules]);
  const duplicateRuleCount = useMemo(() => getDuplicateRuleCount(parsed.rules), [parsed.rules]);
  const ruleSets = useMemo(() => parsed.rules.filter((rule) => rule.type === "RULE-SET"), [parsed.rules]);
  const domainRules = useMemo(() => parsed.rules.filter((rule) => rule.type !== "RULE-SET" && rule.type !== "FINAL"), [parsed.rules]);
  const policies = useMemo(() => [...parsed.groups.map((group) => group.name), ...BUILTINS], [parsed.groups]);
  const filteredGroups = parsed.groups.filter((group) => `${group.name} ${group.items.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const viewingGroup = view === "rules" && parsed.groups.some((group) => group.name === query) ? query : "";
  const activeRules = viewingGroup ? parsed.rules.filter((rule) => rule.policy === viewingGroup) : view === "sets" ? ruleSets : domainRules;
  const filteredRules = activeRules.filter((rule) => viewingGroup || `${rule.type} ${rule.value} ${rule.policy}`.toLowerCase().includes(query.toLowerCase()));
  const filteredRuleKey = filteredRules.map((rule) => rule.index).join(",");
  const effectiveSelectedRuleIndexes = selectionKey === filteredRuleKey ? selectedRuleIndexes : filteredRules.map((rule) => rule.index);

  function markContent(next: string) { setContent(next); setDirty(true); setToast("修改已暂存，保存后同步到 GitHub"); }

  function openNew() {
    if (view === "groups") setEditor({ mode: "group", index: null, name: "", items: "select\nDIRECT" });
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
            if (parts[2]?.trim() === oldName) parts[2] = name;
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
    const used = parsed.rules.some((rule) => rule.policy === group.name) || parsed.groups.some((item) => item.index !== group.index && item.items.includes(group.name));
    if (used) return setError(`「${group.name}」仍被其他规则或分组引用，不能直接删除`);
    setDeleteTarget({ kind: "group", group });
  }

  function removeRule(rule: Rule) {
    setDeleteTarget({ kind: "rule", rule });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const index = deleteTarget.kind === "group" ? deleteTarget.group.index : deleteTarget.rule.index;
    const lines = content.split(/\r?\n/);
    lines.splice(index, 1);
    markContent(lines.join("\n"));
    setDeleteTarget(null);
  }

  async function save() {
    if (conflicts.length) return setView("conflicts");
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, sha, message: "Update rules from MW Rules manager" }) });
      const data = await response.json();
      if (!response.ok) throw new Error([data.error, ...(data.details || [])].join("\n"));
      setSha(data.sha || sha); setDirty(false); setToast("已保存到 GitHub，小火箭可以更新配置了");
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
          <div className="titleBlock"><div><p className="eyebrow">SHADOWROCKET CONFIGURATION</p><h1>{nav.find((item) => item.id === view)?.label}{view === "rules" && parsed.groups.some((group) => group.name === query) ? ` · ${query}` : ""}</h1></div></div>
          <div className="topActions"><button className="ghost" onClick={() => setPreview(true)}>预览配置</button>{(["groups", "rules", "sets"] as View[]).includes(view) && <button className="primary" onClick={openNew}>＋ 新增</button>}<button className={`saveButton ${dirty ? "ready" : ""}`} disabled={!dirty || saving} onClick={save}>{saving ? "保存中…" : "保存到 GitHub"}</button></div>
        </header>

        {error && <div className="errorBanner"><span>!</span><pre>{error}</pre><button onClick={() => setError("")}>×</button></div>}
        {toast && <div className="toast" onAnimationEnd={() => setToast("")}>{toast}</div>}

        {view === "overview" && <>
          <div className={`notice ${conflicts.length ? "warning" : ""}`}><span>{conflicts.length ? "!" : "✓"}</span><div><strong>{conflicts.length ? `发现 ${conflicts.length} 个问题` : "配置状态正常"}</strong><p>{conflicts.length ? "有规则引用了不存在的策略，请先处理。" : duplicateRuleCount ? `机场原始规则有 ${duplicateRuleCount} 处重叠，按文件顺序执行，不影响保存。` : saveEnabled ? "已连接 GitHub，可直接编辑并保存。" : "已连接只读数据，配置写入凭据后即可在线保存。"}</p></div><button onClick={() => setView("conflicts")}>查看检查结果</button></div>
          <section className="metrics"><article><span>国家与节点组</span><strong>{parsed.groups.filter((group) => group.items.some((item) => item.startsWith("policy-regex-filter"))).length}</strong><small>动态匹配机场节点</small></article><article><span>全部分组</span><strong>{parsed.groups.length}</strong><small>国家、服务与策略</small></article><article><span>有效规则</span><strong>{parsed.rules.length.toLocaleString()}</strong><small>按优先级顺序执行</small></article><article><span>规则冲突</span><strong className={conflicts.length ? "bad" : "ok"}>{conflicts.length}</strong><small>{duplicateRuleCount ? `另有 ${duplicateRuleCount} 处重叠提示` : "保存前自动检查"}</small></article></section>
          <section className="panel"><div className="panelHead"><div><h2>常用分组</h2><p>节点筛选和分流规则分别管理，但会在这里汇总显示。</p></div><button className="textButton" onClick={() => setView("groups")}>查看全部 →</button></div><div className="groupGrid">{parsed.groups.filter((group) => ["德国", "Google", "PayPal"].includes(group.name)).map((group, i) => <GroupCard key={group.name} group={group} ruleCount={parsed.rules.filter((rule) => rule.policy === group.name).length} tone={["mint", "blue", "amber"][i]} onEdit={() => editGroup(group)} onRules={() => showGroupRules(group)} />)}</div></section>
          <section className="panel compact"><div className="panelHead"><div><h2>工作方式</h2><p>每次保存先检查冲突，再生成一条可追溯的 GitHub 提交。</p></div></div><div className="activity"><span className="activityIcon">↻</span><div><strong>在线配置与小火箭保持同一来源</strong><p>保存后在设备上更新配置即可生效</p></div><a href={sourceUrl} target="_blank" rel="noreferrer">打开仓库</a></div></section>
        </>}

        {(view === "groups" || view === "rules" || view === "sets") && <>
          <div className="toolbar"><label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "groups" ? "搜索分组或节点关键词" : "搜索域名、规则集或策略"} /></label>{view !== "groups" && query.trim() && filteredRules.length > 0 && <div className="bulkTransfer"><label className="selectAll"><input type="checkbox" checked={effectiveSelectedRuleIndexes.length === filteredRules.length} onChange={(event) => { setSelectionKey(filteredRuleKey); setSelectedRuleIndexes(event.target.checked ? filteredRules.map((rule) => rule.index) : []); }} />全选</label><span>转移到</span><select value={bulkTargetPolicy || policies[0] || ""} onChange={(event) => setBulkTargetPolicy(event.target.value)} aria-label="批量转移目标分组">{policies.map((policy) => <option key={policy}>{policy}</option>)}</select><button type="button" onClick={() => transferFilteredRules(bulkTargetPolicy || policies[0] || "")}>转移选中 {effectiveSelectedRuleIndexes.length} 条</button></div>}<span>{view === "groups" ? filteredGroups.length : filteredRules.length} 项</span></div>
          {view === "groups" ? <><p className={`dragHelp ${query ? "disabled" : ""}`}>{query ? "清空搜索后可以拖拽调整完整分组顺序" : "按住左侧或整行拖动排序；也可以用上移/下移"}</p><div className="listPanel">{filteredGroups.map((group) => { const linked = parsed.rules.filter((rule) => rule.policy === group.name); return <div
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
          ><span aria-hidden="true">⠿</span></button><div className="rowMain"><strong>{group.name}</strong><p>{linked.length ? `${linked.length} 条分流规则 · ${linked.slice(0, 4).map((rule) => rule.value).join(" · ")}` : `${group.kind} · ${group.items.join(" · ")}`}</p></div><div className="reorderButtons" aria-label={`调整「${group.name}」顺序`}><button type="button" className="reorderButton" onClick={() => moveGroupByOffset(group, -1)} disabled={Boolean(query) || parsed.groups[0]?.name === group.name} aria-label={`上移「${group.name}」`} title="上移">↑</button><button type="button" className="reorderButton" onClick={() => moveGroupByOffset(group, 1)} disabled={Boolean(query) || parsed.groups.at(-1)?.name === group.name} aria-label={`下移「${group.name}」`} title="下移">↓</button></div><span className="pill">{linked.length} 条规则</span><button onClick={() => showGroupRules(group)}>查看规则</button><button onClick={() => editGroup(group)}>节点筛选</button><button className="danger" onClick={() => removeGroup(group)}>删除</button></div>; })}</div></>
          : <div className="listPanel">{filteredRules.map((rule) => <div className="listRow" key={`${rule.index}-${rule.value}`}><input className="ruleSelect" type="checkbox" checked={effectiveSelectedRuleIndexes.includes(rule.index)} onChange={() => toggleRuleSelection(rule.index)} aria-label={`选择规则 ${rule.value}`} /><span className={`ruleType ${rule.type === "RULE-SET" ? "set" : ""}`}>{rule.type}<small>{RULE_TYPE_META[rule.type]?.label}</small></span><div className="rowMain"><strong>{rule.value}</strong><p>策略：{rule.policy}{rule.options.length ? ` · ${rule.options.join(", ")}` : ""}</p></div><span className="policy">{rule.policy}</span><button onClick={() => editRule(rule)}>编辑</button><button className="danger" onClick={() => removeRule(rule)}>删除</button></div>)}</div>}
        </>}

        {view === "clash" && <ClashSubscription />}
        {view === "airports" && <ClashSubscription mode="airports" />}

        {view === "conflicts" && <section className="panel audit"><div className={`auditMark ${conflicts.length ? "warn" : ""}`}>{conflicts.length ? "!" : "✓"}</div><h2>{conflicts.length ? "需要处理后才能保存" : "配置检查通过"}</h2><p>{conflicts.length ? "以下规则需要确认策略名称。" : duplicateRuleCount ? `机场规则中有 ${duplicateRuleCount} 处重复匹配，这是机场原始配置的正常重叠，按规则顺序执行，不阻止保存。` : "代理分组引用与规则顺序均通过检查。"}</p>{conflicts.length > 0 && <ul>{conflicts.map((item) => <li key={item}>{item}</li>)}</ul>}<button className="ghost" onClick={() => setPreview(true)}>查看原始配置</button></section>}
      </section>

      {editor && <EditorModal editor={editor} setEditor={setEditor} policies={policies} countryGroups={parsed.groups.filter((group) => COUNTRY_GROUP_NAMES.has(group.name)).map((group) => group.name)} onSubmit={submitEditor} onImportCatalog={importCatalogRules} />}
      {deleteTarget && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭删除确认" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }} onKeyDown={(event) => { if (event.key === "Escape") setDeleteTarget(null); }}><section className="confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="confirmMark">!</span><h2 id="delete-title">确认删除？</h2><p>{deleteTarget.kind === "group" ? `将删除代理分组「${deleteTarget.group.name}」。` : `将删除规则「${deleteTarget.rule.value}」。`}</p><small>删除会先暂存，点击“保存到 GitHub”后才会正式生效。</small><footer><button className="ghost" onClick={() => setDeleteTarget(null)}>取消</button><button className="deleteConfirm" onClick={confirmDelete}>确认删除</button></footer></section></div>}
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

function ClashSubscription({ mode = "private" }: { mode?: "private" | "airports" }) {
  type SourceRecord = { index: number; sourceId: string | null; name: string; kind: "url" | "content"; value: string | null; hidden: boolean; nodes: number | null };
  type ProfileRecord = { id: string; name: string; sourceCount: number; nodeCount: number | null; updatedAt: number; sources?: SourceRecord[] };
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

  useEffect(() => { void loadPage(); }, []);

  async function loadPage() {
    try {
      const [profileResponse, linkResponse] = await Promise.all([
        fetch("/api/clash/profile", { cache: "no-store" }),
        fetch("/api/clash/link", { cache: "no-store" }),
      ]);
      const airportResponse = await fetch("/api/clash/airport", { cache: "no-store" });
      const profileData = await profileResponse.json();
      const linkData = await linkResponse.json();
      const airportData = await airportResponse.json();
      if (!profileResponse.ok) throw new Error(profileData.error || "读取订阅配置失败");
      if (!linkResponse.ok) throw new Error(linkData.error || "读取订阅链接失败");
      if (!airportResponse.ok) throw new Error(airportData.error || "读取机场列表失败");
      setProfiles(profileData.profiles || []);
      setLinks(linkData.links || []);
      setAirportSources(airportData.sources || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取订阅配置失败");
    }
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

  async function renameLink(id: string, name: string) {
    const response = await fetch(`/api/clash/link/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rename", name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存链接备注失败");
    setLinks((current) => current.map((item) => item.id === id ? { ...item, name: name.trim() || "订阅链接" } : item));
  }

  async function copyLink(value: string) {
    await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
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
    try {
      setQrCode(await QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: "M", color: { dark: "#17231e", light: "#ffffff" } }));
      setQrLink(value); setQrLabel(label);
    } catch { setError(`${label}二维码生成失败，请稍后重试`); }
  }

  const profileLinkCard = (link: LinkRecord) => <article className={`clashLinkCard ${link.status === "revoked" ? "revoked" : ""}`} key={link.id}>
    <div className="clashCardActions">{link.status === "active" && <button type="button" className="ghost" onClick={() => setPendingLinkAction({ id: link.id, action: "revoke" })}>失效</button>}<button type="button" className="danger" onClick={() => setPendingLinkAction({ id: link.id, action: "delete" })}>删除</button></div>
    <div className="clashLinkMeta"><input className="clashNameInput" value={link.name} onChange={(event) => setLinks((current) => current.map((item) => item.id === link.id ? { ...item, name: event.target.value } : item))} onBlur={() => void renameLink(link.id, link.name).catch((cause) => setError(cause instanceof Error ? cause.message : "保存链接备注失败"))} aria-label="订阅链接备注" /><span>{link.status === "active" ? "已启用" : "已失效"} · {link.createdAt ? new Date(link.createdAt).toLocaleString("zh-CN") : "历史链接"}</span></div>
    <label className="clientLinkLabel">CLASH 地址<div className="clientLinkRow"><input readOnly value={clashRelayUrl(link.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(clashRelayUrl(link.url))}>复制</button>{link.status === "active" && <button type="button" className="inlineQr" onClick={() => void showQr(clashRelayUrl(link.url), "CLASH")}>二维码</button>}</div></label>
    <label className="clientLinkLabel">小火箭地址<div className="clientLinkRow"><input readOnly value={shadowrocketUrl(link.url)} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="inlineCopy" onClick={() => void copyLink(shadowrocketUrl(link.url))}>复制</button>{link.status === "active" && <button type="button" className="inlineQr" onClick={() => void showQr(shadowrocketUrl(link.url), "小火箭")}>二维码</button>}</div></label>
  </article>;

  const availableAirports = (sources: SourceRecord[]) => airportSources.filter((source) => !source.hidden && !sources.some((entry) => entry.sourceId === source.id || (entry.kind === source.kind && source.kind === "url" && entry.value === source.sourceUrl)));

  return <section className="clashPanel">
    {mode === "private" && <div className="subscriptionHead"><h2>私有订阅</h2><button type="button" className="primary" onClick={() => { setNewProfileOpen((value) => !value); setError(""); }}>＋ 新增订阅配置</button></div>}
    {error && <div className="clashError">{error}</div>}
    {mode === "airports" ? <AirportList sources={airportSources} onSourcesChange={setAirportSources} onError={setError} /> : <>
      {newProfileOpen && <form className="profileCreateForm" onSubmit={addProfile}><label>配置备注名称<input value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder="例如：我的备用机场" /></label><p className="formHint">新增后在编辑来源里从“机场列表”选择要加入的订阅。</p><div className="profileEditorActions"><button className="primary" type="submit" disabled={busy}>{busy ? "处理中…" : "保存并新增配置"}</button><button className="ghost" type="button" onClick={() => setNewProfileOpen(false)}>取消</button></div></form>}
      <section className="profileList">{profiles.length ? profiles.map((profile) => {
        const profileLinks = links.filter((link) => link.profileId === profile.id || (!link.profileId && profile.id === "default"));
        const editing = editorProfileId === profile.id;
        return <article className="profileCard" key={profile.id}>
          <div className="profileCardHead"><div className="profileCardTitle"><input value={profile.name} onChange={(event) => setProfiles((current) => current.map((item) => item.id === profile.id ? { ...item, name: event.target.value } : item))} onBlur={() => { const name = profile.name.trim() || "订阅配置"; void fetch("/api/clash/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: profile.id, name }) }).catch(() => setError("保存配置名称失败")); }} aria-label="订阅配置名称" /><p>{profile.sourceCount} 个来源 · {profile.nodeCount == null ? "节点数待更新" : "约 " + profile.nodeCount + " 个节点"} · {profileLinks.length} 条链接</p></div><div className="profileCardHeadActions"><button type="button" className="ghost" disabled={busy || profile.sourceCount === 0} onClick={() => void createNewLink(profile)}>＋ 生成新链接</button><button type="button" className="ghost" disabled={busy || profile.sourceCount === 0} onClick={() => void refreshProfile(profile)}>更新当前配置</button><button type="button" className={editing ? "ghost" : "primary"} onClick={() => void openEditor(profile)}>{editing ? "收起编辑器" : "编辑来源"}</button></div></div>
          {editing && <section className="profileEditor"><div className="profileEditorHead"><div><h4>编辑「{profile.name}」的来源</h4><p>这里只能选择机场列表中的来源；移除只影响当前配置。</p></div><button type="button" className="ghost" onClick={() => { setEditorProfileId(null); setAirportPickerOpen(false); }}>关闭</button></div>
            <div className="sourceList">{editorSources.length ? editorSources.map((source) => <div className={`sourceRow ${source.hidden ? "sourceHidden" : ""}`} key={`${profile.id}-${source.index}`}><div><strong>{source.name}</strong><small>{source.kind === "content" ? `本地文件 · ${source.nodes ?? 0} 个节点` : source.value || "在线订阅地址"}</small></div><button type="button" className="danger" disabled={busy} onClick={() => void removeSource(source.index)}>从当前配置移除</button></div>) : <p className="clashLoading">当前还没有来源，请从机场列表选择。</p>}</div>
            <div className="sourceAddForm"><button className="primary addSourceButton" type="button" onClick={() => setAirportPickerOpen((value) => !value)} disabled={busy}>{airportPickerOpen ? "收起机场列表" : "＋ 从机场列表添加"}</button>{airportPickerOpen && <div className="airportPicker">{availableAirports(editorSources).map((source) => <div className="airportPickerRow" key={source.id}><div><strong>{source.name}</strong><small>{source.kind === "url" ? source.sourceUrl : "本地 YAML 文件"} · {source.nodeCount == null ? "节点数待更新" : source.nodeCount + " 个节点"}</small></div><button type="button" className="ghost" disabled={busy} onClick={() => void addAirportToProfile(source)}>添加</button></div>)}{availableAirports(editorSources).length === 0 && <p className="clashLoading">机场列表中没有可添加的订阅，请先去机场列表新增。</p>}</div>}</div>
          </section>}
          {profileLinks.length ? profileLinks.map(profileLinkCard) : <p className="clashLoading">还没有链接，请先添加来源后生成新链接。</p>}
        </article>;
      }) : <p className="clashLoading">还没有订阅配置，请先新增一个配置。</p>}</section>
      <ul><li>机场列表是总表，私有订阅这里只管理关联关系。</li><li>移除来源不会删除机场列表中的订阅；机场列表删除才会同步清理所有关联。</li><li>每条链接都支持修改备注、复制、二维码、失效和删除。</li></ul>
    </>}
    {pendingLinkAction && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭订阅操作确认" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingLinkAction(null); }} onKeyDown={(event) => { if (event.key === "Escape") setPendingLinkAction(null); }}><section className="confirmModal" role="alertdialog" aria-modal="true" aria-labelledby="link-action-title"><span className="confirmMark">!</span><h2 id="link-action-title">确认{pendingLinkAction.action === "delete" ? "删除" : "使链接失效"}？</h2><p>{pendingLinkAction.action === "delete" ? "删除后将无法恢复这条订阅链接。" : "失效后这条订阅链接将无法继续获取配置。"}</p><footer><button className="ghost" type="button" onClick={() => setPendingLinkAction(null)}>取消</button><button className="deleteConfirm" type="button" onClick={() => { const action = pendingLinkAction; setPendingLinkAction(null); void changeLink(action.id, action.action).catch((cause) => setError(cause instanceof Error ? cause.message : "操作链接失败")); }}>确认</button></footer></section></div>}
    {qrCode && <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭二维码" onMouseDown={(event) => { if (event.target === event.currentTarget) { setQrCode(""); setQrLink(""); setQrLabel(""); } }} onKeyDown={(event) => { if (event.key === "Escape") { setQrCode(""); setQrLink(""); setQrLabel(""); } }}><section className="qrModal" role="dialog" aria-modal="true" aria-labelledby="qr-title"><header><div><h2 id="qr-title">{qrLabel} 订阅二维码</h2><p>使用对应客户端扫描</p></div><button type="button" onClick={() => { setQrCode(""); setQrLink(""); setQrLabel(""); }}>×</button></header><img src={qrCode} alt={`${qrLabel} 私有订阅二维码`} /><button type="button" className="ghost qrCopy" onClick={() => void copyLink(qrLink)}>{copied ? "已复制订阅链接" : "复制订阅链接"}</button></section></div>}
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

  function replaceSource(source: AirportSourceRecord) {
    onSourcesChange(sources.map((item) => item.id === source.id ? source : item));
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
    <div className="airportListRows">{sources.length ? sources.map((source) => <div className={`airportListRow ${source.hidden ? "sourceHidden" : ""}`} key={source.id}><div className="airportListMeta"><strong>{source.name}</strong><small>{source.hidden ? "已隐藏 · " : ""}{source.kind === "url" ? source.sourceUrl : "本地 YAML 文件"} · {source.nodeCount == null ? "节点数待更新" : source.nodeCount + " 个节点"}</small>{editingId === source.id && <form className="airportEditRow" onSubmit={(event) => void saveEdit(event, source)}>{source.kind === "url" ? <input value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} placeholder="新的订阅地址" aria-label="编辑订阅地址" /> : <label className="filePicker">替换 YAML 文件<input type="file" accept=".yaml,.yml,.conf,text/plain,application/yaml" onChange={(event) => setEditingFile(event.target.files?.[0] || null)} /></label>}<input value={editingName} onChange={(event) => setEditingName(event.target.value)} placeholder="机场备注名称" aria-label="编辑机场备注名称" /><button className="primary" type="submit" disabled={busy}>保存</button><button type="button" className="ghost" disabled={busy} onClick={() => setEditingId(null)}>取消</button></form>}</div><div className="airportListActions"><button type="button" className="ghost" disabled={busy} onClick={() => void toggleHidden(source)}>{source.hidden ? "取消隐藏" : "隐藏"}</button><button type="button" className="ghost" disabled={busy} onClick={() => { setEditingId(source.id); setEditingName(source.name); setEditingUrl(source.sourceUrl); setEditingFile(null); }}>编辑</button><button type="button" className="ghost" disabled={busy} onClick={() => void updateSource(source)}>更新</button><button type="button" className="danger" disabled={busy} onClick={() => void deleteSource(source)}>删除</button></div></div>) : <p className="clashLoading">机场列表还没有来源，请先添加机场订阅或上传 YAML 文件。</p>}</div>
  </section>;
}

function GroupCard({ group, ruleCount, tone, onEdit, onRules }: { group: Group; ruleCount: number; tone: string; onEdit: () => void; onRules: () => void }) {
  return <article className="groupCard"><div className={`groupIcon ${tone}`}>{group.name.slice(0, 1)}</div><div className="groupBody"><div className="labelRow"><h3>{group.name}</h3><span>{group.items.some((item) => item.startsWith("policy-regex")) ? "节点筛选" : "服务分流"}</span></div><p>{group.items.join(" · ")}</p><button className="ruleLink" onClick={onRules}>{ruleCount} 条关联规则 →</button></div><button className="more" onClick={onEdit} aria-label={`编辑 ${group.name} 节点筛选`}>•••</button></article>;
}

function EditorModal({ editor, setEditor, policies, countryGroups, onSubmit, onImportCatalog }: { editor: Editor; setEditor: (value: Editor | null) => void; policies: string[]; countryGroups: string[]; onSubmit: (event: FormEvent) => void; onImportCatalog: (items: CatalogResult[], policy: string) => void }) {
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogResult[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");

  const groupConfig = editor.mode === "group" ? editor.items.split(/\n|,/).map((item) => item.trim()).filter(Boolean) : [];
  const selectedCountryGroups = new Set(groupConfig.slice(1).filter((item) => countryGroups.includes(item)));
  const keywordConfig = groupConfig.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length) || "";
  const includeAllProxies = groupConfig.includes("include-all-proxies=true");

  function updateGroupConfig(changes: { country?: string; keyword?: string; includeAll?: boolean }) {
    if (editor.mode !== "group") return;
    const kind = groupConfig[0] || "select";
    const countries = new Set(selectedCountryGroups);
    if (changes.country) {
      if (countries.has(changes.country)) countries.delete(changes.country);
      else countries.add(changes.country);
    }
    const extras = groupConfig.slice(1).filter((item) => !countryGroups.includes(item) && !item.startsWith("policy-regex-filter=") && item !== "include-all-proxies=true");
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

  return <div className="modalBackdrop" role="button" tabIndex={0} aria-label="关闭编辑窗口" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditor(null); }} onKeyDown={(event) => { if (event.key === "Escape") setEditor(null); }}><form className="editorModal" aria-label="规则编辑器" onSubmit={onSubmit}><header><div><h2>{editor.index === null ? "新增" : "编辑"}{editor.mode === "group" ? "代理分组" : "规则"}</h2><p>保存前会自动检查语法、引用与冲突。</p></div><button type="button" onClick={() => setEditor(null)}>×</button></header>{editor.mode === "group" ? <><label>分组名称<input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="例如：YouTube" /></label><section className="friendlyGroupConfig"><strong>选择允许使用的国家节点</strong><p>勾选后，这些国家的节点会出现在当前分组中。默认全部不选。</p><div className="countryChecks">{countryGroups.map((country) => <label key={country}><input type="checkbox" checked={selectedCountryGroups.has(country)} onChange={() => updateGroupConfig({ country })} />{country}</label>)}</div><label className="friendlyOption"><input type="checkbox" checked={includeAllProxies} onChange={(event) => updateGroupConfig({ includeAll: event.target.checked })} />包含机场中的全部节点，再按关键词筛选</label><label>节点关键词 <small>用英文竖线 | 分隔，例如：YouTube|Google|美国</small><input value={keywordConfig} onChange={(event) => updateGroupConfig({ keyword: event.target.value })} placeholder="例如：YouTube|youtube|YT" /></label></section><details className="advancedGroupConfig"><summary>高级配置（一般不需要修改）</summary><label>配置项 <small>每行一个，第一行是类型</small><textarea rows={6} value={editor.items} onChange={(event) => setEditor({ ...editor, items: event.target.value })} /></label></details></> : <><div className="fieldGrid"><label>规则类型<select value={editor.type} onChange={(event) => setEditor({ ...editor, type: event.target.value })}>{RULE_TYPES.map((type) => <option key={type} value={type}>{type} — {RULE_TYPE_META[type].label}</option>)}</select><small className="fieldHint">{RULE_TYPE_META[editor.type]?.hint}</small></label><label>执行策略<select value={editor.policy} onChange={(event) => setEditor({ ...editor, policy: event.target.value })}>{policies.map((policy) => <option key={policy}>{policy}</option>)}</select><small className="fieldHint">决定匹配后走哪个分组、直连或拒绝。</small></label></div>{editor.type === "RULE-SET" && <section className="catalogBox"><strong>从公开规则库搜索</strong><p>数据来自专门适配 Shadowrocket 的 blackmatrix7 公开规则库。</p><div className="catalogSearch"><input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="输入 Google、Netflix、OpenAI、哔哩哔哩…" /><button type="button" className="ghost" onClick={searchCatalog}>{catalogLoading ? "搜索中…" : "搜索"}</button></div>{catalogError && <small className="catalogError">{catalogError}</small>}{catalog.length > 0 && <><button type="button" className="catalogImport" onClick={() => onImportCatalog(catalog, editor.policy)}>一键导入全部 {catalog.length} 个规则集到「{editor.policy}」</button><div className="catalogResults">{catalog.map((item) => <button type="button" key={item.url} className={editor.value === item.url ? "selected" : ""} onClick={() => setEditor({ ...editor, value: item.url })}><span><strong>{item.name}</strong><small>{item.file} · {catalogFileHint(item.file)}</small></span><em>{editor.value === item.url ? "已选择" : "选择"}</em></button>)}</div></>}</section>}{editor.type === "RULE-SET" && <label>{"规则集地址"}<input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder={"可搜索选择，也可以粘贴公开规则集地址"} /></label>}{editor.type === "DOMAIN-SUFFIX" && <label>域名后缀 <small>一行一个，按回车继续添加；保存后会生成多条规则</small><textarea rows={7} value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder={"例如：\nexample.com\nexample.org\nexample.net"} /></label>}{editor.type === "GEOSITE" && <label>geosite 名称 <small>例如 google、paypal，也可以填写 geosite:google</small><input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder="例如：google" /></label>}{editor.type !== "RULE-SET" && editor.type !== "DOMAIN-SUFFIX" && editor.type !== "GEOSITE" && <label>域名或地址<input value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} placeholder="例如：example.com" /></label>}<label>附加选项 <small>不确定时请留空</small><input value={editor.options} onChange={(event) => setEditor({ ...editor, options: event.target.value })} placeholder="例如：no-resolve（通常可以留空）" /></label></>}<footer><button type="button" className="ghost" onClick={() => setEditor(null)}>取消</button><button className="primary" type="submit">暂存修改</button></footer></form></div>;
}
