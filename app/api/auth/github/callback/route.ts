import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, STATE_COOKIE, secureCookie } from "../../../../lib/github-auth";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!code || !state || !expectedState || state !== expectedState || !clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/?login_error=invalid_request", request.url));
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${request.nextUrl.origin}/api/auth/github/callback` }),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !token.access_token) return NextResponse.redirect(new URL("/?login_error=token", request.url));

  const userResponse = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "User-Agent": "mw-shadowrocket-rule-manager" },
  });
  const user = (await userResponse.json()) as { login?: string };
  const allowed = (process.env.GITHUB_ALLOWED_LOGIN || "mmousew").toLowerCase();
  if (!userResponse.ok || user.login?.toLowerCase() !== allowed) return NextResponse.redirect(new URL("/?login_error=forbidden", request.url));

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(SESSION_COOKIE, await createSession(user.login), secureCookie(7 * 24 * 60 * 60));
  response.cookies.set(STATE_COOKIE, "", secureCookie(0));
  return response;
}
