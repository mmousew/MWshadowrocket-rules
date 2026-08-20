import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";

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
