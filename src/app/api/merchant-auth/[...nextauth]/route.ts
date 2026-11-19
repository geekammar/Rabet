import type { NextRequest } from "next/server";

import { handlers } from "@/auth-merchant";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";

/**
 * Merchant Auth.js handler.
 *
 * This is a distinct path from the operator's `/api/auth/*` handler. The
 * default-off enablement gate runs before Auth.js can read a cookie, spend a
 * throttle attempt or verify a password. When the gate is off the route is
 * indistinguishable from a route that does not exist.
 */

function disabled(): Response {
  return new Response("Not found.\n", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function gated(
  handler: (request: NextRequest) => Promise<Response>,
): (request: NextRequest) => Promise<Response> {
  return async (request) =>
    isMerchantAppEnabled() ? handler(request) : disabled();
}

export const GET = gated(handlers.GET);
export const POST = gated(handlers.POST);
