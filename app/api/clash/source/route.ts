import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { encryptSourceUrl, parseSourceEntries, decryptSourceUrl, type ClashSourceEntry } from "../../../lib/clash-link";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { createClashLink, getClashProfile, saveSourceSnapshot, updateClashProfileSource } from "../../../lib/clash-links";

function sourceName(entry: ClashSourceEntry, index: number) {
  if (entry.name?.trim()) return entry.name.trim();
  if (entry.kind === "content") return `本地订阅文件 ${index + 1}`;
  try { return new URL(entry.value).hostname; } catch { return `订阅来源 ${index + 1}`; }
}

function publicSources(entries: ClashSourceEntry[]) {
  return entries.map((entry, index) => ({ index, name: sourceName(entry, index), kind: entry.kind, value: entry.kind === "url" ? entry.value : null, hidden: entry.hidden === true, nodes: entry.kind === "content" ? getAirportProxyCount(entry.value) : null }));
}

async function currentState(profileId: string) {
  const profile = await getClashProfile(profileId);
  if (!profile) throw new Error("订阅配置不存在，请刷新页面后重试");
  const entries = profile.encrypted_source ? parseSourceEntries(await decryptSourceUrl(profile.encrypted_source)) : [];
  return { profile, entries };
}

function publicLink(request: NextRequest, item: { id: string; profile_id?: string; name?: string; token?: string; status: string; created_at?: number; revoked_at?: number | null }) {
  const token = item.token || process.env.CLASH_ACCESS_TOKEN || "";
  return { id: item.id, profileId: item.profile_id || "default", name: item.name || "订阅链接", url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`, status: item.status, createdAt: item.created_at || 0, revokedAt: item.revoked_at ?? null, legacy: item.id === "legacy" };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const profileId = request.nextUrl.searchParams.get("profileId") || "default";
    const { entries } = await currentState(profileId);
    return NextResponse.json({ profileId, sources: publicSources(entries) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取机场来源失败" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let profileId = "default";
    let sourceUrl = "";
    let file: File | null = null;
    let action = "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      profileId = String(form.get("profileId") || "default").trim();
      sourceUrl = String(form.get("sourceUrl") || "").trim();
      const value = form.get("sourceFile");
      file = value instanceof File ? value : null;
    } else {
      const body = await request.json() as { profileId?: string; sourceUrl?: string; action?: string };
      profileId = String(body.profileId || "default").trim();
      sourceUrl = String(body.sourceUrl || "").trim();
      action = String(body.action || "");
    }
    const { profile, entries } = await currentState(profileId);
    if (action === "refresh") {
      const onlineEntries = entries.filter((entry): entry is Extract<ClashSourceEntry, { kind: "url" }> => entry.kind === "url" && entry.hidden !== true);
      const results = await Promise.allSettled(onlineEntries.map(async (entry) => {
        const fetched = await fetchAirportSubscription(entry.value);
        await saveSourceSnapshot(entry.value, fetched.content, fetched.nodeCount);
        return fetched.nodeCount;
      }));
      const successful = results.filter((result) => result.status === "fulfilled");
      if (!successful.length && !entries.some((entry) => entry.kind === "content" && entry.hidden !== true)) {
        throw new Error("机场暂时无法读取，未更新当前配置。请稍后重试或上传 YAML 文件。");
      }
      await updateClashProfileSource(profileId, await encryptSourceUrl(entries));
      return NextResponse.json({ profileId, sources: publicSources(entries), refreshed: successful.length });
    }
    if (action === "new-link") {
      if (!entries.some((entry) => entry.hidden !== true)) throw new Error("请先保留至少一个可用订阅来源");
      const created = await createClashLink(await encryptSourceUrl(entries), `${profile.name} · ${new Date().toLocaleDateString("zh-CN")}`, profileId);
      return NextResponse.json({ profileId, sources: publicSources(entries), link: publicLink(request, { id: created.id, profile_id: profileId, name: created.name, token: created.token, status: created.status, created_at: created.createdAt }) });
    }
    if (!sourceUrl && !file) throw new Error("请输入订阅地址或选择 YAML 文件");
    let added: ClashSourceEntry;
    if (file) {
      if (file.size > 900_000) throw new Error("文件过大，请先下载较小的 Clash YAML 文件");
      const content = await file.text();
      if (!getAirportProxyCount(content)) throw new Error("文件没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置");
      added = { kind: "content", value: content, name: file.name || "本地订阅文件" };
    } else {
      const fetched = await fetchAirportSubscription(sourceUrl);
      await saveSourceSnapshot(sourceUrl, fetched.content, fetched.nodeCount);
      added = { kind: "url", value: sourceUrl };
    }
    if (entries.some((entry) => entry.kind === added.kind && (entry.kind === "url" ? entry.value === added.value : entry.name === added.name))) throw new Error("这个订阅来源已经添加过了");
    const nextEntries = [...entries, added];
    await updateClashProfileSource(profileId, await encryptSourceUrl(nextEntries));
    return NextResponse.json({ profileId, sources: publicSources(nextEntries), added: sourceName(added, nextEntries.length - 1) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新订阅来源失败" }, { status: 422 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { profileId?: string; index?: number };
    const profileId = String(body.profileId || "default").trim();
    const index = Number(body.index);
    const { entries } = await currentState(profileId);
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("订阅来源不存在");
    if (entries.length <= 1) throw new Error("至少保留一个订阅来源");
    const nextEntries = entries.filter((_, entryIndex) => entryIndex !== index);
    await updateClashProfileSource(profileId, await encryptSourceUrl(nextEntries));
    return NextResponse.json({ profileId, sources: publicSources(nextEntries) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除订阅来源失败" }, { status: 422 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { profileId?: string; index?: number; hidden?: boolean; name?: string; value?: string };
    const profileId = String(body.profileId || "default").trim();
    const index = Number(body.index);
    const { entries } = await currentState(profileId);
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("订阅来源不存在");
    const current = entries[index];
    const hidden = typeof body.hidden === "boolean" ? body.hidden : current.hidden === true;
    if (hidden && !current.hidden && entries.filter((entry) => !entry.hidden).length <= 1) throw new Error("至少保留一个可用来源");
    let replacement: ClashSourceEntry = current;
    if (typeof body.value === "string" && current.kind === "url") {
      const nextValue = body.value.trim();
      if (!nextValue) throw new Error("请输入新的机场订阅地址");
      const fetched = await fetchAirportSubscription(nextValue);
      await saveSourceSnapshot(nextValue, fetched.content, fetched.nodeCount);
      replacement = { ...current, value: nextValue };
    }
    const nextEntries = entries.map((entry, entryIndex) => entryIndex === index ? { ...replacement, ...(typeof body.name === "string" ? { name: body.name.trim().slice(0, 80) || undefined } : {}), hidden } : entry);
    if (hidden) {
      const visibleEntries = nextEntries.filter((entry) => !entry.hidden);
      const inlineCount = visibleEntries.filter((entry) => entry.kind === "content").length;
      const urlEntries = visibleEntries.filter((entry): entry is Extract<ClashSourceEntry, { kind: "url" }> => entry.kind === "url");
      const checks = await Promise.allSettled(urlEntries.map((entry) => fetchAirportSubscription(entry.value)));
      if (!inlineCount && !checks.some((check) => check.status === "fulfilled")) throw new Error("隐藏后剩余来源无法读取，请先确认其他订阅可用或上传 YAML 文件");
    }
    await updateClashProfileSource(profileId, await encryptSourceUrl(nextEntries));
    return NextResponse.json({ profileId, sources: publicSources(nextEntries) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新订阅来源失败" }, { status: 422 });
  }
}
