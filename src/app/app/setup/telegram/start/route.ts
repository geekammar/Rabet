import { startMerchantTelegramConnection } from "@/app/actions/merchant-telegram";
import {
  buildAndroidTelegramLaunchTarget,
  buildTelegramLaunchFallbackUrl,
  isAndroidUserAgent,
} from "@/components/merchant/telegram-official-launch";
import {
  isSameOriginRequest,
  trustedApplicationOrigin,
} from "@/lib/merchant-invitation/http";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
} as const;

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE_HEADERS, Location: location },
  });
}

/**
 * Starts a Managed Bot attempt for the signed-in merchant.
 *
 * Android submits a real form here instead of calling the Server Action from
 * JavaScript. The browser therefore keeps the tap's user gesture through this
 * redirect, so Chrome can honour the package-targeted intent for official
 * Telegram. Creating the attempt and the launch remain one tap.
 *
 * A failure or a missing official Telegram app stays on the same Nokmel setup
 * attempt: the intent's fallback URL returns here with a notice, and the
 * generic t.me link is never used on Android.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return new Response("Forbidden", {
      status: 403,
      headers: NO_STORE_HEADERS,
    });
  }

  const origin = trustedApplicationOrigin();

  if (!origin) {
    return new Response("Telegram connection is not configured.", {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }

  const result = await startMerchantTelegramConnection();
  const setupUrl = new URL("/app/setup", origin);

  if (!result.ok || !result.deepLink) {
    setupUrl.hash = `telegram-start-error=${
      result.ok ? "OPERATION_FAILED" : result.error
    }`;
    return redirectTo(setupUrl.toString());
  }

  if (isAndroidUserAgent(request.headers.get("user-agent"))) {
    return redirectTo(
      buildAndroidTelegramLaunchTarget(
        result.deepLink,
        buildTelegramLaunchFallbackUrl(origin),
      ),
    );
  }

  return redirectTo(result.deepLink);
}
