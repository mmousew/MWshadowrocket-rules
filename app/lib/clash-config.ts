import { parse as parseYaml } from "yaml";

type ShadowrocketGroup = { name: string; kind: string; items: string[] };
type ShadowrocketRule = { type: string; value: string; policy: string; options: string[] };
type ClashProxy = Record<string, unknown>;
type RuleProvider = { name: string; url: string; format: "text" | "yaml" };

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

function quote(value: unknown) {
  return JSON.stringify(String(value));
}

function yamlValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `\n${value.map((item) => `${pad}- ${yamlValue(item, indent + 2)}`).join("\n")}`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    return `\n${entries.map(([key, item]) => `${pad}${key}: ${yamlValue(item, indent + 2)}`).join("\n")}`;
  }
  return "null";
}

function yamlList(items: Record<string, unknown>[]) {
  return items.map((item) => Object.entries(item).map(([key, value], index) => {
    const prefix = index === 0 ? "- " : "  ";
    return `${prefix}${key}: ${yamlValue(value, 4)}`;
  }).join("\n")).join("\n");
}

function parseGroupsAndRules(content: string) {
  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  const groups: ShadowrocketGroup[] = [];
  const rules: ShadowrocketRule[] = [];

  lines.forEach((raw, index) => {
    if (index > groupStart && index < ruleStart) {
      const match = raw.match(/^\s*([^#=]+?)\s*=\s*(.+)$/);
      if (match) {
        const values = match[2].split(",").map((item) => item.trim()).filter(Boolean);
        groups.push({ name: match[1].trim(), kind: values[0] || "select", items: values.slice(1) });
      }
    }
    if (index > ruleStart && raw.trim() && !raw.trim().startsWith("#")) {
      const parts = splitRuleLine(raw);
      if (parts[0] === "FINAL" && parts[1]) rules.push({ type: "FINAL", value: "", policy: parts[1], options: parts.slice(2) });
      else if (parts.length >= 3) rules.push({ type: parts[0], value: parts[1], policy: parts[2], options: parts.slice(3) });
    }
  });
  return { groups, rules };
}

function parseShadowrocketProxies(content: string): ClashProxy[] {
  const lines = content.split(/\r?\n/);
  const proxyStart = lines.findIndex((line) => line.trim() === "[Proxy]");
  const nextSection = lines.findIndex((line, index) => index > proxyStart && /^\s*\[.+\]\s*$/.test(line));
  if (proxyStart < 0) return [];

  return lines.slice(proxyStart + 1, nextSection > proxyStart ? nextSection : undefined).flatMap((raw) => {
    const separator = raw.indexOf("=");
    if (separator < 1) return [];
    const name = raw.slice(0, separator).trim();
    if (!name || /^(Traffic|Expire|流量|到期|剩余)\b/i.test(name)) return [];
    const values = raw.slice(separator + 1).split(",").map((item) => item.trim()).filter(Boolean);
    if (values[0] !== "ss" || !values[1] || !values[2]) return [];
    const options = Object.fromEntries(values.slice(3).map((item) => {
      const optionSeparator = item.indexOf("=");
      return optionSeparator > 0 ? [item.slice(0, optionSeparator).trim(), item.slice(optionSeparator + 1).trim()] : [item, "true"];
    }));
    const proxy: ClashProxy = {
      name,
      type: "ss",
      server: values[1],
      port: Number(values[2]),
      cipher: options["encrypt-method"] || "aes-128-gcm",
      password: options.password || "",
      udp: options["udp-relay"] === "true",
    };
    if (options.obfs) {
      proxy.plugin = "obfs";
      proxy["plugin-opts"] = { mode: options.obfs, ...(options["obfs-host"] ? { host: options["obfs-host"] } : {}) };
    }
    return [proxy];
  });
}

function parseClashProxies(content: string): ClashProxy[] {
  try {
    const parsed = parseYaml(content) as { proxies?: unknown } | null;
    if (!Array.isArray(parsed?.proxies)) return [];
    return parsed.proxies.filter((proxy): proxy is ClashProxy => Boolean(proxy && typeof proxy === "object" && typeof (proxy as ClashProxy).name === "string" && typeof (proxy as ClashProxy).type === "string"));
  } catch { return []; }
}

function decodeLooseBase64(value: string) {
  try { return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}

function parseSsLink(link: string, position: number): ClashProxy | null {
  try {
    const hashPosition = link.indexOf("#");
    const name = hashPosition >= 0 ? decodeURIComponent(link.slice(hashPosition + 1)) : `SS 节点 ${position + 1}`;
    const withoutHash = link.slice(5, hashPosition >= 0 ? hashPosition : undefined);
    const queryPosition = withoutHash.indexOf("?");
    const main = withoutHash.slice(0, queryPosition >= 0 ? queryPosition : undefined);
    const query = new URLSearchParams(queryPosition >= 0 ? withoutHash.slice(queryPosition + 1) : "");
    const expanded = main.includes("@") ? main : decodeLooseBase64(main);
    const at = expanded.lastIndexOf("@");
    if (at < 1) return null;
    let credentials = expanded.slice(0, at);
    if (!credentials.includes(":")) credentials = decodeLooseBase64(credentials);
    const separator = credentials.indexOf(":");
    if (separator < 1) return null;
    const address = new URL(`http://${expanded.slice(at + 1)}`);
    const proxy: ClashProxy = {
      name,
      type: "ss",
      server: address.hostname,
      port: Number(address.port),
      cipher: decodeURIComponent(credentials.slice(0, separator)),
      password: decodeURIComponent(credentials.slice(separator + 1)),
      udp: true,
    };
    const plugin = query.get("plugin");
    if (plugin) {
      const pluginParts = decodeURIComponent(plugin).split(";");
      if (/obfs/i.test(pluginParts[0])) {
        const options = Object.fromEntries(pluginParts.slice(1).map((part) => part.split("=", 2)));
        proxy.plugin = "obfs";
        proxy["plugin-opts"] = { mode: options.obfs || "http", ...(options["obfs-host"] ? { host: options["obfs-host"] } : {}) };
      }
    }
    return proxy;
  } catch { return null; }
}

function parseLinkSubscription(content: string) {
  const trimmed = content.trim();
  const decoded = /^([A-Za-z0-9+/_=-]+\s*)+$/.test(trimmed) ? decodeLooseBase64(trimmed) : "";
  const links = (decoded.includes("://") ? decoded : trimmed).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return links.flatMap((link, index) => link.startsWith("ss://") ? [parseSsLink(link, index)].filter((proxy): proxy is ClashProxy => Boolean(proxy)) : []);
}

function parseAirportProxies(content: string): ClashProxy[] {
  const shadowrocket = parseShadowrocketProxies(content);
  const clash = shadowrocket.length ? [] : parseClashProxies(content);
  const candidates = shadowrocket.length ? shadowrocket : clash.length ? clash : parseLinkSubscription(content);
  const names = new Set<string>();
  return candidates.filter((proxy) => {
    const name = String(proxy.name || "");
    if (!name || names.has(name) || /^(Traffic|Expire|流量|到期|剩余)\b/i.test(name)) return false;
    names.add(name);
    return true;
  });
}

export function getAirportProxyCount(content: string) {
  return parseAirportProxies(content).length;
}

function convertGroups(groups: ShadowrocketGroup[]) {
  const converted: Record<string, unknown>[] = [{ name: "PROXY", type: "select", "include-all": true }];
  for (const group of groups) {
    const regex = group.items.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length);
    const includeAll = group.items.includes("include-all-proxies=true");
    if (includeAll || regex) {
      converted.push({ name: group.name, type: group.kind === "url-test" ? "url-test" : "select", "include-all": true, ...(regex ? { filter: `(?i)${regex}` } : {}) });
      continue;
    }
    const proxies = group.items.filter((item) => !item.includes("=")).map((item) => item === "PROXY" ? "PROXY" : item);
    converted.push({ name: group.name, type: group.kind === "url-test" ? "url-test" : "select", proxies: proxies.length ? proxies : ["DIRECT"] });
  }
  return converted;
}

function convertRules(rules: ShadowrocketRule[]) {
  const converted: string[] = [];
  const providers: RuleProvider[] = [];
  let skipped = 0;

  for (const rule of rules) {
    if (["USER-AGENT", "URL-REGEX"].includes(rule.type)) { skipped += 1; continue; }
    if (rule.type === "FINAL") { converted.push(`MATCH,${rule.policy}`); continue; }
    if (rule.type === "RULE-SET") {
      if (rule.value.startsWith("geosite:")) converted.push(`GEOSITE,${rule.value.slice(8)},${rule.policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      else if (/^https?:\/\//i.test(rule.value)) {
        const existing = providers.find((item) => item.url === rule.value);
        const provider = existing || { name: `mw_set_${providers.length + 1}`, url: rule.value, format: /\.ya?ml(?:\?|$)/i.test(rule.value) ? "yaml" as const : "text" as const };
        if (!existing) providers.push(provider);
        converted.push(`RULE-SET,${provider.name},${rule.policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      } else skipped += 1;
      continue;
    }
    converted.push([rule.type, rule.value, rule.policy, ...rule.options].filter(Boolean).join(","));
  }
  return { converted, providers, skipped };
}

export function buildClashConfig(ruleContent: string, airportContent: string) {
  const proxies = parseAirportProxies(airportContent);
  if (!proxies.length) throw new Error("机场配置没有可转换的节点");
  const { groups, rules } = parseGroupsAndRules(ruleContent);
  const proxyGroups = convertGroups(groups);
  const { converted, providers, skipped } = convertRules(rules);
  const providerYaml = providers.length ? `\nrule-providers:\n${providers.map((provider) => `  ${provider.name}:\n    type: http\n    behavior: classical\n    format: ${provider.format}\n    url: ${quote(provider.url)}\n    path: ./ruleset/${provider.name}.${provider.format === "yaml" ? "yaml" : "list"}\n    interval: 86400`).join("\n")}` : "";

  return `# MW Rules for ClashX Meta\n# 自动合并机场节点与 GitHub 分流规则；跳过 ${skipped} 条 Clash 不支持的规则\nmixed-port: 7890\nmode: rule\nallow-lan: false\nlog-level: info\nipv6: false\nunified-delay: true\ntcp-concurrent: true\nfind-process-mode: strict\n\ndns:\n  enable: true\n  ipv6: false\n  enhanced-mode: fake-ip\n  nameserver:\n    - https://223.5.5.5/dns-query\n    - https://1.12.12.12/dns-query\n  fake-ip-filter:\n    - "*.lan"\n    - "+.local"\n    - "localhost.ptlogin2.qq.com"\n\nproxies:\n${yamlList(proxies)}\n\nproxy-groups:\n${yamlList(proxyGroups)}${providerYaml}\n\nrules:\n${converted.map((rule) => `  - ${quote(rule)}`).join("\n")}\n`;
}
