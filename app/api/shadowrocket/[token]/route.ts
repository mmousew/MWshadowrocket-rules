import { NextRequest } from "next/server";
import { GET as getClashSubscription } from "../../clash/[token]/route";

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const url = new URL(request.url);
  url.searchParams.set("format", "shadowrocket");
  return getClashSubscription(new NextRequest(url, request), context);
}
