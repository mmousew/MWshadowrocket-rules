import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { encryptSourceUrl, parseSourceEntries, decryptSourceUrl, type ClashSourceEntry } from "../../../lib/clash-link";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { createClashLink, listClashLinks, syncActiveClashSources } from "../../../lib/clash-links";

function sourceName(entry: ClashSourceEntry, index: number) {
  if (entry.kind === "content") return entry.name || `本地订阅文件 ${index + 1}`;
  try { return new URL(entry.value).hostname; } catch { return `订阅来源 ${index + 1}`; }
}

function publicSources(entries: ClashSourceEntry[]) {
  return entries.map((entry, index) => ({ index, name: sourceName(entry, index), kind: entry.kind, hidden: entry.hidden === true, nodes: entry.kind === "content" ? getAirportProxyCount(entry.value) : null }));
}

async function currentState() {
  const rows = await listClashLinks();
  const active = rows.find((row) => row.status === "active");
  const entries = active?.encrypted_source ? parseSourceEntries(await decryptSourceUrl(active.encrypted_source)) : [];
  return { active, entries };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try { return NextResponse.json({ sources: publicSources((await currentState()).entries) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "读取机场来源失败" }, { status: 422 }); }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let sourceUrl = "";
    let file: File | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      sourceUrl = String(form.get("sourceUrl") || "").trim();
      const value = form.get("sourceFile");
      file = value instanceof File ? value : null;
    } else {
      const body = await request.json() as { sourceUrl?: string; action?: string };
      if (body.action === "new-link") {
        const { entries } = await currentState();
        if (!entries.length) throw new Error("请先添加至少一个机场来源");
        const created = await createClashLink(await encryptSourceUrl(entries), `订阅链接 ${new Date().toLocaleDateString("zh-CN")}`);
        const token = created.token || process.env.CLASH_ACCESS_TOKEN || "";
        const link = { id: created.id, name: created.name || "订阅链接", url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`, status: created.status, createdAt: created.createdAt, revokedAt: created.revokedAt ?? null, legacy: false };
        return NextResponse.json({ sources: publicSources(entries), link });
      }
      sourceUrl = String(body.sourceUrl || "").trim();
    }
    if (!sourceUrl && !file) throw new Error("请输入订阅地址或选择 YAML 文件");
    const { active, entries } = await currentState();
    let added: ClashSourceEntry;
    if (file) {
      if (file.size > 900_000) throw new Error("文件过大，请先下载较小的 Clash YAML 文件");
      const content = await file.text();
      if (!getAirportProxyCount(content)) throw new Error("文件没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置");
      added = { kind: "content", value: content, name: file.name || "本地订阅文件" };
    } else {
      await fetchAirportSubscription(sourceUrl);
      added = { kind: "url", value: sourceUrl };
    }
    if (entries.some((entry) => entry.kind === added.kind && (entry.kind === "url" ? entry.value === added.value : entry.name === added.name))) throw new Error("这个订阅来源已经添加过了");
    entries.push(added);
    const encryptedSource = await encryptSourceUrl(entries);
    if (active) {
      await syncActiveClashSources(encryptedSource);
      return NextResponse.json({ sources: publicSources(entries), added: sourceName(added, entries.length - 1) });
    }
    const created = await createClashLink(encryptedSource, `订阅链接 ${new Date().toLocaleDateString("zh-CN")}`);
    const token = created.token || process.env.CLASH_ACCESS_TOKEN || "";
    const link = { id: created.id, name: created.name || "订阅链接", url: `${new URL(request.url).origin}/api/clash/${encodeURIComponent(token)}`, status: created.status, createdAt: created.createdAt, revokedAt: created.revokedAt ?? null, legacy: false };
    return NextResponse.json({ sources: publicSources(entries), added: sourceName(added, entries.length - 1), link });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "添加订阅来源失败" }, { status: 422 }); }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { index?: number };
    const index = Number(body.index);
    const { active, entries } = await currentState();
    if (!active) throw new Error("还没有订阅来源");
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("订阅来源不存在");
    if (entries.length <= 1) throw new Error("至少保留一个订阅来源");
    entries.splice(index, 1);
    const encryptedSource = await encryptSourceUrl(entries);
    await syncActiveClashSources(encryptedSource);
    return NextResponse.json({ sources: publicSources(entries) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "删除订阅来源失败" }, { status: 422 }); }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { index?: number; hidden?: boolean };
    const index = Number(body.index);
    const hidden = body.hidden === true;
    const { active, entries } = await currentState();
    if (!active) throw new Error("还没有订阅来源");
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("订阅来源不存在");
    if (hidden && !entries[index].hidden && entries.filter((entry) => !entry.hidden).length <= 1) throw new Error("至少保留一个可用来源");
    const nextEntries = entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, hidden } : entry);
    if (hidden) {
      const visibleEntries = nextEntries.filter((entry) => !entry.hidden);
      const inlineCount = visibleEntries.filter((entry) => entry.kind === "content").length;
      const urlEntries = visibleEntries.filter((entry): entry is Extract<ClashSourceEntry, { kind: "url" }> => entry.kind === "url");
      const checks = await Promise.allSettled(urlEntries.map((entry) => fetchAirportSubscription(entry.value)));
      const successfulCount = checks.filter((check) => check.status === "fulfilled").length;
      if (!inlineCount && !successfulCount) {
        const failedNames = urlEntries.map((entry) => { try { return new URL(entry.value).hostname; } catch { return "订阅地址"; } });
        throw new Error(`隐藏后剩余来源无法读取：${failedNames.join("、")}。请先确认花云订阅可用，或上传 YAML 文件。`);
      }
    }
    entries.splice(0, entries.length, ...nextEntries);
    const encryptedSource = await encryptSourceUrl(entries);
    await syncActiveClashSources(encryptedSource);
    return NextResponse.json({ sources: publicSources(entries) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "更新订阅来源失败" }, { status: 422 }); }
}
