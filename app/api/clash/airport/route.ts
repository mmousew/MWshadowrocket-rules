import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import {
  createClashAirportSource,
  deleteClashAirportSource,
  listClashAirportSources,
  refreshClashAirportSource,
  setClashAirportSourceHidden,
  updateClashAirportSource,
  type ClashAirportSourceRow,
} from "../../../lib/clash-airport-sources";
import { getAirportProxyCount } from "../../../lib/clash-config";
import { saveSourceSnapshot } from "../../../lib/clash-links";

function publicSource(source: ClashAirportSourceRow) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    sourceUrl: source.kind === "url" ? source.sourceUrl : "",
    hidden: source.hidden,
    nodeCount: source.nodeCount,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const sources = await listClashAirportSources();
    return NextResponse.json({ sources: sources.map(publicSource) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取机场列表失败" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const form = await request.formData();
    const name = String(form.get("name") || "").trim();
    const sourceUrl = String(form.get("sourceUrl") || "").trim();
    const value = form.get("sourceFile");
    const file = value instanceof File ? value : null;
    if (sourceUrl && file) throw new Error("请只选择订阅地址或文件其中一种");
    if (!sourceUrl && !file) throw new Error("请填写订阅地址或选择 YAML 文件");
    if (file) {
      if (file.size > 900_000) throw new Error("文件过大，请先下载较小的 Clash YAML 文件");
      const content = await file.text();
      const nodeCount = getAirportProxyCount(content);
      if (!nodeCount) throw new Error("文件没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置");
      const source = await createClashAirportSource({ kind: "content", value: content }, name || file.name || "本地订阅文件", nodeCount);
      return NextResponse.json({ source: source ? publicSource(source) : null });
    }
    const fetched = await fetchAirportSubscription(sourceUrl);
    await saveSourceSnapshot(sourceUrl, fetched.content, fetched.nodeCount);
    const source = await createClashAirportSource({ kind: "url", value: sourceUrl }, name || new URL(sourceUrl).hostname, fetched.nodeCount);
    return NextResponse.json({ source: source ? publicSource(source) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "新增机场失败" }, { status: 422 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const contentType = request.headers.get("content-type") || "";
    let id = "";
    let action = "";
    let name: string | undefined;
    let sourceUrl: string | undefined;
    let content: string | undefined;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      id = String(form.get("id") || "").trim();
      action = String(form.get("action") || "").trim();
      name = typeof form.get("name") === "string" ? String(form.get("name")) : undefined;
      sourceUrl = typeof form.get("sourceUrl") === "string" ? String(form.get("sourceUrl")).trim() : undefined;
      const value = form.get("sourceFile");
      if (value instanceof File) {
        if (value.size > 900_000) throw new Error("文件过大，请先下载较小的 Clash YAML 文件");
        content = await value.text();
      }
    } else {
      const body = await request.json() as { id?: string; action?: string; name?: string; sourceUrl?: string };
      id = String(body.id || "").trim();
      action = String(body.action || "").trim();
      name = typeof body.name === "string" ? body.name : undefined;
      sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : undefined;
    }
    if (!id) throw new Error("机场不存在");
    let source: ClashAirportSourceRow | null;
    if (action === "refresh") source = await refreshClashAirportSource(id);
    else if (action === "hide" || action === "unhide") source = await setClashAirportSourceHidden(id, action === "hide");
    else {
      if (content) {
        const count = getAirportProxyCount(content);
        if (!count) throw new Error("文件没有识别到节点，请确认是 Clash YAML 或 Shadowrocket 配置");
      }
      source = await updateClashAirportSource(id, { name, sourceUrl, content });
    }
    return NextResponse.json({ source: source ? publicSource(source) : null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新机场失败" }, { status: 422 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string };
    const id = String(body.id || "").trim();
    if (!id) throw new Error("机场不存在");
    await deleteClashAirportSource(id);
    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除机场失败" }, { status: 422 });
  }
}
