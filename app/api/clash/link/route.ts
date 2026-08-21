import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { encryptSourceUrl } from "../../../lib/clash-link";
import { createClashLink, hashToken, listClashLinks, syncActiveClashSources } from "../../../lib/clash-links";
import { getRawDb } from "../../../../db";

function publicLink(request: NextRequest, item: { id: string; name?: string; token?: string; status: string; createdAt: number; revokedAt?: number | null }) {
  const token = item.token || process.env.CLASH_ACCESS_TOKEN || "";
  return { id: item.id, name: item.name || "订阅链接", url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`, status: item.status, createdAt: item.createdAt, revokedAt: item.revokedAt ?? null, legacy: item.id === "legacy" };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const token = process.env.CLASH_ACCESS_TOKEN;
  try {
    if (token) {
      const db = getRawDb();
      const existing = await db.prepare("SELECT id FROM clash_links WHERE id = 'legacy' LIMIT 1").first();
      if (!existing) await db.prepare("INSERT INTO clash_links (id, name, token, token_hash, encrypted_source, status, created_at) VALUES ('legacy', '旧版订阅链接', ?, ?, '', 'active', ?)").bind(token, await hashToken(token), Date.now()).run();
    }
    const rows = await listClashLinks();
    return NextResponse.json({ links: rows.map((row) => publicLink(request, { id: row.id, name: row.name, token: row.token, status: row.status, createdAt: row.created_at, revokedAt: row.revoked_at })), client: "ClashX Meta", updateHours: 6 });
  } catch {
    if (!token) return NextResponse.json({ error: "尚未生成 Clash 私有订阅" }, { status: 503 });
    return NextResponse.json({ links: [publicLink(request, { id: "legacy", name: "旧版订阅链接", status: "active", createdAt: 0 })], client: "ClashX Meta", updateHours: 6 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { sourceUrl?: string; sourceUrls?: string[] };
    const sourceUrls = (body.sourceUrls || body.sourceUrl?.split(/\r?\n/) || []).map((url) => url.trim()).filter(Boolean);
    if (!sourceUrls.length) throw new Error("请至少输入一个机场订阅地址");
    const settled = await Promise.allSettled(sourceUrls.map((url) => fetchAirportSubscription(url)));
    const successful = settled.flatMap((item, index) => item.status === "fulfilled" ? [{ url: sourceUrls[index], result: item.value }] : []);
    const failed = settled.flatMap((item, index) => item.status === "rejected" ? [{ index: index + 1, reason: item.reason instanceof Error ? item.reason.message : "读取失败" }] : []);
    if (!successful.length) {
      const detail = failed.map((item) => `第${item.index}个地址：${item.reason}`).join("；");
      throw new Error(detail || "所有机场订阅都读取失败");
    }
    const results = successful.map((item) => item.result);
    const nodeCount = results.reduce((total, result) => total + result.nodeCount, 0);
    const encryptedSource = await encryptSourceUrl(successful.map((item) => item.url));
    await syncActiveClashSources(encryptedSource);
    const created = await createClashLink(encryptedSource, `订阅链接 ${new Date().toLocaleDateString("zh-CN")}`);
    return NextResponse.json({
      link: publicLink(request, created),
      nodeCount,
      sourceCount: sourceUrls.length,
      successCount: successful.length,
      warning: failed.length ? `已跳过 ${failed.length} 个读取失败的订阅，其余订阅已正常合并。` : null,
      updateHours: 6,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成订阅失败" }, { status: 422 });
  }
}
