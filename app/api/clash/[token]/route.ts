import { NextRequest, NextResponse } from "next/server";
import { buildClashConfig } from "../../../lib/clash-config";

const OWNER = "mmousew";
const REPO = "MWshadowrocket-rules";
const BRANCH = "rules/initial-region-module";
const FILE_PATH = "MW-Shadowrocket-Config.conf";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

type GitHubFile = { content?: string; message?: string };

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const expectedToken = process.env.CLASH_ACCESS_TOKEN;
  const airportUrl = process.env.AIRPORT_SHADOWROCKET_URL;
  if (!expectedToken || token !== expectedToken) return new NextResponse("订阅链接无效", { status: 404 });
  if (!airportUrl) return new NextResponse("尚未配置机场来源", { status: 503 });

  try {
    const [ruleResponse, airportResponse] = await Promise.all([
      fetch(`${API_URL}?ref=${encodeURIComponent(BRANCH)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mw-clash-subscription",
          ...(process.env.GITHUB_RULES_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_RULES_TOKEN}` } : {}),
        },
        cache: "no-store",
      }),
      fetch(airportUrl, { headers: { "User-Agent": "Shadowrocket/2610 CFNetwork/3826.500.131 Darwin/24.5.0" }, cache: "no-store" }),
    ]);
    if (!ruleResponse.ok) throw new Error(`读取 GitHub 规则失败（${ruleResponse.status}）`);
    if (!airportResponse.ok) throw new Error(`读取机场节点失败（${airportResponse.status}）`);
    const file = await ruleResponse.json() as GitHubFile;
    if (!file.content) throw new Error(file.message || "GitHub 规则内容为空");
    const ruleContent = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    const airportContent = await airportResponse.text();
    const clash = buildClashConfig(ruleContent, airportContent);
    return new NextResponse(clash, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": "inline; filename=MW-ClashX-Meta.yaml",
        "Cache-Control": "no-store, max-age=0",
        "Profile-Update-Interval": "6",
      },
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "生成 Clash 配置失败", { status: 502 });
  }
}
