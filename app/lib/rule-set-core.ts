export type RuleSetEntry = { type: string; value: string; options?: string[] };

function splitRuleLine(line: string) {
  return line.split(",").map((part) => part.trim());
}

export function parseRuleSetEntries(input: string | unknown[]) {
  if (Array.isArray(input)) return dedupeEntries(input.map((entry) => normalizeEntry(entry)).filter(isRuleSetEntry));
  const entries: RuleSetEntry[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitRuleLine(line);
    const type = (parts[0] || "").toUpperCase();
    if (!type) continue;
    if (type === "RULE-SET") {
      if (parts[1]) entries.push({ type, value: parts[1], options: parts.slice(3).filter(Boolean) });
      continue;
    }
    if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP", "GEOSITE"].includes(type) && parts[1]) {
      entries.push({ type, value: parts[1], options: parts.slice(3).filter(Boolean) });
    } else if (type === "FINAL") {
      // FINAL is a routing fallback, not a reusable ruleset entry.
      continue;
    }
  }
  return dedupeEntries(entries);
}

function normalizeEntry(entry: unknown): RuleSetEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { type?: unknown; value?: unknown; options?: unknown };
  if (!record.type || !record.value) return null;
  return { type: String(record.type).toUpperCase(), value: String(record.value).trim(), options: Array.isArray(record.options) ? record.options.map(String).map((item) => item.trim()).filter(Boolean) : [] };
}

function isRuleSetEntry(entry: RuleSetEntry | null): entry is RuleSetEntry {
  return Boolean(entry);
}

function entryKey(entry: RuleSetEntry) {
  return `${entry.type}\u0000${entry.value}\u0000${(entry.options || []).join(",")}`;
}

export function dedupeEntries(entries: RuleSetEntry[]) {
  const seen = new Set<string>();
  return entries.map((entry) => normalizeEntry(entry)).filter(isRuleSetEntry).filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generatedLine(entry: RuleSetEntry, policy: string) {
  if (entry.type === "GEOSITE") {
    const value = entry.value.startsWith("geosite:") ? entry.value : `geosite:${entry.value}`;
    return ["RULE-SET", value, policy, ...(entry.options || [])].join(",");
  }
  return [entry.type, entry.value, policy, ...(entry.options || [])].join(",");
}

function rulePolicy(parts: string[]) {
  if (parts[0]?.toUpperCase() === "FINAL") return "";
  return parts.length >= 3 ? parts[2].trim() : "";
}

export function composeBoundRuleSets(content: string, ruleSets: Array<{ id: string; entries: RuleSetEntry[]; status?: string; enabled?: boolean | number }>, bindings: Array<{ groupName: string; ruleSetId: string }> | Record<string, string>) {
  const bindingEntries = Array.isArray(bindings) ? bindings : Object.entries(bindings).map(([groupName, ruleSetId]) => ({ groupName, ruleSetId }));
  const setById = new Map(ruleSets.filter((set) => set.status !== "deleted" && set.enabled !== false && set.enabled !== 0).map((set) => [set.id, set]));
  const bindingByGroup = new Map(bindingEntries.filter((item) => item.groupName && item.ruleSetId).map((item) => [item.groupName.trim().toLowerCase(), item.ruleSetId]));
  if (!bindingByGroup.size) return content;
  const lines = content.split(/\r?\n/);
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  if (ruleStart < 0) return content;
  const ruleEnd = lines.findIndex((line, index) => index > ruleStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = ruleEnd < 0 ? lines.length : ruleEnd;
  const positions = new Map<string, number>();
  const removed = new Set<number>();
  for (let index = ruleStart + 1; index < end; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = splitRuleLine(raw);
    const policy = rulePolicy(parts);
    const bindingId = bindingByGroup.get(policy.toLowerCase());
    if (!bindingId || !setById.has(bindingId)) continue;
    const key = policy.toLowerCase();
    if (!positions.has(key)) positions.set(key, index);
    removed.add(index);
  }
  const generated = new Map<string, string[]>();
  for (const [groupKey, ruleSetId] of bindingByGroup) {
    const set = setById.get(ruleSetId);
    if (!set) continue;
    generated.set(groupKey, dedupeEntries(set.entries || []).map((entry) => generatedLine(entry, bindingEntries.find((item) => item.groupName.trim().toLowerCase() === groupKey)?.groupName.trim() || groupKey)));
  }
  const fallbackIndex = Math.max(ruleStart + 1, lines.findIndex((line, index) => index > ruleStart && line.trim().toUpperCase().startsWith("FINAL,")));
  const insertAt = new Map<number, string[]>();
  for (const groupKey of bindingByGroup.keys()) {
    const entries = generated.get(groupKey) || [];
    if (!entries.length) continue;
    const index = positions.get(groupKey) ?? (fallbackIndex > ruleStart ? fallbackIndex : end);
    insertAt.set(index, [...(insertAt.get(index) || []), ...entries]);
  }
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (insertAt.has(index)) result.push(...Array.from(new Set(insertAt.get(index))));
    if (!removed.has(index)) result.push(lines[index]);
  }
  if (insertAt.has(lines.length)) result.push(...Array.from(new Set(insertAt.get(lines.length))));
  return result.join("\n");
}
