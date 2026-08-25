import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../../lib/github-auth";
import { getClashAirportSource } from "../../../../lib/clash-airport-sources";
import { getClashProxyId, parseAirportProxies } from "../../../../lib/clash-config";
import { getClashProfile, getSourceSnapshot } from "../../../../lib/clash-links";
import { decryptSourceUrl, parseSourceEntries } from "../../../../lib/clash-link";

type ProxyRecord = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function validateProxy(proxy: ProxyRecord) {
  const type = text(proxy.type).toLowerCase();
  const name = text(proxy.name);
  const server = text(proxy.server);
  const port = Number(proxy.port);
  const errors: string[] = [];

  if (!name) errors.push("缺少节点名称");
  if (!type) errors.push("缺少协议类型");
  if (!server || /\s/.test(server)) errors.push("服务器地址不完整");
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("端口不正确");

  if (type === "ss" && (!text(proxy.cipher) || !text(proxy.password))) errors.push("加密方式或密码不完整");
  if (["vmess", "vless"].includes(type) && !text(proxy.uuid)) errors.push("UUID 不完整");
  if (type === "trojan" && !text(proxy.password)) errors.push("密码不完整");

  return errors;
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id")?.trim();
  const profileId = request.nextUrl.searchParams.get("profileId")?.trim() || "";
  if (!id) return NextResponse.json({ error: "缺少机场来源 ID" }, { status: 422 });

  try {
    let source = await getClashAirportSource(id);
    if (!source && profileId) {
      const profile = await getClashProfile(profileId);
      const entries = profile?.encrypted_source ? parseSourceEntries(await decryptSourceUrl(profile.encrypted_source)) : [];
      const entry = entries.find((item) => item.sourceId === id);
      if (entry) {
        source = {
          id,
          name: entry.name || "订阅来源",
          kind: entry.kind,
          sourceUrl: entry.kind === "url" ? entry.value : null,
          content: entry.kind === "content" ? entry.value : null,
          hidden: entry.hidden === true,
          status: "active",
          nodeCount: entry.kind === "content" ? parseAirportProxies(entry.value).length : null,
          createdAt: 0,
          updatedAt: 0,
        };
      }
    }
    if (!source) return NextResponse.json({ error: "机场不存在" }, { status: 404 });

    let content = source.content;
    if (!content && source.kind === "url" && source.sourceUrl) {
      content = (await getSourceSnapshot(source.sourceUrl))?.content || "";
    }
    if (!content) return NextResponse.json({ error: "这个机场还没有可检查的配置快照，请先点击更新" }, { status: 422 });

    const nodes = parseAirportProxies(content).map((proxy, index) => {
      const record = proxy as ProxyRecord;
      const errors = validateProxy(record);
      const name = text(record.name) || `未命名节点 ${index + 1}`;
      const server = text(record.server);
      const port = Number(record.port);
      return {
        id: getClashProxyId(proxy),
        name,
        type: text(record.type).toUpperCase() || "未知",
        server,
        port: Number.isInteger(port) ? port : null,
        status: errors.length ? "invalid" : "valid",
        reason: errors[0] || "节点参数完整",
      };
    });

    return NextResponse.json({
      source: { id: source.id, name: source.name, nodeCount: source.nodeCount },
      nodes,
      checkedAt: Date.now(),
      note: "此处检查节点配置是否完整，不等同于客户端实际测速；实际连通性还取决于机场状态、线路和客户端。",
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取节点失败" }, { status: 422 });
  }
}
