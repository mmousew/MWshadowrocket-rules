import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../lib/github-auth";
import { createRuleConfig, deleteRuleConfig, ensureDefaultRuleConfig, ensureDefaultRuleConfigTemplate, ensureMwDefaultTemplateMerge, ensureRuleConfigAssignments, getRuleConfig, listRuleConfigs, listRuleGroupVisibility, migrateLegacyGroupVisibility, replaceRuleGroupVisibility, restoreHaoziRuleConfig, setRuleConfigTemplateDefault, updateRuleConfig } from "../../lib/rule-configs";
import { validateProtectedGroupChanges, validateRuleConfiguration } from "../../lib/rule-validation";
import { ensureRuleSetLibrary, repairChinaDirectState, replaceRuleSetBindings, setRuleSetBindingEnabled } from "../../lib/rule-sets";

const OWNER = "mmousew";
const REPO = "MWshadowrocket-rules";
const BRANCH = "rules/initial-region-module";
const FILE_PATH = "MW-Shadowrocket-Config.conf";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

type GitHubFile = { content?: string; message?: string };

async function readGitHubRules() {
  const response = await fetch(`${API_URL}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mw-shadowrocket-rule-manager",
      ...(process.env.GITHUB_RULES_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_RULES_TOKEN}` } : {}),
    },
    cache: "no-store",
  });
  const file = await response.json() as GitHubFile;
  if (!response.ok || !file.content) throw new Error(file.message || `读取 GitHub 规则失败（${response.status}）`);
  return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function validateRuleContent(content: string) {
  if (!content.trim()) throw new Error("规则配置不能为空");
  if (content.length > 1_500_000) throw new Error("规则配置超过允许大小");
  if (!content.includes("[Proxy Group]") || !content.includes("[Rule]")) throw new Error("规则配置缺少必要配置段");
  const errors = validateRuleConfiguration(content);
  if (errors.length) throw new Error(errors.join("\n"));
}

async function ensureConfigs() {
  let defaultConfig = await getRuleConfig("default");
  if (!defaultConfig) defaultConfig = await ensureDefaultRuleConfig(await readGitHubRules());
  if (!defaultConfig) throw new Error("默认规则方案初始化失败");
  await ensureRuleConfigAssignments();
  await ensureRuleSetLibrary();
  await repairChinaDirectState();
  await migrateLegacyGroupVisibility();
  await ensureMwDefaultTemplateMerge();
  await ensureDefaultRuleConfigTemplate();
  defaultConfig = await getRuleConfig("default") || defaultConfig;
  return { configs: await listRuleConfigs(), defaultConfig };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const { configs } = await ensureConfigs();
    const requestedId = request.nextUrl.searchParams.get("id") || "default";
    const selected = configs.find((config) => config.id === requestedId) || configs[0];
    return NextResponse.json({ configs, selectedId: selected?.id || "default", groupVisibility: selected ? await listRuleGroupVisibility(selected.id) : [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取规则方案失败" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { name?: string };
    const { configs } = await ensureConfigs();
    const source = configs.find((config) => config.id === "default") || configs[0];
    if (!source) throw new Error("没有可复制的规则方案");
    const config = await createRuleConfig(String(body.name || "规则方案"), source.content);
    return NextResponse.json({ config, groupVisibility: config ? await listRuleGroupVisibility(config.id) : [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "新增规则方案失败" }, { status: 422 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string; name?: string; content?: string; setDefault?: boolean; recoverHaozi?: boolean; ruleSetBindings?: Array<{ groupName?: string; ruleSetId?: string; enabled?: boolean }>; ruleSetBinding?: { groupName?: string; ruleSetId?: string; enabled?: boolean }; groupVisibility?: Array<{ groupName?: string; visible?: boolean }> };
    const id = String(body.id || "").trim();
    if (!id) throw new Error("规则方案不存在");
    if (body.recoverHaozi) {
      if (id !== "haozi-custom") throw new Error("只能恢复 MWPRO 方案");
      const config = await restoreHaoziRuleConfig();
      return NextResponse.json({ config, configs: await listRuleConfigs() });
    }
    const current = typeof body.content === "string" ? await getRuleConfig(id) : null;
    if (typeof body.content === "string") {
      validateRuleContent(body.content);
      if (current) {
        const protectedErrors = validateProtectedGroupChanges(current.content, body.content);
        if (protectedErrors.length) throw new Error(protectedErrors.join("\n"));
      }
    }
    if (body.setDefault) await setRuleConfigTemplateDefault(id);
    const config = await updateRuleConfig(id, { name: body.name, content: body.content });
    if (Array.isArray(body.ruleSetBindings)) {
      await replaceRuleSetBindings(id, body.ruleSetBindings.map((binding) => ({ groupName: String(binding.groupName || ""), ruleSetId: String(binding.ruleSetId || ""), enabled: binding.enabled !== false })));
    }
    if (body.ruleSetBinding) {
      const groupName = String(body.ruleSetBinding.groupName || "").trim();
      const ruleSetId = String(body.ruleSetBinding.ruleSetId || "").trim();
      if (groupName && ruleSetId) await setRuleSetBindingEnabled(id, groupName, ruleSetId, body.ruleSetBinding.enabled !== false);
    }
    if (Array.isArray(body.groupVisibility)) {
      await replaceRuleGroupVisibility(id, body.groupVisibility.map((setting) => ({ groupName: String(setting.groupName || ""), visible: setting.visible !== false })));
    }
    return NextResponse.json({ config, configs: await listRuleConfigs(), groupVisibility: await listRuleGroupVisibility(id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存规则方案失败" }, { status: 422 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string };
    await deleteRuleConfig(String(body.id || "").trim());
    return NextResponse.json({ configs: (await ensureConfigs()).configs });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除规则方案失败" }, { status: 422 });
  }
}
