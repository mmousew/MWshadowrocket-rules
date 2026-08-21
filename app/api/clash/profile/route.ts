import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { encryptSourceUrl, parseSourceEntries, type ClashSourceEntry } from "../../../lib/clash-link";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { createClashProfile, getClashProfile, getSourceSnapshot, listClashProfiles, renameClashProfile } from "../../../lib/clash-links";

function sourceName(entry: ClashSourceEntry, index: number) {
  if (entry.name?.trim()) return entry.name.trim();
  if (entry.kind === "content") return `本地订阅文件 ${index + 1}`;
  try { return new URL(entry.value).hostname; } catch { return `订阅来源 ${index + 1}`; }
}

async function publicSources(value: string) {
  const entries = value ? parseSourceEntries(value) : [];
  return Promise.all(entries.map(async (entry, index) => ({ index, name: sourceName(entry, index), kind: entry.kind, value: entry.kind === "url" ? entry.value : null, hidden: entry.hidden === true, nodes: entry.kind === "content" ? getAirportProxyCount(entry.value) : (await getSourceSnapshot(entry.value))?.node_count ?? null })));
}

async function publicProfile(profile: { id: string; name: string; encrypted_source: string; status: string; created_at: number; updated_at: number }) {
  const sources = await publicSources(profile.encrypted_source);
  const nodeCount = sources.every((item) => item.nodes !== null) ? sources.reduce((total, item) => total + (item.nodes || 0), 0) : null;
  return { id: profile.id, name: profile.name || "订阅配置", sourceCount: sources.length, nodeCount, updatedAt: profile.updated_at, sources };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const profiles = await listClashProfiles();
    return NextResponse.json({ profiles: await Promise.all(profiles.map(publicProfile)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取订阅配置失败" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let name = "订阅配置";
    let sourceUrls: string[] = [];
    const uploaded: Array<{ name: string; content: string }> = [];
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      name = String(form.get("name") || "订阅配置").trim();
      sourceUrls = String(form.get("sourceUrls") || "").split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
      for (const value of form.getAll("sourceFiles")) {
        if (!(value instanceof File)) continue;
        if (value.size > 900_000) throw new Error(`文件「${value.name}」过大，请先在本地转换成较小的 Clash YAML 文件`);
        const content = await value.text();
        if (!getAirportProxyCount(content)) throw new Error(`文件「${value.name}」没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置`);
        uploaded.push({ name: value.name || "本地订阅文件", content });
      }
    } else {
      const body = await request.json() as { name?: string; sourceUrls?: string[]; sourceUrl?: string };
      name = String(body.name || "订阅配置").trim();
      sourceUrls = (body.sourceUrls || body.sourceUrl?.split(/\r?\n/) || []).map((url) => url.trim()).filter(Boolean);
    }
    if (!sourceUrls.length && !uploaded.length) throw new Error("请填写订阅地址或选择 YAML 文件");
    const settled = await Promise.allSettled(sourceUrls.map((url) => fetchAirportSubscription(url)));
    const successful = settled.flatMap((item, index) => item.status === "fulfilled" ? [{ kind: "url" as const, value: sourceUrls[index] }] : []);
    const failed = settled.flatMap((item, index) => item.status === "rejected" ? [{ host: (() => { try { return new URL(sourceUrls[index]).hostname; } catch { return "地址格式错误"; } })(), reason: item.reason instanceof Error ? item.reason.message : "读取失败" }] : []);
    if (!successful.length && !uploaded.length) throw new Error(failed.map((item) => `${item.host}：${item.reason}`).join("；") || "所有机场订阅都读取失败");
    const entries: ClashSourceEntry[] = [...successful, ...uploaded.map((item) => ({ kind: "content" as const, value: item.content, name: item.name }))];
    const profile = await createClashProfile(name, await encryptSourceUrl(entries));
    return NextResponse.json({ profile: await publicProfile(profile), warning: failed.length ? `以下订阅读取失败：${failed.map((item) => `${item.host}（${item.reason}）`).join("、")}；其余来源已保存。` : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "新增订阅配置失败" }, { status: 422 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string; name?: string };
    const id = String(body.id || "").trim();
    if (!id) throw new Error("订阅配置不存在");
    const profile = await getClashProfile(id);
    if (!profile) throw new Error("订阅配置不存在");
    await renameClashProfile(id, typeof body.name === "string" ? body.name : profile.name);
    const updated = await getClashProfile(id);
    return NextResponse.json({ profile: updated ? await publicProfile(updated) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存订阅配置名称失败" }, { status: 422 });
  }
}
