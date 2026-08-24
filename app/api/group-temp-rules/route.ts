import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../lib/github-auth";
import { createGroupTempRule, deleteGroupTempRule, listGroupTempRules, updateGroupTempRule } from "../../lib/group-temp-rules";

function unauthorized() {
  return NextResponse.json({ error: "需要先登录 GitHub" }, { status: 401 });
}

export async function GET(request: NextRequest) {
  if (!(await getGitHubLogin(request))) return unauthorized();
  try {
    const configId = request.nextUrl.searchParams.get("config") || "default";
    const groupName = request.nextUrl.searchParams.get("group") || undefined;
    return NextResponse.json({ rules: await listGroupTempRules(configId, groupName) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取临时规则失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await getGitHubLogin(request))) return unauthorized();
  try {
    const body = await request.json() as { configId?: string; groupName?: string; type?: string; value?: string; options?: string[] };
    const values = String(body.value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new Error("临时规则内容不能为空");
    for (const value of values) await createGroupTempRule({ configId: String(body.configId || ""), groupName: String(body.groupName || ""), type: String(body.type || ""), value, options: body.options });
    return NextResponse.json({ rules: await listGroupTempRules(String(body.configId || ""), String(body.groupName || "")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存临时规则失败" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await getGitHubLogin(request))) return unauthorized();
  try {
    const body = await request.json() as { id?: string; configId?: string; groupName?: string; type?: string; value?: string; options?: string[] };
    await updateGroupTempRule(String(body.id || ""), { configId: String(body.configId || ""), groupName: String(body.groupName || ""), type: String(body.type || ""), value: String(body.value || ""), options: body.options });
    return NextResponse.json({ rules: await listGroupTempRules(String(body.configId || ""), String(body.groupName || "")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新临时规则失败" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await getGitHubLogin(request))) return unauthorized();
  try {
    const body = await request.json() as { id?: string; configId?: string; groupName?: string };
    await deleteGroupTempRule(String(body.id || ""), String(body.configId || ""));
    return NextResponse.json({ rules: await listGroupTempRules(String(body.configId || ""), String(body.groupName || "")) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除临时规则失败" }, { status: 400 });
  }
}
