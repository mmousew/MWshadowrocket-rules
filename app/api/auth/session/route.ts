import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../../lib/github-auth";

export async function GET(request: NextRequest) {
  const login = await getGitHubLogin(request);
  return NextResponse.json({ authenticated: Boolean(login), login });
}
