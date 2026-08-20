import { NextRequest, NextResponse } from "next/server";

const OWNER = "mmousew";
const REPO = "MWshadowrocket-rules";
const BRANCH = "rules/initial-region-module";
const FILE_PATH = "MW-Shadowrocket-Config.conf";
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
const BUILTIN_POLICIES = new Set(["DIRECT", "PROXY", "REJECT", "REJECT-DROP", "REJECT-NO-DROP"]);

type GitHubFile = { content: string; encoding: string; sha: string; html_url: string };

function githubHeaders(write = false): HeadersInit {
  const token = process.env.GITHUB_RULES_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mw-shadowrocket-rule-manager",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(write ? { "Content-Type": "application/json" } : {}),
  };
}

function decodeBase64(value: string) {
  return Buffer.from(value.replace(/\n/g, ""), "base64").toString("utf8");
}

function requirePrivateAccess(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true;
  return Boolean(request.headers.get("oai-authenticated-user-id"));
}

function validateConfig(content: string) {
  const errors: string[] = [];
  if (content.length > 1_500_000) errors.push("配置文件超过允许大小");
  if (!content.includes("[Proxy Group]") || !content.includes("[Rule]")) errors.push("缺少必要配置段");

  const lines = content.split(/\r?\n/);
  const groupStart = lines.findIndex((line) => line.trim() === "[Proxy Group]");
  const ruleStart = lines.findIndex((line) => line.trim() === "[Rule]");
  const groups = new Set<string>();
  if (groupStart >= 0 && ruleStart > groupStart) {
    for (const line of lines.slice(groupStart + 1, ruleStart)) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+)$/);
      if (match) groups.add(match[1].trim());
    }
  }

  const seen = new Map<string, { policy: string; line: number }>();
  let lastRule = "";
  if (ruleStart >= 0) {
    lines.slice(ruleStart + 1).forEach((raw, offset) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      lastRule = line;
      const parts = line.split(",").map((part) => part.trim());
      if (parts.length < 3) {
        errors.push(`第 ${ruleStart + offset + 2} 行规则字段不足`);
        return;
      }
      const [type, value, policy] = parts;
      const key = `${type},${value}`;
      const previous = seen.get(key);
      if (previous && previous.policy !== policy) {
        errors.push(`规则冲突：${key} 同时指向 ${previous.policy} 和 ${policy}`);
      } else if (!previous) {
        seen.set(key, { policy, line: ruleStart + offset + 2 });
      }
      if (!BUILTIN_POLICIES.has(policy) && !groups.has(policy)) {
        errors.push(`第 ${ruleStart + offset + 2} 行引用不存在的策略：${policy}`);
      }
    });
  }
  if (!lastRule.startsWith("FINAL,")) errors.push("最后一条有效规则必须是 FINAL");
  return Array.from(new Set(errors)).slice(0, 20);
}

export async function GET(request: NextRequest) {
  if (!requirePrivateAccess(request)) return NextResponse.json({ error: "请登录后访问" }, { status: 401 });
  const response = await fetch(`${API_URL}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: githubHeaders(),
    cache: "no-store",
  });
  if (!response.ok) return NextResponse.json({ error: `读取 GitHub 失败（${response.status}）` }, { status: 502 });
  const file = (await response.json()) as GitHubFile;
  return NextResponse.json({
    content: decodeBase64(file.content),
    sha: file.sha,
    branch: BRANCH,
    repository: `${OWNER}/${REPO}`,
    sourceUrl: file.html_url,
    saveEnabled: Boolean(process.env.GITHUB_RULES_TOKEN),
  });
}

export async function PUT(request: NextRequest) {
  if (!requirePrivateAccess(request)) return NextResponse.json({ error: "请登录后访问" }, { status: 401 });
  const token = process.env.GITHUB_RULES_TOKEN;
  if (!token) return NextResponse.json({ error: "尚未配置 GitHub 写入凭据" }, { status: 503 });

  const body = (await request.json()) as { content?: string; sha?: string; message?: string };
  if (!body.content || !body.sha) return NextResponse.json({ error: "缺少配置内容或版本信息" }, { status: 400 });
  const errors = validateConfig(body.content);
  if (errors.length) return NextResponse.json({ error: "配置检查未通过", details: errors }, { status: 422 });

  const response = await fetch(API_URL, {
    method: "PUT",
    headers: githubHeaders(true),
    body: JSON.stringify({
      message: (body.message || "Update Shadowrocket rules from MW Rules").slice(0, 120),
      content: Buffer.from(body.content, "utf8").toString("base64"),
      sha: body.sha,
      branch: BRANCH,
    }),
  });
  const result = (await response.json()) as { content?: { sha?: string }; commit?: { html_url?: string }; message?: string };
  if (!response.ok) return NextResponse.json({ error: result.message || `GitHub 保存失败（${response.status}）` }, { status: response.status });
  return NextResponse.json({ sha: result.content?.sha, commitUrl: result.commit?.html_url });
}
