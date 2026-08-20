import { NextRequest, NextResponse } from "next/server";
import { buildClashConfig } from "../../../lib/clash-config";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { decryptSourceUrl } from "../../../lib/clash-link";

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
  const encryptedSource = request.nextUrl.searchParams.get("source");
  if (!expectedToken || token !== expectedToken) return new NextResponse("订阅链接无效", { status: 404 });

  try {
    const airportUrl = encryptedSource ? await decryptSourceUrl(encryptedSource) : process.env.AIRPORT_SHADOWROCKET_URL;
    if (!airportUrl) return new NextResponse("尚未配置机场来源", { status: 503 });
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
      fetchAirportSubscription(airportUrl)
        .then(({ content }) => ({ ok: true, content }))
        .catch(() => ({ ok: false, content: "" })),
    ]);
    if (!ruleResponse.ok) throw new Error(`读取 GitHub 规则失败（${ruleResponse.status}）`);
    const file = await ruleResponse.json() as GitHubFile;
    if (!file.content) throw new Error(file.message || "GitHub 规则内容为空");
    const ruleContent = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    const liveAirportContent = airportResult.ok ? airportResult.content : "";
    const airportContent = liveAirportContent || (encryptedSource ? "" : getAirportSnapshot());
    if (!airportContent) throw new Error("机场在线地址暂时不可用，且没有安全节点快照");
    const clash = buildClashConfig(ruleContent, airportContent);
    return new NextResponse(clash, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": "inline; filename=MW-ClashX-Meta.yaml",
        "Cache-Control": "no-store, max-age=0",
        "Profile-Update-Interval": "6",
        "X-MW-Node-Source": liveAirportContent ? "live" : "secure-snapshot",
      },
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "生成 Clash 配置失败", { status: 502 });
  }
}
