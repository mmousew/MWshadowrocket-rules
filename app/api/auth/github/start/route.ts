import { NextRequest, NextResponse } from "next/server";
import { STATE_COOKIE, secureCookie } from "../../../../lib/github-auth";

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "GitHub 登录尚未配置" }, { status: 503 });
  const state = crypto.randomUUID();
  const callback = `${request.nextUrl.origin}/api/auth/github/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("login", process.env.GITHUB_ALLOWED_LOGIN || "mmousew");
  const response = NextResponse.redirect(authorize);
  response.cookies.set(STATE_COOKIE, state, secureCookie(10 * 60));
  return response;
}
