import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { encryptSourceUrl } from "../../../lib/clash-link";

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const token = process.env.CLASH_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "尚未生成 Clash 私有订阅" }, { status: 503 });
  return NextResponse.json({
    url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`,
    client: "ClashX Meta",
    updateHours: 6,
  });
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const token = process.env.CLASH_ACCESS_TOKEN;
  if (!token) return NextResponse.json({ error: "尚未配置 Clash 私有订阅" }, { status: 503 });
  try {
    const body = await request.json() as { sourceUrl?: string };
    const sourceUrl = body.sourceUrl?.trim() || "";
    const { nodeCount } = await fetchAirportSubscription(sourceUrl);
    const encryptedSource = await encryptSourceUrl(sourceUrl);
    return NextResponse.json({
      url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}?source=${encodeURIComponent(encryptedSource)}`,
      nodeCount,
      updateHours: 6,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成订阅失败" }, { status: 422 });
  }
}
