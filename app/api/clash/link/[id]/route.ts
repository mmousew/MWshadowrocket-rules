import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../../lib/github-auth";
import { updateClashLink } from "../../../../lib/clash-links";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const body = await request.json() as { action?: string };
  if (body.action !== "revoke") return NextResponse.json({ error: "无效操作" }, { status: 400 });
  await updateClashLink((await context.params).id, "revoked");
  return NextResponse.json({ ok: true, status: "revoked" });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  await updateClashLink((await context.params).id, "deleted");
  return NextResponse.json({ ok: true });
}
