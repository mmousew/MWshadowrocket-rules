import { NextRequest, NextResponse } from "next/server";
import { buildClashConfig, buildShadowrocketConfig } from "../../../lib/clash-config";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { decryptSourceUrl } from "../../../lib/clash-link";
import { findClashLink } from "../../../lib/clash-links";

const OWNER = "mmousew";
const REPO = "MWshadowrocket-rules";
const BRANCH = "rules/initial-region-module";
const FILE_PATH = "MW-Shadowrocket-Config.conf";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

type GitHubFile = { content?: string; message?: string };

function getAirportSnapshot() {
  let encoded = "";
  for (let index = 1; index <= 10; index += 1) encoded += process.env[`AIRPORT_PROXY_SNAPSHOT_${index}`] || "";
  return encoded ? `[Proxy]\n${Buffer.from(encoded, "base64").toString("utf8")}\n` : "";
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const expectedToken = process.env.CLASH_ACCESS_TOKEN;
  const querySource = request.nextUrl.searchParams.get("source");
  let encryptedSource = querySource;
  let managedLink = false;
  try {
    const record = await findClashLink(token);
    if (record) {
      managedLink = true;
      if (record.status !== "active") return new NextResponse("订阅链接已失效", { status: 404 });
      encryptedSource = record.encrypted_source || null;
    }
  } catch {
    // D1 不可用时保留旧版环境变量链接的兼容路径。
  }
  if (!managedLink && (!expectedToken || token !== expectedToken)) return new NextResponse("订阅链接无效", { status: 404 });

  try {
    const encryptedValue = encryptedSource ? await decryptSourceUrl(encryptedSource) : process.env.AIRPORT_SHADOWROCKET_URL || "";
    let airportUrls: string[] = [];
    let inlineContent: string[] = [];
    try {
      const parsed = JSON.parse(encryptedValue);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") airportUrls.push(item);
          else if (item?.kind === "url" && typeof item.value === "string") airportUrls.push(item.value);
          else if (item?.kind === "content" && typeof item.value === "string") inlineContent.push(item.value);
        }
      } else airportUrls = [encryptedValue];
    } catch {
      airportUrls = [encryptedValue];
    }
    airportUrls = airportUrls.map((url) => url.trim()).filter(Boolean);
    if (!airportUrls.length) return new NextResponse("尚未配置机场来源", { status: 503 });
    const [ruleResponse, airportResult] = await Promise.all([
      fetch(`${API_URL}?ref=${encodeURIComponent(BRANCH)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mw-clash-subscription",
          ...(process.env.GITHUB_RULES_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_RULES_TOKEN}` } : {}),
        },
        cache: "no-store",
      }),
      Promise.allSettled(airportUrls.map((url) => fetchAirportSubscription(url)))
        .then((results) => ({ ok: results.some((result) => result.status === "fulfilled"), content: [...inlineContent, ...results.flatMap((result) => result.status === "fulfilled" ? [result.value.content] : [])] })),
    ]);
    if (!ruleResponse.ok) throw new Error(`读取 GitHub 规则失败（${ruleResponse.status}）`);
    const file = await ruleResponse.json() as GitHubFile;
    if (!file.content) throw new Error(file.message || "GitHub 规则内容为空");
    const ruleContent = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    const liveAirportContent = airportResult.content;
    const airportContent = liveAirportContent.length ? liveAirportContent : (encryptedSource ? [] : [getAirportSnapshot()]);
    if (!airportContent.length || !airportContent[0]) throw new Error("机场在线地址暂时不可用，且没有安全节点快照");
    const userAgent = request.headers.get("user-agent") || "";
    const shadowrocket = request.nextUrl.searchParams.get("format") === "shadowrocket" || /shadowrocket/i.test(userAgent);
    const config = shadowrocket ? buildShadowrocketConfig(ruleContent, airportContent) : buildClashConfig(ruleContent, airportContent);
    return new NextResponse(config, {
      headers: {
        "Content-Type": shadowrocket ? "text/plain; charset=utf-8" : "text/yaml; charset=utf-8",
        "Content-Disposition": `inline; filename=${shadowrocket ? "MW-Shadowrocket.conf" : "MW-ClashX-Meta.yaml"}`,
        // Always return the newest airport/rules merge after a client update.
        // Caching the generated profile can make one airport appear broken after
        // another source has just been fixed.
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Profile-Update-Interval": "6",
        "X-MW-Node-Source": liveAirportContent ? "live" : "secure-snapshot",
      },
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "生成 Clash 配置失败", { status: 502 });
  }
}
