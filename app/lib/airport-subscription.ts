import { getAirportProxyCount } from "./clash-config";

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
  if (url.protocol !== "https:") throw new Error("为了安全，只支持 HTTPS 订阅地址");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIpv4(hostname) || hostname === "::1") {
    throw new Error("不能使用本机或局域网地址");
  }
  return url.toString();
}

export async function fetchAirportSubscription(sourceUrl: string) {
  const safeUrl = validateAirportUrl(sourceUrl);
  const response = await fetch(safeUrl, {
    headers: { "User-Agent": "clash.meta", Accept: "text/yaml,text/plain,application/yaml,*/*" },
    cache: "no-store",
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`机场订阅读取失败（${response.status}）`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 2_000_000) throw new Error("机场订阅内容过大");
  const content = await response.text();
  if (content.length > 2_000_000) throw new Error("机场订阅内容过大");
  const nodeCount = getAirportProxyCount(content);
  if (!nodeCount) throw new Error("没有识别到节点，请确认该地址支持 Clash 或 Shadowrocket 格式");
  return { content, nodeCount };
}
