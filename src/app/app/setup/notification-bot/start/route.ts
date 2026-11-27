import { startMerchantNotificationBotManagedAction } from "@/app/actions/merchant-notification-bot";
import {
  buildNotificationTelegramLaunchTarget,
  isAndroidUserAgent,
} from "@/components/merchant/telegram-official-launch";
import {
  isSameOriginNavigationPost,
  trustedApplicationOrigin,
} from "@/lib/http/request-origin";

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
 * Starts the managed notification-bot onboarding for the signed-in merchant.
 *
 * The server creates a store-scoped attempt with the notification-bot purpose
 * and redirects to the manager bot. No token or bot identity comes from the
 * browser.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginNavigationPost(request)) {
    return new Response("Forbidden", {
      status: 403,
      headers: NO_STORE_HEADERS,
    });
  }

  const origin = trustedApplicationOrigin();

  if (!origin) {
    return new Response("Notification bot onboarding is not configured.", {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  }

  const result = await startMerchantNotificationBotManagedAction();
  const setupUrl = new URL("/app/setup", origin);

  if (!result.ok) {
    setupUrl.hash = `notification-bot-start-error=${result.error}`;
    return redirectTo(setupUrl.toString());
  }

  if (!result.managed?.deepLink) {
    return redirectTo(setupUrl.toString());
  }

  if (isAndroidUserAgent(request.headers.get("user-agent"))) {
    return redirectTo(
      buildNotificationTelegramLaunchTarget(result.managed.deepLink, origin),
    );
  }

  return redirectTo(result.managed.deepLink);
}
