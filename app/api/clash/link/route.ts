import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { encryptSourceUrl, type ClashSourceEntry } from "../../../lib/clash-link";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { createClashLink, getClashProfile, hashToken, listClashLinks, updateClashProfileSource } from "../../../lib/clash-links";
import { getReadyRawDb } from "../../../../db";

function publicLink(request: NextRequest, item: { id: string; profileId?: string; profile_id?: string; name?: string; token?: string; status: string; createdAt: number; revokedAt?: number | null }) {
  const token = item.token || process.env.CLASH_ACCESS_TOKEN || "";
  return { id: item.id, profileId: item.profileId || item.profile_id || "default", name: item.name || "订阅链接", url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`, status: item.status, createdAt: item.createdAt, revokedAt: item.revokedAt ?? null, legacy: item.id === "legacy" };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const token = process.env.CLASH_ACCESS_TOKEN;
  try {
    if (token) {
      const db = await getReadyRawDb();
      const existing = await db.prepare("SELECT id FROM clash_links WHERE id = 'legacy' LIMIT 1").first();
      if (!existing) await db.prepare("INSERT INTO clash_links (id, name, token, token_hash, encrypted_source, status, created_at) VALUES ('legacy', '旧版订阅链接', ?, ?, '', 'active', ?)").bind(token, await hashToken(token), Date.now()).run();
    }
    const rows = await listClashLinks();
    return NextResponse.json({ links: rows.map((row) => publicLink(request, { id: row.id, profile_id: row.profile_id, name: row.name, token: row.token, status: row.status, createdAt: row.created_at, revokedAt: row.revoked_at })), client: "ClashX Meta", updateHours: 6 });
  } catch {
    if (!token) return NextResponse.json({ error: "尚未生成 Clash 私有订阅" }, { status: 503 });
    return NextResponse.json({ links: [publicLink(request, { id: "legacy", name: "旧版订阅链接", status: "active", createdAt: 0 })], client: "ClashX Meta", updateHours: 6 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let sourceUrls: string[] = [];
    const uploaded: Array<{ name: string; content: string }> = [];
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      sourceUrls = String(form.get("sourceUrls") || "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
      for (const value of form.getAll("airportFiles")) {
        if (!(value instanceof File)) continue;
        if (value.size > 900_000) throw new Error(`文件「${value.name}」过大，请先在本地转换成较小的 Clash YAML 文件`);
        const content = await value.text();
        if (!getAirportProxyCount(content)) throw new Error(`文件「${value.name}」没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置`);
        uploaded.push({ name: value.name || "本地订阅文件", content });
      }
    } else {
      const body = await request.json() as { sourceUrl?: string; sourceUrls?: string[] };
      sourceUrls = (body.sourceUrls || body.sourceUrl?.split(/\r?\n/) || []).map((url) => url.trim()).filter(Boolean);
    }
    if (!sourceUrls.length && !uploaded.length) throw new Error("请填写机场地址或选择本地订阅文件");
    const settled = await Promise.allSettled(sourceUrls.map((url) => fetchAirportSubscription(url)));
    const successful = settled.flatMap((item, index) => item.status === "fulfilled" ? [{ entry: { kind: "url" as const, value: sourceUrls[index] }, result: item.value }] : []);
    const failed = settled.flatMap((item, index) => item.status === "rejected" ? [{ index: index + 1, host: (() => { try { return new URL(sourceUrls[index]).hostname; } catch { return "地址格式错误"; } })(), reason: item.reason instanceof Error ? item.reason.message : "读取失败" }] : []);
    const entries: ClashSourceEntry[] = [...successful.map((item) => item.entry), ...uploaded.map((item) => ({ kind: "content" as const, value: item.content, name: item.name }))];
    if (!successful.length) {
      if (!uploaded.length) {
        const detail = failed.map((item) => `第${item.index}个（${item.host}）：${item.reason}`).join("；");
        throw new Error(detail || "所有机场订阅都读取失败");
      }
    }
    const nodeCount = successful.reduce((total, item) => total + item.result.nodeCount, 0) + uploaded.reduce((total, item) => total + getAirportProxyCount(item.content), 0);
    const encryptedSource = await encryptSourceUrl(entries);
    const defaultProfile = await getClashProfile("default");
    if (defaultProfile) await updateClashProfileSource("default", encryptedSource);
    const created = await createClashLink(encryptedSource, `花云400G · ${new Date().toLocaleDateString("zh-CN")}`, "default");
    return NextResponse.json({
      link: publicLink(request, created),
      nodeCount,
      sourceCount: sourceUrls.length + uploaded.length,
      successCount: successful.length + uploaded.length,
      warning: failed.length ? `以下订阅读取失败：${failed.map((item) => `第${item.index}个（${item.host}，${item.reason}）`).join("、")}；本地文件和其余订阅已正常合并。` : null,
      updateHours: 6,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成订阅失败" }, { status: 422 });
  }
}
