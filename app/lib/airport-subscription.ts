import { getAirportProxyCount, parseAirportProxies } from "./clash-config";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function validateAirportUrl(value: string) {
  if (!value || value.length > 4096) throw new Error("请输入有效的机场订阅地址");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("机场订阅地址格式不正确"); }
  const hostname = url.hostname.toLowerCase();
  const relayConfigured = Boolean(process.env.AIRPORT_RELAY_URL && process.env.AIRPORT_RELAY_SECRET);
  if (url.protocol !== "https:" && !(relayConfigured && url.protocol === "http:")) throw new Error("为了安全，只支持 HTTPS 订阅地址");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIpv4(hostname) || hostname === "::1") {
    throw new Error("不能使用本机或局域网地址");
  }
  return url.toString();
}

export type SubscriptionClient = "clash" | "shadowrocket";

async function downloadSubscription(url: string, client: SubscriptionClient = "clash") {
  const relayUrl = process.env.AIRPORT_RELAY_URL;
  const relaySecret = process.env.AIRPORT_RELAY_SECRET;
  const remoteHostIsIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(new URL(url).hostname);
  async function fetchViaRelay() {
    const relayResponse = await fetch(relayUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MW-Relay-Secret": relaySecret! },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });
    if (!relayResponse.ok) throw new Error(`机场订阅读取失败（${relayResponse.status}）`);
    return relayResponse.text();
  }
  // Public HTTPS subscriptions on a bare IP often use a certificate issued
  // for a hostname. The client can still read them, but a Worker fetch may
  // reject the certificate before the airport can return its native format.
  // Use the existing controlled relay for Shadowrocket IP sources only; Clash
  // keeps its original direct-fetch path and DNS handling.
  if (relayUrl && relaySecret && (new URL(url).protocol === "http:" || client === "shadowrocket" && remoteHostIsIp)) return fetchViaRelay();
  const clientHeaders = client === "shadowrocket"
    ? { "User-Agent": "Shadowrocket", Accept: "text/plain,text/yaml,application/yaml,*/*" }
    : { "User-Agent": "clash.meta", Accept: "text/yaml,text/plain,application/yaml,*/*" };
  const requestHeaders = [
    clientHeaders,
    { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36", Accept: "*/*" },
  ];
  let response: Response | undefined;
  for (const headers of requestHeaders) {
    response = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
    if (response.ok || response.status !== 403) break;
  }
  if (response && !response.ok && relayUrl && relaySecret && [401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)) {
    try { return await fetchViaRelay(); } catch { /* report original status below */ }
  }
  if (!response) throw new Error("机场订阅读取失败");
  if (!response.ok) throw new Error(`机场订阅读取失败（${response.status}）`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 2_000_000) throw new Error("机场订阅内容过大");
  return response.text();
}

async function expandProxyProviders(content: string, client: SubscriptionClient = "clash") {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = parseYaml(content) as Record<string, unknown> | null; } catch { return content; }
  const providers = parsed?.["proxy-providers"];
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return content;
  const providerUrls = Object.values(providers as Record<string, unknown>)
    .map((provider) => provider && typeof provider === "object" ? (provider as Record<string, unknown>).url : null)
    .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url));
  if (!providerUrls.length) return content;
  const providerContents = await Promise.all(providerUrls.map(async (url) => downloadSubscription(validateAirportUrl(url), client)));
  const proxies = providerContents.flatMap((providerContent) => parseAirportProxies(providerContent));
  if (!proxies.length) return content;
  return stringifyYaml({ ...parsed, proxies });
}

export async function fetchAirportSubscription(sourceUrl: string, client: SubscriptionClient = "clash") {
  const safeUrl = validateAirportUrl(sourceUrl);
  const content = await downloadSubscription(safeUrl, client);
  if (content.length > 2_000_000) throw new Error("机场订阅内容过大");
  const expandedContent = await expandProxyProviders(content, client);
  const nodeCount = getAirportProxyCount(expandedContent);
  if (!nodeCount) throw new Error("没有识别到节点，请确认该地址支持 Clash 或 Shadowrocket 格式");
  return { content: expandedContent, nodeCount };
}
