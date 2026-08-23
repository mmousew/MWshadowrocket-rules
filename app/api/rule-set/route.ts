import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../lib/github-auth";
import { parseRuleSetEntries } from "../../lib/rule-set-core";
import { createRuleSet, deleteRuleSet, ensureRuleSetLibrary, listRuleSetBindings, listRuleSets, toClient, updateRuleSet } from "../../lib/rule-sets";

function clientRows(rows: Awaited<ReturnType<typeof listRuleSets>>) {
  return rows.map(toClient);
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const ruleSets = await ensureRuleSetLibrary();
    const configId = request.nextUrl.searchParams.get("config") || "default";
    const bindings = await listRuleSetBindings(configId);
    return NextResponse.json({ ruleSets: clientRows(ruleSets), bindings });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取规则集失败" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { name?: string; description?: string; entries?: string | unknown[]; source?: string };
    const entries = Array.isArray(body.entries) ? parseRuleSetEntries(body.entries) : parseRuleSetEntries(String(body.entries || ""));
    const row = await createRuleSet({ name: String(body.name || ""), description: body.description, entries, source: body.source });
    return NextResponse.json({ ruleSet: toClient(row), ruleSets: clientRows(await listRuleSets()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "新增规则集失败" }, { status: 422 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string; name?: string; description?: string; entries?: string | unknown[]; source?: string };
    const id = String(body.id || "").trim();
    if (!id) throw new Error("规则集不存在");
    const entries = body.entries === undefined ? undefined : Array.isArray(body.entries) ? parseRuleSetEntries(body.entries) : parseRuleSetEntries(String(body.entries || ""));
    const row = await updateRuleSet(id, { name: body.name, description: body.description, entries, source: body.source });
    return NextResponse.json({ ruleSet: toClient(row), ruleSets: clientRows(await listRuleSets()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存规则集失败" }, { status: 422 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  try {
    const body = await request.json() as { id?: string };
    const id = String(body.id || "").trim();
    if (!id) throw new Error("规则集不存在");
    await deleteRuleSet(id);
    return NextResponse.json({ ruleSets: clientRows(await listRuleSets()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除规则集失败" }, { status: 422 });
  }
}
