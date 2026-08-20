import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, secureCookie } from "../../../../lib/github-auth";

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(SESSION_COOKIE, "", secureCookie(0));
  return response;
}
