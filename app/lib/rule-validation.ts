const BUILTIN_POLICIES = new Set([
  "direct",
  "proxy",
  "proxies",
  "reject",
  "reject-drop",
  "reject-no-drop",
]);

function key(value: string) {
  return value.trim().toLowerCase();
}

function splitLine(line: string) {
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

function sectionEnd(lines: string[], start: number) {
  const next = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*$/.test(line));
  return next >= 0 ? next : lines.length;
}

const PROTECTED_GROUP_LABELS = new Map([
  ["proxies", "Proxies"],
  ["final", "Final"],
]);

/** These groups are part of the client contract and must keep their identity. */
export function isProtectedGroupName(name: string) {
  return PROTECTED_GROUP_LABELS.has(key(name));
}

function readGroupNames(content: string) {
  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim().toLowerCase() === "[proxy group]");
  const ruleStart = lines.findIndex((line) => line.trim().toLowerCase() === "[rule]");
  const names = new Map<string, string>();
  if (groupStart < 0 || ruleStart <= groupStart) return names;
  for (let index = groupStart + 1; index < ruleStart; index += 1) {
    const raw = lines[index].trim();
    const separator = raw.indexOf("=");
    if (separator < 1 || raw.startsWith("#")) continue;
    const name = raw.slice(0, separator).trim();
    if (name) names.set(key(name), name);
  }
  return names;
}

/**
 * Keep the server-side save path aligned with the editor: if a protected
 * group existed before, a submitted configuration may not remove or rename
 * it. This also covers direct API calls that bypass the browser UI.
 */
export function validateProtectedGroupChanges(previousContent: string, nextContent: string) {
  const previousGroups = readGroupNames(previousContent);
  const nextGroups = readGroupNames(nextContent);
  const errors: string[] = [];
  PROTECTED_GROUP_LABELS.forEach((label, protectedKey) => {
    if (previousGroups.has(protectedKey) && !nextGroups.has(protectedKey)) {
      errors.push(`系统保留分组「${label}」不能删除或改名`);
    }
  });
  return errors;
}

/**
 * Validate the rule layer before it is stored or merged into a client file.
 * This intentionally does not require a FINAL line: the output builders add
 * one when a source file does not have it, but they must never emit two.
 */
export function validateRuleConfiguration(content: string) {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim().toLowerCase() === "[proxy group]");
  const ruleStart = lines.findIndex((line) => line.trim().toLowerCase() === "[rule]");
  if (groupStart < 0 || ruleStart < 0 || ruleStart <= groupStart) return ["配置缺少 [Proxy Group] 或 [Rule] 段"];

  const groups = new Map<string, { name: string; items: string[] }>();
  const groupEnd = sectionEnd(lines, groupStart);
  for (let index = groupStart + 1; index < Math.min(ruleStart, groupEnd); index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const separator = raw.indexOf("=");
    if (separator < 1) continue;
    const name = raw.slice(0, separator).trim();
    const items = splitLine(raw.slice(separator + 1)).filter(Boolean);
    const groupKey = key(name);
    if (!name || !items.length) {
      errors.push(`第 ${index + 1} 行分组配置为空或格式不完整`);
      continue;
    }
    if (groups.has(groupKey)) errors.push(`代理分组名称重复（忽略大小写）：${name}`);
    groups.set(groupKey, { name, items: items.slice(1) });

    const includeAll = items.some((item) => key(item) === "include-all-proxies=true");
    const filters = items.filter((item) => /^policy-regex-filter=/i.test(item));
    if (includeAll && filters.length) errors.push(`分组「${name}」同时启用了“全部节点”和“关键词筛选”，两者只能选择一个`);
    filters.forEach((item) => {
      const expression = item.slice(item.indexOf("=") + 1).trim();
      if (!expression) errors.push(`分组「${name}」的关键词筛选不能为空`);
      else {
        try { new RegExp(expression, "i"); } catch { errors.push(`分组「${name}」的关键词筛选不是有效表达式：${expression}`); }
      }
    });
  }

  const groupEdges = new Map<string, string[]>();
  groups.forEach((group, groupKey) => {
    const references = group.items
      .filter((item) => !item.includes("=") && groups.has(key(item)))
      .map((item) => key(item));
    if (references.includes(groupKey)) errors.push(`分组「${group.name}」不能引用自己`);
    groupEdges.set(groupKey, [...new Set(references)]);
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (groupKey: string, path: string[]) => {
    if (visiting.has(groupKey)) {
      const cycleStart = path.indexOf(groupKey);
      const cycle = [...path.slice(cycleStart >= 0 ? cycleStart : 0), groupKey].map((item) => groups.get(item)?.name || item);
      errors.push(`分组之间存在循环引用：${cycle.join(" → ")}`);
      return;
    }
    if (visited.has(groupKey)) return;
    visiting.add(groupKey);
    (groupEdges.get(groupKey) || []).forEach((child) => walk(child, [...path, groupKey]));
    visiting.delete(groupKey);
    visited.add(groupKey);
  };
  groupEdges.forEach((_children, groupKey) => walk(groupKey, []));

  const ruleEnd = sectionEnd(lines, ruleStart);
  let finalCount = 0;
  for (let index = ruleStart + 1; index < ruleEnd; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = splitLine(raw);
    if (parts[0]?.toUpperCase() === "FINAL") {
      finalCount += 1;
      const finalPolicy = parts[1]?.trim() || "";
      if (!finalPolicy) errors.push(`第 ${index + 1} 行 FINAL 没有指定策略`);
      else if (!BUILTIN_POLICIES.has(key(finalPolicy)) && !groups.has(key(finalPolicy))) {
        errors.push(`FINAL 引用了不存在的策略「${finalPolicy}」`);
      }
      continue;
    }
    if (parts.length < 3) continue;
    const policy = parts[2].trim();
    if (policy && !BUILTIN_POLICIES.has(key(policy)) && !groups.has(key(policy))) {
      errors.push(`${parts[0]},${parts[1]} 引用了不存在的策略「${policy}」`);
    }
  }
  if (finalCount > 1) errors.push("配置中存在多个 FINAL 兜底规则，请只保留最后一条");

  return [...new Set(errors)];
}
