import { parse as parseYaml } from "yaml";

type ShadowrocketGroup = { name: string; kind: string; items: string[] };
type ShadowrocketRule = { type: string; value: string; policy: string; options: string[] };
type ClashProxy = Record<string, unknown>;
type RuleProvider = { name: string; url: string; format: "text" | "yaml" };

// 快枪手的节点域名会在部分合并场景中被 Fake-IP DNS 接管，导致
// ClashX Meta 对节点测速失败。SS 节点不依赖 TLS SNI，因此可安全使用
// 机场专用 DNS 返回的真实 IP，避免和其他机场的 DNS 互相影响。
const KNOWN_PROXY_HOSTS: Record<string, string> = {
  "kqs-hk.kunlun03dns.com": "15.152.30.113",
  "kqs-tw.kunlun03dns.com": "13.208.248.79",
  "kqs-jp.kunlun03dns.com": "13.208.166.100",
  "kqs-us.kunlun03dns.com": "15.152.31.226",
  "kqs-kr.kunlun03dns.com": "15.152.31.226",
  "kqs-sg.kunlun03dns.com": "13.208.248.79",
};

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
        list("fake-ip-filter").forEach((item) => fakeIpFilter.add(item));
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

export function parseAirportProxies(content: string): ClashProxy[] {
  const shadowrocket = parseShadowrocketProxies(content);
  const clash = shadowrocket.length ? [] : parseClashProxies(content);
  const candidates = shadowrocket.length ? shadowrocket : clash.length ? clash : parseLinkSubscription(content);
  const names = new Set<string>();
  return candidates.filter((proxy) => {
    const name = String(proxy.name || "");
    const server = String(proxy.server || "");
    if (!name || !server || /^(127\.0\.0\.1|localhost)$/i.test(server) || names.has(name) || /^(Traffic|Expire|流量|到期|剩余)\b/i.test(name)) return false;
    names.add(name);
    return true;
  });
}

function stabilizeKnownProxyHosts(proxies: ClashProxy[]) {
  return proxies.map((proxy) => {
    const server = String(proxy.server || "").toLowerCase();
    const address = KNOWN_PROXY_HOSTS[server];
    return address ? { ...proxy, server: address } : proxy;
  });
}

export function getAirportProxyCount(content: string) {
  return parseAirportProxies(content).length;
}

function convertGroups(groups: ShadowrocketGroup[], proxyNames: string[]) {
  const available = new Set(["DIRECT", "REJECT", "PROXY", ...proxyNames, ...groups.map((group) => group.name)]);
  const converted: Record<string, unknown>[] = [{ name: "PROXY", type: "select", proxies: proxyNames.length ? proxyNames : ["DIRECT"] }];
  for (const group of groups) {
    if (group.name.trim().toLowerCase() === "proxies") continue;
    const regex = group.items.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length);
    const includeAll = group.items.includes("include-all-proxies=true");
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
    const proxies = group.items.filter((item) => !item.includes("=") && !/^(Traffic|Expire|流量|到期|剩余)\b/i.test(item) && available.has(item)).map((item) => item === "Proxies" ? "PROXY" : item);
    converted.push({ name: group.name, type: group.kind === "url-test" ? "url-test" : "select", proxies: proxies.length ? proxies : ["DIRECT"] });
  }
  return converted;
}

function convertRules(rules: ShadowrocketRule[]) {
  const converted: string[] = [];
  const providers: RuleProvider[] = [];
  let skipped = 0;

  for (const rule of rules) {
    const policy = rule.policy.trim().toLowerCase() === "proxies" ? "PROXY" : rule.policy;
    if (["USER-AGENT", "URL-REGEX"].includes(rule.type)) { skipped += 1; continue; }
    if (rule.type === "FINAL") { converted.push(`MATCH,${policy}`); continue; }
    if (rule.type === "RULE-SET") {
      if (rule.value.startsWith("geosite:")) converted.push(`GEOSITE,${rule.value.slice(8)},${policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      else if (/^https?:\/\//i.test(rule.value)) {
        const existing = providers.find((item) => item.url === rule.value);
        const provider = existing || { name: `mw_set_${providers.length + 1}`, url: rule.value, format: /\.ya?ml(?:\?|$)/i.test(rule.value) ? "yaml" as const : "text" as const };
        if (!existing) providers.push(provider);
        converted.push(`RULE-SET,${provider.name},${policy}${rule.options.length ? `,${rule.options.join(",")}` : ""}`);
      } else skipped += 1;
      continue;
    }
    converted.push([rule.type, rule.value, policy, ...rule.options].filter(Boolean).join(","));
  }
  return { converted, providers, skipped };
}

export function buildClashConfig(ruleContent: string, airportContent: string | string[]) {
  const sources = Array.isArray(airportContent) ? airportContent : [airportContent];
  const seenProxyNames = new Set<string>();
  const proxies = sources.flatMap((source) => stabilizeKnownProxyHosts(parseAirportProxies(source))).filter((proxy) => {
    const name = String(proxy.name || "");
    if (!name || seenProxyNames.has(name)) return false;
    seenProxyNames.add(name);
    return true;
  });
  if (!proxies.length) throw new Error("机场配置没有可转换的节点");
  const { groups, rules } = parseGroupsAndRules(ruleContent);
  const proxyGroups = convertGroups(groups, proxies.map((proxy) => String(proxy.name)));
  const { converted, providers, skipped } = convertRules(rules);
  const airportDns = readAirportDns(sources);
  const defaultNameserver = airportDns.defaultNameserver.length ? airportDns.defaultNameserver : ["223.5.5.5", "119.29.29.29"];
  // Use only portable resolvers in the merged file. A source-local resolver
  // such as 127.0.0.1:7874 can self-reference the generated config and break
  // every airport when multiple sources are combined.
  const proxyServerNameserver = [...new Set([...airportDns.proxyServerNameserver, ...defaultNameserver])]
    .filter((item) => !/^(?:udp|tcp|tls|https?):\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(item));
  const nameserver = airportDns.nameserver.length ? airportDns.nameserver : ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"];
  const fallback = airportDns.fallback.length ? airportDns.fallback : ["https://223.5.5.5/dns-query", "https://223.6.6.6/dns-query"];
  const nameserverPolicies = new Map<string, string[]>();
  for (const source of sources) {
    const sourceDns = readAirportDns([source]);
    const resolvers = (sourceDns.proxyServerNameserver.length ? sourceDns.proxyServerNameserver : sourceDns.defaultNameserver)
      .filter((item) => !/^(?:udp|tcp|tls|https?):\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(item));
    if (!resolvers.length) continue;
    for (const proxy of parseAirportProxies(source)) {
      const host = String(proxy.server || "").toLowerCase();
      if (!host || /^[0-9a-f:.]+$/i.test(host)) continue;
      const labels = host.split(".").filter(Boolean);
      if (labels.length < 2) continue;
      const suffix = labels.slice(-2).join(".");
      if (!nameserverPolicies.has(suffix)) nameserverPolicies.set(suffix, resolvers);
    }
  }
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
    ...(nameserverPolicies.size ? ["  nameserver-policy:", ...[...nameserverPolicies.entries()].flatMap(([suffix, resolvers]) => [`    ${quote(`+.${suffix}`)}:`, ...resolvers.map((item) => `      - ${quote(item)}`)])] : []),
    "  fake-ip-filter:",
    ...[...new Set(["*.lan", "+.local", "localhost.ptlogin2.qq.com", ...airportDns.fakeIpFilter])].map((item) => `    - ${quote(item)}`),
  ].join("\n");
  return `# MW Rules for ClashX Meta\n# 自动合并机场节点与 GitHub 分流规则；跳过 ${skipped} 条 Clash 不支持的规则\nmixed-port: 7890\nmode: rule\nallow-lan: false\nlog-level: info\nipv6: false\n\n${dnsYaml}\n\nproxies:\n${yamlList(proxies)}\n\nproxy-groups:\n${yamlList(proxyGroups)}${providerYaml}\n\nrules:\n${converted.map((rule) => `  - ${quote(rule)}`).join("\n")}\n`;
}

function shadowrocketProxyLine(proxy: ClashProxy) {
  const name = String(proxy.name || "").replace(/[\r\n=]/g, " ").trim();
  const server = String(proxy.server || "");
  const port = String(proxy.port || "");
  const cipher = String(proxy.cipher || "aes-128-gcm");
  const password = String(proxy.password || "").replace(/[\r\n,]/g, " ");
  if (!name || !server || !port || !password) return "";
  const options = [`encrypt-method=${cipher}`, `password=${password}`, "udp-relay=true"];
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

function expandShadowrocketIncludeAllGroups(config: string, proxyNames: string[]) {
  const lines = config.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const nextSection = lines.findIndex((line, index) => index > groupStart && /^\s*\[.+\]\s*$/.test(line));
  if (groupStart < 0) return config;

  const allNames = [...new Set(proxyNames.filter(Boolean))];
  return lines.map((raw, index) => {
    if (index <= groupStart || (nextSection > groupStart && index >= nextSection)) return raw;
    const separator = raw.indexOf("=");
    if (separator < 1) return raw;

    const left = raw.slice(0, separator).trim();
    const values = raw.slice(separator + 1).split(",").map((item) => item.trim()).filter(Boolean);
    if (!values.includes("include-all-proxies=true")) return raw;

    const kind = values[0] || "select";
    const regex = values.find((item) => item.startsWith("policy-regex-filter="))?.slice("policy-regex-filter=".length);
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
    const extras = values.slice(1).filter((item) => item !== "include-all-proxies=true" && !item.startsWith("policy-regex-filter="));
    const items = [...extras, ...matched.filter((name) => !extras.includes(name))];
    return `${left} = ${[kind, ...items].join(",")}`;
  }).join("\n");
}

export function buildShadowrocketConfig(ruleContent: string, airportContent: string | string[]) {
  const sources = Array.isArray(airportContent) ? airportContent : [airportContent];
  const airportProxies = sources.flatMap((source) => parseAirportProxies(source));
  if (!airportProxies.length) throw new Error("机场配置没有可转换的小火箭节点");
  const lines = ruleContent.split(/\r?\n/);
  const proxyStart = lines.findIndex((line) => line.trim() === "[Proxy]");
  const nextSection = lines.findIndex((line, index) => index > proxyStart && /^\s*\[.+\]\s*$/.test(line));
  const existing = proxyStart >= 0 ? lines.slice(proxyStart + 1, nextSection > proxyStart ? nextSection : undefined).filter((line) => line.trim() && !line.trim().startsWith("#")) : [];
  const names = new Set(existing.map((line) => line.slice(0, line.indexOf("=")).trim()));
  const generated = airportProxies.map(shadowrocketProxyLine).filter(Boolean).filter((line) => {
    const name = line.slice(0, line.indexOf("=")).trim();
    if (names.has(name)) return false;
    names.add(name);
    return true;
  });
  const proxySection = ["[Proxy]", ...existing, ...generated];
  if (proxyStart < 0) {
    const config = `${proxySection.join("\n")}\n\n${ruleContent.trim()}\n`;
    return normalizeShadowrocketConfig(expandShadowrocketIncludeAllGroups(config, [...names]));
  }
  const end = nextSection > proxyStart ? nextSection : lines.length;
  const config = [...lines.slice(0, proxyStart), ...proxySection, ...lines.slice(end)].join("\n");
  const expandedConfig = expandShadowrocketIncludeAllGroups(config, [...names]);
  // Shadowrocket does not understand geosite rule references; omit them only from its output.
  return normalizeShadowrocketConfig(expandedConfig.split(/\r?\n/).filter((line) => !/^\s*(?:RULE-SET|GEOSITE),geosite:/i.test(line)).join("\n"));
}
