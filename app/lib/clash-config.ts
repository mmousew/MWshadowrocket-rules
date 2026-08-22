import { parse as parseYaml } from "yaml";

type ShadowrocketGroup = { name: string; kind: string; items: string[] };
type ShadowrocketRule = { type: string; value: string; policy: string; options: string[] };
type ClashProxy = Record<string, unknown>;
type RuleProvider = { name: string; url: string; format: "text" | "yaml" };

const FINAL_GROUP_SOURCE_NAME = "final";
const FINAL_GROUP_CLIENT_NAME = "MW-FINAL";

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
      if (parts[0].toUpperCase() === "FINAL" && parts[1]) rules.push({ type: "FINAL", value: "", policy: parts[1], options: parts.slice(2) });
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
    if (values[0].toLowerCase() !== "ss" || !values[1] || !values[2]) return [];
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

function readAirportDns(sources: string[]) {
  const proxyServerNameserver = new Set<string>();
  const defaultNameserver = new Set<string>();
  const nameserver = new Set<string>();
  const fallback = new Set<string>();
  const fakeIpFilter = new Set<string>();
  let fakeIpRange = "";
  let useHosts = false;
  let listen = "";
  for (const source of sources) {
    try {
      const general = source.match(/^\[General\]([\s\S]*?)(?=^\[|$)/m)?.[1] || "";
      const readGeneralList = (key: string) => general.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "mi"))?.[1]?.split(",").map((item) => item.trim()).filter(Boolean) || [];
      readGeneralList("dns-server").forEach((item) => defaultNameserver.add(item));
      readGeneralList("fallback-dns-server").forEach((item) => fallback.add(item));
      let parsed: { dns?: unknown } | null = null;
      try { parsed = parseYaml(source) as { dns?: unknown } | null; } catch { /* Shadowrocket format is parsed below */ }
      if (parsed?.dns && typeof parsed.dns === "object") {
        const dns = parsed.dns as Record<string, unknown>;
        const list = (key: string) => Array.isArray(dns[key]) ? dns[key].filter((item): item is string => typeof item === "string") : [];
        list("proxy-server-nameserver").forEach((item) => proxyServerNameserver.add(item));
        list("default-nameserver").forEach((item) => defaultNameserver.add(item));
        list("nameserver").forEach((item) => nameserver.add(item));
        list("fallback").forEach((item) => fallback.add(item));
        // A source-level wildcard applies to every domain. Merging it would
        // let one airport override the DNS behavior of all other airports.
        list("fake-ip-filter")
          .map((item) => item.trim())
          .filter((item) => item !== "*")
          .forEach((item) => fakeIpFilter.add(item));
        if (!fakeIpRange && typeof dns["fake-ip-range"] === "string") fakeIpRange = dns["fake-ip-range"];
        if (dns["use-hosts"] === true) useHosts = true;
        if (!listen && typeof dns.listen === "string") listen = dns.listen;
      }
    } catch { /* use the safe defaults below */ }
  }
  return {
    proxyServerNameserver: [...proxyServerNameserver],
    defaultNameserver: [...defaultNameserver],
    nameserver: [...nameserver],
    fallback: [...fallback],
    fakeIpFilter: [...fakeIpFilter],
    fakeIpRange,
    useHosts,
    listen,
  };
}

function readSourceProxyDnsResolvers(source: string) {
  try {
    const parsed = parseYaml(source) as { dns?: unknown } | null;
    if (parsed?.dns && typeof parsed.dns === "object") {
      const dns = parsed.dns as Record<string, unknown>;
      const list = (key: string) => Array.isArray(dns[key]) ? dns[key].filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
      const proxyResolvers = list("proxy-server-nameserver");
      if (proxyResolvers.length) return proxyResolvers;
      const defaultResolvers = list("default-nameserver");
      if (defaultResolvers.length) return defaultResolvers;
    }
    const general = source.match(/^\[General\]([\s\S]*?)(?=^\[|$)/m)?.[1] || "";
    return general.match(/^dns-server\s*=\s*(.+)$/mi)?.[1]?.split(",").map((item) => item.trim()).filter((item) => item && !/^system$/i.test(item)) || [];
  } catch {
    return [];
  }
}

function isLocalResolver(value: string) {
  return /^(?:udp|tcp|tls|https?):\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(value) || /^(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(value);
}

function readAirportDnsPolicies(sources: string[]) {
  const policies = new Map<string, string[]>();
  for (const source of sources) {
    const resolvers = readSourceProxyDnsResolvers(source).filter((item) => !isLocalResolver(item));
    if (!resolvers.length) continue;
    for (const proxy of parseAirportProxies(source)) {
      const host = String(proxy.server || "").trim().toLowerCase();
      if (!host || /^[0-9a-f:.]+$/i.test(host)) continue;
      const labels = host.split(".").filter(Boolean);
      if (labels.length < 2) continue;
      const suffix = labels.slice(-2).join(".");
      if (!policies.has(suffix)) policies.set(suffix, resolvers);
    }
  }
  return [...policies.entries()];
}

function createDnsQuery(host: string) {
  const labels = host.split(".").filter(Boolean);
  const parts: Uint8Array[] = [Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])];
  for (const label of labels) {
    const bytes = Buffer.from(label);
    if (!bytes.length || bytes.length > 63) return "";
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]));
  return Buffer.concat(parts).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function skipDnsName(bytes: Uint8Array, start: number) {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset];
    if (length === 0) return offset + 1;
    if ((length & 0xc0) === 0xc0) return offset + 2;
    if (length > 63) return -1;
    offset += length + 1;
  }
  return -1;
}

function parseDnsARecords(bytes: Uint8Array) {
  if (bytes.length < 12) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const questions = view.getUint16(4);
  const answers = view.getUint16(6);
  let offset = 12;
  for (let index = 0; index < questions; index += 1) {
    offset = skipDnsName(bytes, offset);
    if (offset < 0 || offset + 4 > bytes.length) return [];
    offset += 4;
  }
  const records: string[] = [];
  for (let index = 0; index < answers; index += 1) {
    offset = skipDnsName(bytes, offset);
    if (offset < 0 || offset + 10 > bytes.length) break;
    const type = view.getUint16(offset);
    const classCode = view.getUint16(offset + 2);
    const length = view.getUint16(offset + 8);
    offset += 10;
    if (offset + length > bytes.length) break;
    if (type === 1 && classCode === 1 && length === 4) {
      records.push(`${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`);
    }
    offset += length;
  }
  return records;
}

async function resolveHostWithDoH(host: string, resolver: string) {
  if (!/^https?:\/\//i.test(resolver)) return [];
  try {
    const url = new URL(resolver);
    const query = createDnsQuery(host);
    if (!query) return [];
    url.searchParams.set("dns", query);
    const response = await fetch(url, { headers: { Accept: "application/dns-message" }, cache: "no-store" });
    if (!response.ok) return [];
    return parseDnsARecords(new Uint8Array(await response.arrayBuffer())).filter(isUsableResolvedAddress);
  } catch {
    return [];
  }
}

function isUsableResolvedAddress(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return !(first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 198 && second >= 18 && second <= 19);
}

export async function resolveAirportProxyHosts(sources: string[]) {
  const hostResolvers = new Map<string, string[]>();
  for (const source of sources) {
    const resolvers = readSourceProxyDnsResolvers(source).filter((item) => !isLocalResolver(item));
    if (!resolvers.length) continue;
    for (const proxy of parseAirportProxies(source)) {
      const host = String(proxy.server || "").trim().toLowerCase();
      if (!host || /^[0-9a-f:.]+$/i.test(host)) continue;
      hostResolvers.set(host, [...new Set([...(hostResolvers.get(host) || []), ...resolvers])]);
    }
  }
  const resolved = await Promise.all([...hostResolvers.entries()].map(async ([host, resolvers]) => {
    for (const resolver of resolvers) {
      const addresses = await resolveHostWithDoH(host, resolver);
      if (addresses.length) return [host, addresses[0]] as const;
    }
    return null;
  }));
  return Object.fromEntries(resolved.filter((item): item is readonly [string, string] => Boolean(item)));
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
    const udpOption = query.get("udp-relay") || query.get("udp");
    const proxy: ClashProxy = {
      name,
      type: "ss",
      server: address.hostname,
      port: Number(address.port),
      cipher: decodeURIComponent(credentials.slice(0, separator)),
      password: decodeURIComponent(credentials.slice(separator + 1)),
      udp: udpOption ? /^(?:1|true|yes)$/i.test(udpOption) : false,
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
  return links.flatMap((link, index) => /^ss:\/\//i.test(link) ? [parseSsLink(link, index)].filter((proxy): proxy is ClashProxy => Boolean(proxy)) : []);
}

export function parseAirportProxies(content: string): ClashProxy[] {
  const shadowrocket = parseShadowrocketProxies(content);
  const clash = shadowrocket.length ? [] : parseClashProxies(content);
  const candidates = shadowrocket.length ? shadowrocket : clash.length ? clash : parseLinkSubscription(content);
  const names = new Set<string>();
  return candidates.filter((proxy) => {
    const name = String(proxy.name || "");
    const server = String(proxy.server || "");
    const nameKey = name.toLowerCase();
    if (!name || !server || /^(127\.0\.0\.1|localhost)$/i.test(server) || names.has(nameKey) || /^(Traffic|Expire|流量|到期|剩余)\b/i.test(name)) return false;
    names.add(nameKey);
    return true;
  });
}

export function getAirportProxyCount(content: string) {
  return parseAirportProxies(content).length;
}

function convertGroups(groups: ShadowrocketGroup[], proxyNames: string[]) {
  const available = createPolicyAliases(groups, "PROXY");
  proxyNames.forEach((name) => available.set(name.trim().toLowerCase(), name));
  groups.filter((group) => group.name.trim().toLowerCase() !== "proxies").forEach((group) => {
    available.set(group.name.trim().toLowerCase(), group.name);
  });
  const converted: Record<string, unknown>[] = [{ name: "PROXY", type: "select", proxies: proxyNames.length ? proxyNames : ["DIRECT"] }];
  for (const group of groups) {
    if (group.name.trim().toLowerCase() === "proxies") continue;
    const regex = findOption(group.items, "policy-regex-filter");
    const includeAll = findOption(group.items, "include-all-proxies")?.toLowerCase() === "true";
    if (includeAll || regex) {
      let matched = proxyNames;
      if (regex) {
        try {
          const matcher = new RegExp(regex, "i");
          matched = proxyNames.filter((name) => matcher.test(name));
        } catch {
          matched = proxyNames;
        }
      }
      converted.push({ name: group.name, type: group.kind === "url-test" ? "url-test" : "select", proxies: matched.length ? matched : ["DIRECT"] });
      continue;
    }
    const proxies = group.items
      .filter((item) => !item.includes("=") && !/^(Traffic|Expire|流量|到期|剩余)\b/i.test(item))
      .map((item) => available.get(item.trim().toLowerCase()) || "")
      .filter(Boolean);
    converted.push({ name: group.name, type: group.kind === "url-test" ? "url-test" : "select", proxies: proxies.length ? proxies : ["DIRECT"] });
  }
  return converted;
}

function createPolicyAliases(groups: ShadowrocketGroup[], proxiesAlias: string) {
  const aliases = new Map<string, string>([
    ["direct", "DIRECT"],
    ["reject", "REJECT"],
    ["reject-drop", "REJECT-DROP"],
    ["reject-no-drop", "REJECT-NO-DROP"],
    ["proxy", "PROXY"],
    ["proxies", proxiesAlias],
  ]);
  groups.filter((group) => group.name.trim().toLowerCase() !== "proxies").forEach((group) => {
    aliases.set(group.name.trim().toLowerCase(), group.name.trim());
  });
  return aliases;
}

function findOption(items: string[], key: string) {
  const prefix = `${key.toLowerCase()}=`;
  return items.find((item) => item.trim().toLowerCase().startsWith(prefix))?.trim().slice(prefix.length);
}

function normalizeFinalGroupForClash(groups: ShadowrocketGroup[], rules: ShadowrocketRule[]) {
  const normalizedGroups = groups.map((group) => group.name.trim().toLowerCase() === FINAL_GROUP_SOURCE_NAME
    ? { name: FINAL_GROUP_CLIENT_NAME, kind: "select", items: ["Proxies", "DIRECT"] }
    : group);
  const normalizedRules = rules.map((rule) => ({
    ...rule,
    policy: rule.type.toUpperCase() === "FINAL" || rule.policy.trim().toLowerCase() === FINAL_GROUP_SOURCE_NAME
      ? FINAL_GROUP_CLIENT_NAME
      : rule.policy,
  }));
  return { groups: normalizedGroups, rules: normalizedRules };
}

function convertRules(rules: ShadowrocketRule[], groups: ShadowrocketGroup[]) {
  const aliases = createPolicyAliases(groups, "PROXY");
  const converted: string[] = [];
  const providers: RuleProvider[] = [];
  let skipped = 0;

  for (const rule of rules) {
    const policy = aliases.get(rule.policy.trim().toLowerCase()) || rule.policy.trim();
    const ruleType = rule.type.toUpperCase();
    if (["USER-AGENT", "URL-REGEX"].includes(ruleType)) { skipped += 1; continue; }
    if (ruleType === "FINAL") { converted.push(`MATCH,${policy}`); continue; }
    if (ruleType === "RULE-SET") {
      if (/^geosite:/i.test(rule.value)) converted.push(`GEOSITE,${rule.value.slice(8)},${policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      else if (/^https?:\/\//i.test(rule.value)) {
        const existing = providers.find((item) => item.url === rule.value);
        const provider = existing || { name: `mw_set_${providers.length + 1}`, url: rule.value, format: /\.ya?ml(?:\?|$)/i.test(rule.value) ? "yaml" as const : "text" as const };
        if (!existing) providers.push(provider);
        converted.push(`RULE-SET,${provider.name},${policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      } else skipped += 1;
      continue;
    }
    converted.push([ruleType, rule.value, policy, ...rule.options].filter(Boolean).join(","));
  }
  return { converted, providers, skipped };
}

export function buildClashConfig(ruleContent: string, airportContent: string | string[], hostMappings: Record<string, string> = {}) {
  const sources = Array.isArray(airportContent) ? airportContent : [airportContent];
  const seenProxyNames = new Set<string>();
  const proxies = sources.flatMap((source) => parseAirportProxies(source)).map((proxy) => {
    const host = String(proxy.server || "").trim().toLowerCase();
    const resolvedAddress = hostMappings[host];
    return resolvedAddress && isUsableResolvedAddress(resolvedAddress)
      ? { ...proxy, server: resolvedAddress }
      : proxy;
  }).filter((proxy) => {
    const name = String(proxy.name || "");
    const nameKey = name.trim().toLowerCase();
    if (!name || seenProxyNames.has(nameKey)) return false;
    seenProxyNames.add(nameKey);
    return true;
  });
  if (!proxies.length) throw new Error("机场配置没有可转换的节点");
  const parsed = parseGroupsAndRules(ruleContent);
  const { groups, rules } = normalizeFinalGroupForClash(parsed.groups, parsed.rules);
  const proxyGroups = convertGroups(groups, proxies.map((proxy) => String(proxy.name)));
  const { converted, providers, skipped } = convertRules(rules, groups);
  const airportDns = readAirportDns(sources);
  const defaultNameserver = airportDns.defaultNameserver.length ? airportDns.defaultNameserver : ["223.5.5.5", "119.29.29.29"];
  // Use only portable resolvers in the merged file. A source-local resolver
  // such as 127.0.0.1:7874 can self-reference the generated config and break
  // every airport when multiple sources are combined.
  const proxyServerNameserver = [...new Set([...airportDns.proxyServerNameserver, ...defaultNameserver])]
    .filter((item) => !/^(?:udp|tcp|tls|https?):\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(item));
  const nameserver = airportDns.nameserver.length ? airportDns.nameserver : ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"];
  const fallback = airportDns.fallback.length ? airportDns.fallback : ["https://223.5.5.5/dns-query", "https://223.6.6.6/dns-query"];
  const nameserverPolicies = readAirportDnsPolicies(sources);
  const providerYaml = providers.length ? `\nrule-providers:\n${providers.map((provider) => `  ${provider.name}:\n    type: http\n    behavior: classical\n    format: ${provider.format}\n    url: ${quote(provider.url)}\n    path: ./ruleset/${provider.name}.${provider.format === "yaml" ? "yaml" : "list"}\n    interval: 86400`).join("\n")}` : "";

  const dnsYaml = [
    "dns:",
    "  enable: true",
    "  ipv6: false",
    "  default-nameserver:",
    ...defaultNameserver.map((item) => `    - ${quote(item)}`),
    "  proxy-server-nameserver:",
    ...proxyServerNameserver.map((item) => `    - ${quote(item)}`),
    "  enhanced-mode: fake-ip",
    ...(airportDns.fakeIpRange ? [`  fake-ip-range: ${quote(airportDns.fakeIpRange)}`] : []),
    ...(airportDns.useHosts ? ["  use-hosts: true"] : []),
    "  nameserver:",
    ...nameserver.map((item) => `    - ${quote(item)}`),
    "  fallback:",
    ...fallback.map((item) => `    - ${quote(item)}`),
    ...(nameserverPolicies.length ? ["  nameserver-policy:", ...nameserverPolicies.flatMap(([suffix, resolvers]) => [`    ${quote(`+.${suffix}`)}:`, ...resolvers.map((item) => `      - ${quote(item)}`)])] : []),
    "  fake-ip-filter:",
    ...[...new Set(["*.lan", "+.local", "localhost.ptlogin2.qq.com", ...airportDns.fakeIpFilter])].map((item) => `    - ${quote(item)}`),
  ].join("\n");
  return `# MW Rules for ClashX Meta\n# 自动合并机场节点与 GitHub 分流规则；跳过 ${skipped} 条 Clash 不支持的规则\nmixed-port: 7890\nmode: rule\nallow-lan: false\nlog-level: info\nipv6: false\n\n${dnsYaml}\n\nproxies:\n${yamlList(proxies)}\n\nproxy-groups:\n${yamlList(proxyGroups)}${providerYaml}\n\nrules:\n${converted.map((rule) => `  - ${quote(rule)}`).join("\n")}\n`;
}

function normalizeFinalGroupForShadowrocket(config: string) {
  const lines = config.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  if (groupStart < 0 || ruleStart < 0 || ruleStart <= groupStart) return config;

  const groupNames = lines.slice(groupStart + 1, ruleStart)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? line.slice(0, separator).trim() : "";
    })
    .filter(Boolean);
  const proxiesGroup = groupNames.find((name) => name.toLowerCase() === "proxies") || "PROXY";

  return lines.map((raw, index) => {
    if (index > groupStart && index < ruleStart) {
      const separator = raw.indexOf("=");
      if (separator < 1) return raw;
      const name = raw.slice(0, separator).trim();
      if (name.toLowerCase() === FINAL_GROUP_SOURCE_NAME || name.toLowerCase() === FINAL_GROUP_CLIENT_NAME.toLowerCase()) {
        return `${FINAL_GROUP_CLIENT_NAME} = select,${proxiesGroup},DIRECT`;
      }
      const values = splitRuleLine(raw.slice(separator + 1));
      if (!values.length) return raw;
      const items = values.slice(1).map((item) => item.trim().toLowerCase() === FINAL_GROUP_SOURCE_NAME ? FINAL_GROUP_CLIENT_NAME : item);
      return `${name} = ${[values[0], ...items].join(",")}`;
    }
    if (index > ruleStart) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) return raw;
      const parts = splitRuleLine(raw);
      if (parts[0].toUpperCase() === "FINAL") return `FINAL,${FINAL_GROUP_CLIENT_NAME}${parts.length > 2 ? `,${parts.slice(2).join(",")}` : ""}`;
      if (parts.length >= 3 && parts[2].trim().toLowerCase() === FINAL_GROUP_SOURCE_NAME) {
        parts[2] = FINAL_GROUP_CLIENT_NAME;
        return parts.join(",");
      }
    }
    return raw;
  }).join("\n");
}

function shadowrocketProxyLine(proxy: ClashProxy) {
  const name = String(proxy.name || "").replace(/[\r\n=,#]/g, " ").trim();
  const server = String(proxy.server || "");
  const port = String(proxy.port || "");
  const cipher = String(proxy.cipher || "aes-128-gcm");
  const password = String(proxy.password || "").replace(/[\r\n,]/g, " ");
  if (!name || !server || !port || !password) return "";
  const options = [`encrypt-method=${cipher}`, `password=${password}`];
  if (proxy.udp === true) options.push("udp-relay=true");
  const pluginOptions = proxy["plugin-opts"] as Record<string, unknown> | undefined;
  if (proxy.plugin === "obfs" && pluginOptions?.mode) {
    options.push(`obfs=${String(pluginOptions.mode)}`);
    if (pluginOptions.host) options.push(`obfs-host=${String(pluginOptions.host)}`);
  }
  return `${name}=ss,${server},${port},${options.join(",")}`;
}

function normalizeShadowrocketConfig(config: string) {
  const lines = config.split(/\r?\n/);
  const sectionStarts: Array<{ name: string; index: number }> = [];
  const metadata: string[] = [];
  const metadataSet = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) sectionStarts.push({ name: section[1], index });
    if (line.trim().startsWith("#!") && !metadataSet.has(line.trim())) {
      metadataSet.add(line.trim());
      metadata.push(line.trim());
    }
  }
  if (!sectionStarts.length) return config.trim() + "\n";
  const blocks = new Map<string, string[]>();
  sectionStarts.forEach((section, position) => {
    const end = sectionStarts[position + 1]?.index ?? lines.length;
    const block = lines.slice(section.index, end).filter((line) => !line.trim().startsWith("#!"));
    blocks.set(section.name, block);
  });
  const preferredOrder = ["General", "Proxy Group", "Proxy", "Rule", "URL Rewrite", "Host", "MITM"];
  const ordered = preferredOrder.filter((name) => blocks.has(name)).map((name) => blocks.get(name) || []);
  const remaining = [...blocks.entries()].filter(([name]) => !preferredOrder.includes(name)).map(([, block]) => block);
  return [...metadata, ...ordered.flatMap((block) => ["", ...block]), ...remaining.flatMap((block) => ["", ...block])].join("\n").trim() + "\n";
}

function addShadowrocketAirportDns(config: string, sources: string[]) {
  const airportDns = readAirportDns(sources);
  const resolvers = [...new Set([
    ...airportDns.proxyServerNameserver,
    ...airportDns.defaultNameserver,
  ])].filter((item) => !isLocalResolver(item));
  if (!resolvers.length) return config;

  const lines = config.split(/\r?\n/);
  let generalStart = lines.findIndex((line) => line.trim().toLowerCase() === "[general]");
  if (generalStart < 0) {
    lines.unshift("[General]");
    generalStart = 0;
  }
  const generalEnd = lines.findIndex((line, index) => index > generalStart && /^\s*\[.+\]\s*$/.test(line));
  const end = generalEnd >= 0 ? generalEnd : lines.length;
  const general = lines.slice(generalStart + 1, end);
  const dnsIndex = general.findIndex((line) => /^\s*dns-server\s*=/i.test(line));
  const existing = dnsIndex >= 0
    ? general[dnsIndex].slice(general[dnsIndex].indexOf("=") + 1).split(",").map((item) => item.trim()).filter((item) => item && !/^system$/i.test(item))
    : [];
  const merged = [...new Set([...resolvers, ...existing])];
  const dnsLine = `dns-server = ${merged.join(",")}`;
  if (dnsIndex >= 0) general[dnsIndex] = dnsLine;
  else general.push(dnsLine);
  lines.splice(generalStart + 1, end - generalStart - 1, ...general);
  return lines.join("\n");
}

function addShadowrocketHostMappings(config: string, hostMappings: Record<string, string>) {
  const entries = Object.entries(hostMappings).filter(([host, address]) => host && address);
  if (!entries.length) return config;
  const lines = config.split(/\r?\n/);
  const generalStart = lines.findIndex((line) => line.trim() === "[General]");
  if (generalStart >= 0) {
    const generalEnd = lines.findIndex((line, index) => index > generalStart && /^\s*\[.+\]\s*$/.test(line));
    const end = generalEnd >= 0 ? generalEnd : lines.length;
    const general = lines.slice(generalStart + 1, end);
    const settingIndex = general.findIndex((line) => /^\s*use-local-host-item-for-proxy\s*=/i.test(line));
    if (settingIndex >= 0) general[settingIndex] = "use-local-host-item-for-proxy = true";
    else general.push("use-local-host-item-for-proxy = true");
    lines.splice(generalStart + 1, end - generalStart - 1, ...general);
  } else {
    lines.unshift("[General]", "use-local-host-item-for-proxy = true", "");
  }

  const hostStart = lines.findIndex((line) => line.trim().toLowerCase() === "[host]");
  const mappingKeys = new Set(entries.map(([host]) => host.toLowerCase()));
  const mappingLines = entries.map(([host, address]) => `${host} = ${address}`);
  if (hostStart < 0) return `${lines.join("\n").trimEnd()}\n\n[Host]\n${mappingLines.join("\n")}\n`;

  const hostEnd = lines.findIndex((line, index) => index > hostStart && /^\s*\[.+\]\s*$/.test(line));
  const end = hostEnd >= 0 ? hostEnd : lines.length;
  const existing = lines.slice(hostStart + 1, end).filter((line) => {
    const separator = line.indexOf("=");
    return separator < 1 || !mappingKeys.has(line.slice(0, separator).trim().toLowerCase());
  });
  lines.splice(hostStart + 1, end - hostStart - 1, ...existing, ...mappingLines);
  return lines.join("\n");
}

function expandShadowrocketIncludeAllGroups(config: string, proxyNames: string[]) {
  const lines = config.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const nextSection = lines.findIndex((line, index) => index > groupStart && /^\s*\[.+\]\s*$/.test(line));
  if (groupStart < 0) return config;

  const allNames = [...new Set(proxyNames.filter(Boolean))];
  const groupNames = lines.slice(groupStart + 1, nextSection > groupStart ? nextSection : undefined)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? line.slice(0, separator).trim() : "";
    })
    .filter(Boolean);
  const groupNameByKey = new Map(groupNames.map((name) => [name.toLowerCase(), name]));
  return lines.map((raw, index) => {
    if (index <= groupStart || (nextSection > groupStart && index >= nextSection)) return raw;
    const separator = raw.indexOf("=");
    if (separator < 1) return raw;

    const left = raw.slice(0, separator).trim();
    const values = raw.slice(separator + 1).split(",").map((item) => item.trim()).filter(Boolean);
    if (!values.some((item) => item.trim().toLowerCase() === "include-all-proxies=true")) return raw;

    const kind = values[0] || "select";
    const regex = findOption(values, "policy-regex-filter");
    let matched = allNames;
    if (regex) {
      try {
        const matcher = new RegExp(regex, "i");
        matched = allNames.filter((name) => matcher.test(name));
      } catch {
        matched = allNames;
      }
    }

    // Shadowrocket does not expand include-all-proxies=true reliably. Write
    // the actual node names into the group so they are visible in every
    // client, while preserving helper policies such as PROXIES and DIRECT.
    const extras = values.slice(1)
      .filter((item) => item.trim().toLowerCase() !== "include-all-proxies=true" && !item.trim().toLowerCase().startsWith("policy-regex-filter="))
      .map((item) => {
        const key = item.toLowerCase();
        // Advanced configs often use PROXIES while the actual helper group is
        // named Proxies. Resolve policy references without case sensitivity.
        if (key === "proxies") return groupNameByKey.get("proxies") || "PROXY";
        return groupNameByKey.get(key) || item;
      });
    const items = [...new Set([...extras, ...matched])];
    return `${left} = ${[kind, ...items].join(",")}`;
  }).join("\n");
}

function normalizeShadowrocketPolicyReferences(config: string, proxyNames: string[]) {
  const lines = config.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  if (groupStart < 0 || ruleStart < 0 || ruleStart <= groupStart) return config;

  const groupNames = lines.slice(groupStart + 1, ruleStart)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? line.slice(0, separator).trim() : "";
    })
    .filter(Boolean);
  const proxyStart = lines.findIndex((line) => line.trim() === "[Proxy]");
  const proxyEnd = lines.findIndex((line, index) => index > proxyStart && /^\s*\[.+\]\s*$/.test(line));
  const actualProxyNames = lines.slice(proxyStart + 1, proxyEnd > proxyStart ? proxyEnd : groupStart)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? line.slice(0, separator).trim() : "";
    })
    .filter(Boolean);
  const aliases = createPolicyAliases(groupNames.map((name) => ({ name, kind: "select", items: [] })), groupNames.find((name) => name.toLowerCase() === "proxies") || "PROXY");
  actualProxyNames.forEach((name) => aliases.set(name.toLowerCase(), name));
  proxyNames.forEach((name) => aliases.set(name.toLowerCase(), name));

  return lines.map((raw, index) => {
    if (index > groupStart && index < ruleStart) {
      const separator = raw.indexOf("=");
      if (separator < 1) return raw;
      const left = raw.slice(0, separator).trim();
      const values = splitRuleLine(raw.slice(separator + 1));
      if (!values.length) return raw;
      const items = values.slice(1).map((item) => {
        const trimmed = item.trim();
        if (!trimmed || trimmed.includes("=") || /^(Traffic|Expire|流量|到期|剩余)\b/i.test(trimmed)) return trimmed;
        return aliases.get(trimmed.toLowerCase()) || trimmed;
      });
      return `${left} = ${[values[0], ...items].join(",")}`;
    }
    if (index > ruleStart) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) return raw;
      const parts = splitRuleLine(raw);
      if (parts[0].toUpperCase() === "FINAL" && parts[1]) {
        parts[1] = aliases.get(parts[1].toLowerCase()) || parts[1];
        return parts.join(",");
      }
      if (parts.length >= 3) {
        parts[2] = aliases.get(parts[2].toLowerCase()) || parts[2];
        return parts.join(",");
      }
    }
    return raw;
  }).join("\n");
}

export function buildShadowrocketConfig(ruleContent: string, airportContent: string | string[], hostMappings: Record<string, string> = {}) {
  const sources = Array.isArray(airportContent) ? airportContent : [airportContent];
  const airportProxies = sources.flatMap((source) => parseAirportProxies(source));
  if (!airportProxies.length) throw new Error("机场配置没有可转换的小火箭节点");
  const lines = ruleContent.split(/\r?\n/);
  const proxyStart = lines.findIndex((line) => line.trim() === "[Proxy]");
  const nextSection = lines.findIndex((line, index) => index > proxyStart && /^\s*\[.+\]\s*$/.test(line));
  const existing = proxyStart >= 0 ? lines.slice(proxyStart + 1, nextSection > proxyStart ? nextSection : undefined).filter((line) => line.trim() && !line.trim().startsWith("#")) : [];
  const names = new Set(existing.map((line) => line.slice(0, line.indexOf("=")).trim()));
  const nameKeys = new Set([...names].map((name) => name.toLowerCase()));
  const generated = airportProxies.map(shadowrocketProxyLine).filter(Boolean).filter((line) => {
    const name = line.slice(0, line.indexOf("=")).trim();
    const nameKey = name.toLowerCase();
    if (nameKeys.has(nameKey)) return false;
    names.add(name);
    nameKeys.add(nameKey);
    return true;
  });
  const proxySection = ["[Proxy]", ...existing, ...generated];
  if (proxyStart < 0) {
    const config = normalizeFinalGroupForShadowrocket(`${proxySection.join("\n")}\n\n${ruleContent.trim()}\n`);
    const expanded = expandShadowrocketIncludeAllGroups(config, [...names]);
    const normalized = normalizeShadowrocketPolicyReferences(expanded, [...names]);
    return normalizeShadowrocketConfig(addShadowrocketHostMappings(addShadowrocketAirportDns(normalized, sources), hostMappings));
  }
  const end = nextSection > proxyStart ? nextSection : lines.length;
  const config = normalizeFinalGroupForShadowrocket([...lines.slice(0, proxyStart), ...proxySection, ...lines.slice(end)].join("\n"));
  const expandedConfig = expandShadowrocketIncludeAllGroups(config, [...names]);
  const normalizedConfig = normalizeShadowrocketPolicyReferences(expandedConfig, [...names]);
  // Shadowrocket does not understand geosite rule references; omit them only from its output.
  const withoutGeosite = normalizedConfig.split(/\r?\n/).filter((line) => !/^\s*(?:RULE-SET|GEOSITE),geosite:/i.test(line)).join("\n");
  return normalizeShadowrocketConfig(addShadowrocketHostMappings(addShadowrocketAirportDns(withoutGeosite, sources), hostMappings));
}

export function buildShadowrocketRulesConfig(ruleContent: string, airportContent: string | string[], hostMappings: Record<string, string> = {}) {
  const fullConfig = buildShadowrocketConfig(ruleContent, airportContent, hostMappings);
  const lines = fullConfig.split(/\r?\n/);
  const proxyStart = lines.findIndex((line) => line.trim().toLowerCase() === "[proxy]");
  if (proxyStart < 0) return fullConfig;
  const proxyEnd = lines.findIndex((line, index) => index > proxyStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = proxyEnd > proxyStart ? proxyEnd : lines.length;
  return [...lines.slice(0, proxyStart), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}
