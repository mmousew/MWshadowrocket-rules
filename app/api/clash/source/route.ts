import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { encryptSourceUrl, parseSourceEntries, decryptSourceUrl, type ClashSourceEntry } from "../../../lib/clash-link";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { listClashLinks, syncActiveClashSources } from "../../../lib/clash-links";

function sourceName(entry: ClashSourceEntry, index: number) {
  if (entry.kind === "content") return entry.name || `本地订阅文件 ${index + 1}`;
  try { return new URL(entry.value).hostname; } catch { return `订阅来源 ${index + 1}`; }
}

function publicSources(entries: ClashSourceEntry[]) {
  return entries.map((entry, index) => ({ index, name: sourceName(entry, index), kind: entry.kind, nodes: entry.kind === "content" ? getAirportProxyCount(entry.value) : null }));
}

async function currentEntries() {
  const rows = await listClashLinks();
  const active = rows.find((row) => row.status === "active");
  if (!active?.encrypted_source) throw new Error("请先生成一条订阅链接");
  return parseSourceEntries(await decryptSourceUrl(active.encrypted_source));
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try { return NextResponse.json({ sources: publicSources(await currentEntries()) }); }
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
      const body = await request.json() as { sourceUrl?: string };
      sourceUrl = String(body.sourceUrl || "").trim();
    }
    if (!sourceUrl && !file) throw new Error("请输入订阅地址或选择 YAML 文件");
    const entries = await currentEntries();
    let added: ClashSourceEntry;
    if (file) {
      if (file.size > 900_000) throw new Error("文件过大，请先下载较小的 Clash YAML 文件");
      const content = await file.text();
      if (!getAirportProxyCount(content)) throw new Error("文件没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置");
      added = { kind: "content", value: content, name: file.name || "本地订阅文件" };
    } else {
      const result = await fetchAirportSubscription(sourceUrl);
      added = { kind: "url", value: sourceUrl };
      void result;
    }
    if (entries.some((entry) => entry.kind === added.kind && (entry.kind === "url" ? entry.value === added.value : entry.name === added.name))) throw new Error("这个订阅来源已经添加过了");
    entries.push(added);
    const encryptedSource = await encryptSourceUrl(entries);
    await syncActiveClashSources(encryptedSource);
    return NextResponse.json({ sources: publicSources(entries), added: sourceName(added, entries.length - 1) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "添加订阅来源失败" }, { status: 422 }); }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { index?: number };
    const index = Number(body.index);
    const entries = await currentEntries();
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) throw new Error("订阅来源不存在");
    if (entries.length <= 1) throw new Error("至少保留一个订阅来源");
    entries.splice(index, 1);
    const encryptedSource = await encryptSourceUrl(entries);
    await syncActiveClashSources(encryptedSource);
    return NextResponse.json({ sources: publicSources(entries) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "删除订阅来源失败" }, { status: 422 }); }
}
