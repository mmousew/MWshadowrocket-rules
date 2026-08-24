import { NextRequest, NextResponse } from "next/server";
import { buildClashConfig, buildShadowrocketConfig, buildShadowrocketRulesConfig, filterHiddenGroups, resolveAirportProxyHosts } from "../../../lib/clash-config";
import { fetchAirportSubscription } from "../../../lib/airport-subscription";
import { decryptSourceUrl } from "../../../lib/clash-link";
import { findClashLink, getClashProfile, getSourceSnapshot, saveSourceSnapshot } from "../../../lib/clash-links";
import { ensureMwDefaultTemplateMerge, ensureRuleConfigAssignments, getRuleConfig, listRuleGroupVisibility, migrateLegacyGroupVisibility } from "../../../lib/rule-configs";
import { composeBoundRuleSets, composeTemporaryRules } from "../../../lib/rule-set-core";
import { listGroupTempRules } from "../../../lib/group-temp-rules";
import { ensureRuleSetLibrary, listRuleSetBindings, repairChinaDirectState } from "../../../lib/rule-sets";

const OWNER = "mmousew";
const REPO = "MWshadowrocket-rules";
const BRANCH = "rules/initial-region-module";
const FILE_PATH = "MW-Shadowrocket-Config.conf";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

type GitHubFile = { content?: string; message?: string };

function getAirportSnapshot() {
  let encoded = "";
  for (let index = 1; index <= 10; index += 1) encoded += process.env[`AIRPORT_PROXY_SNAPSHOT_${index}`] || "";
  return encoded ? `[Proxy]\n${Buffer.from(encoded, "base64").toString("utf8")}\n` : "";
}

function configFilename(name: string, extension: "yaml" | "conf") {
  const fallback = extension === "yaml" ? "MW-Clash" : "MW-Shadowrocket";
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || fallback;
  const filename = `${cleaned}.${extension}`;
  // Send UTF-8 bytes through the legacy filename parameter. This is the
  // parameter ClashX Meta actually reads; filename* made some versions show
  // the percent-encoded Chinese text literally.
  const headerValue = Buffer.from(filename, "utf8").toString("latin1");
  return `inline; filename="${headerValue}"`;
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const expectedToken = process.env.CLASH_ACCESS_TOKEN;
  const querySource = request.nextUrl.searchParams.get("source");
  let encryptedSource = querySource;
  let managedLink = false;
  let profileName = "订阅配置";
  let ruleConfigId = "default";
  let ruleConfigName = "默认规则";
  // Apply the one-time rule-scheme migration before reading the profile so a
  // managed link immediately picks up its corrected rule assignment.
  try {
    await ensureRuleConfigAssignments();
    await repairChinaDirectState();
    await migrateLegacyGroupVisibility();
  } catch { /* retain legacy output if D1 is temporarily unavailable */ }
  try {
    const record = await findClashLink(token);
    if (record) {
      managedLink = true;
      if (record.status !== "active") return new NextResponse("订阅链接已失效", { status: 404 });
      encryptedSource = record.encrypted_source || null;
      try {
        const profile = await getClashProfile(record.profile_id || "default");
        if (profile?.name?.trim()) profileName = profile.name.trim();
        if (profile?.rule_config_id?.trim()) ruleConfigId = profile.rule_config_id.trim();
      } catch {
        // 文件名不能影响订阅本身的生成；数据库暂时不可用时使用通用名称。
      }
    }
  } catch {
    // D1 不可用时保留旧版环境变量链接的兼容路径。
  }
  if (!managedLink) {
    try {
      const profile = await getClashProfile("default");
      if (profile?.name?.trim()) profileName = profile.name.trim();
    } catch {
      // Legacy environment-variable links may not have a profile record.
    }
  }
  if (!managedLink && (!expectedToken || token !== expectedToken)) return new NextResponse("订阅链接无效", { status: 404 });

  try {
    const encryptedValue = encryptedSource ? await decryptSourceUrl(encryptedSource) : process.env.AIRPORT_SHADOWROCKET_URL || "";
    let airportUrls: string[] = [];
    const inlineContent: string[] = [];
    try {
      const parsed = JSON.parse(encryptedValue);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") airportUrls.push(item);
          else if (item?.kind === "url" && typeof item.value === "string" && item.hidden !== true) airportUrls.push(item.value);
          else if (item?.kind === "content" && typeof item.value === "string" && item.hidden !== true) inlineContent.push(item.value);
        }
      } else airportUrls = [encryptedValue];
    } catch {
      airportUrls = [encryptedValue];
    }
    airportUrls = airportUrls.map((url) => url.trim()).filter(Boolean);
    if (!airportUrls.length && !inlineContent.length) return new NextResponse("尚未配置机场来源", { status: 503 });
    const userAgent = request.headers.get("user-agent") || "";
    const requestedFormat = request.nextUrl.searchParams.get("format");
    const requestedConfigName = request.nextUrl.searchParams.get("name")?.trim() || request.nextUrl.searchParams.get("filename")?.trim() || "";
    const shadowrocketRules = requestedFormat === "shadowrocket-rules";
    const shadowrocket = shadowrocketRules || requestedFormat === "shadowrocket" || /shadowrocket/i.test(userAgent);
    const subscriptionClient = shadowrocket ? "shadowrocket" as const : "clash" as const;
    let ruleContent = "";
    try {
      const ruleConfig = await getRuleConfig(ruleConfigId);
      ruleContent = ruleConfig?.content || "";
      if (ruleConfig?.name?.trim()) ruleConfigName = ruleConfig.name.trim();
    } catch { /* 兼容旧数据库/旧链接，继续读取 GitHub */ }
    try {
      const ruleSets = await ensureRuleSetLibrary();
      await ensureMwDefaultTemplateMerge();
      const bindings = await listRuleSetBindings(ruleConfigId);
      ruleContent = composeBoundRuleSets(ruleContent, ruleSets, bindings.map((item) => ({ groupName: item.group_name, ruleSetId: item.rule_set_id })), subscriptionClient);
      const temporaryRules = await listGroupTempRules(ruleConfigId);
      ruleContent = composeTemporaryRules(ruleContent, temporaryRules.map((item) => ({ groupName: item.groupName, type: item.type, value: item.value, policy: item.policy, options: item.options })));
    } catch (error) {
      console.error("[clash] shared rule-set composition failed", error);
      // The legacy content remains a safe fallback if the shared ruleset library is unavailable.
    }
    const airportResult = await Promise.allSettled(airportUrls.map(async (url) => {
        try {
          const fetched = await fetchAirportSubscription(url, subscriptionClient);
          try { await saveSourceSnapshot(url, fetched.content, fetched.nodeCount, subscriptionClient); } catch { /* 快照写入失败不影响本次在线更新 */ }
          return { kind: "live" as const, content: fetched.content };
        } catch (error) {
          let snapshot = null;
          try { snapshot = await getSourceSnapshot(url, subscriptionClient); } catch { /* 没有可用快照时继续记录失败 */ }
          if (snapshot?.content) return { kind: "snapshot" as const, content: snapshot.content };
          throw error;
        }
      })).then((results) => ({
        content: [...inlineContent, ...results.flatMap((result) => result.status === "fulfilled" ? [result.value.content] : [])],
        liveCount: results.filter((result) => result.status === "fulfilled" && result.value.kind === "live").length,
        snapshotCount: results.filter((result) => result.status === "fulfilled" && result.value.kind === "snapshot").length,
      }));
    if (!ruleContent) {
      const ruleResponse = await fetch(`${API_URL}?ref=${encodeURIComponent(BRANCH)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mw-clash-subscription",
          ...(process.env.GITHUB_RULES_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_RULES_TOKEN}` } : {}),
        },
        cache: "no-store",
      });
      if (!ruleResponse.ok) throw new Error(`读取规则方案失败，且 GitHub 备用读取失败（${ruleResponse.status}）`);
      const file = await ruleResponse.json() as GitHubFile;
      if (!file.content) throw new Error(file.message || "规则方案内容为空");
      ruleContent = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
    }
    try {
      await migrateLegacyGroupVisibility();
      const visibility = await listRuleGroupVisibility(ruleConfigId);
      ruleContent = filterHiddenGroups(ruleContent, visibility.filter((row) => row.visible === 0).map((row) => row.group_name));
    } catch {
      // If the visibility table is temporarily unavailable, retain the last
      // complete rule output instead of failing an otherwise valid subscription.
    }
    const liveAirportContent = airportResult.content;
    const airportContent = liveAirportContent.length ? liveAirportContent : (encryptedSource ? [] : [getAirportSnapshot()]);
    if (!airportContent.length || !airportContent[0]) throw new Error("机场在线地址暂时不可用，且没有安全节点快照");
    // Clash needs source-specific hostname resolution. Shadowrocket must keep
    // the airport's original hostname and DNS behavior instead of receiving a
    // Clash-only fixed-IP mapping.
    const hostMappings = shadowrocket ? {} : await resolveAirportProxyHosts(airportContent);
    const config = shadowrocketRules
      ? buildShadowrocketRulesConfig(ruleContent, airportContent, hostMappings, ruleConfigName)
      : shadowrocket
        ? buildShadowrocketConfig(ruleContent, airportContent, hostMappings, ruleConfigName)
        : buildClashConfig(ruleContent, airportContent, hostMappings, ruleConfigName);
    const outputName = (requestedConfigName || profileName).slice(0, 80).trim() || "订阅配置";
    return new NextResponse(config, {
      headers: {
        "Content-Type": shadowrocket ? "text/plain; charset=utf-8" : "text/yaml; charset=utf-8",
        "Content-Disposition": configFilename(outputName, shadowrocketRules || shadowrocket ? "conf" : "yaml"),
        // The VPS relay uses this ASCII-safe metadata header to preserve the
        // subscription name when it re-serves the cached body.
        "X-MW-Config-Name": encodeURIComponent(outputName),
        // Always return the newest airport/rules merge after a client update.
        // Caching the generated profile can make one airport appear broken after
        // another source has just been fixed.
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Profile-Update-Interval": "6",
        "X-MW-Node-Source": airportResult.snapshotCount ? (airportResult.liveCount ? "live+snapshot" : "snapshot") : (airportResult.liveCount ? "live" : "secure-snapshot"),
      },
    });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "生成 Clash 配置失败", { status: 502 });
  }
}
