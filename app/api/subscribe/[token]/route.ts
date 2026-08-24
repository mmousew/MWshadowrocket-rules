import { NextRequest } from "next/server";
import { GET as getClashSubscription } from "../../clash/[token]/route";

/**
 * One public subscription URL for both Clash and Shadowrocket.
 * The downstream route selects the output from the requesting client's
 * User-Agent. No format query is added here, so a copied URL stays unified.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const url = new URL(request.url);
  url.searchParams.delete("format");
  return getClashSubscription(new NextRequest(url, request), context);
}
