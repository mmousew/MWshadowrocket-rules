import { NextRequest } from "next/server";

export const SESSION_COOKIE = "mw_github_session";
export const STATE_COOKIE = "mw_github_oauth_state";

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function signature(value: string) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) throw new Error("缺少登录会话密钥");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(result).toString("base64url");
}

export async function createSession(login: string) {
  const payload = encode(JSON.stringify({ login, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  return `${payload}.${await signature(payload)}`;
}

export async function getGitHubLogin(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return process.env.GITHUB_ALLOWED_LOGIN || "mmousew";
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  const [payload, suppliedSignature] = session.split(".");
  if (!payload || !suppliedSignature || await signature(payload) !== suppliedSignature) return null;
  try {
    const value = JSON.parse(decode(payload)) as { login?: string; expires?: number };
    const allowed = (process.env.GITHUB_ALLOWED_LOGIN || "mmousew").toLowerCase();
    if (!value.login || !value.expires || value.expires < Date.now() || value.login.toLowerCase() !== allowed) return null;
    return value.login;
  } catch {
    return null;
  }
}

export function secureCookie(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge };
}
