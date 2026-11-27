import { resumeMerchantNotificationBotManagedAction } from "@/app/actions/merchant-notification-bot";
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

async function submittedAttemptId(request: Request): Promise<string | null> {
  try {
    const form = await request.formData();
    const value = form.get("attemptId");

    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Resumes the stored notification-bot proposal for the signed-in merchant.
 *
 * This is a separate server-side intent from creating a bot. The browser may
 * only select a proposal by attempt id; the authenticated session, store and
 * stored notification-bot purpose remain authoritative. A resume request never
 * creates an attempt and never returns a manager create link.
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

  const attemptId = await submittedAttemptId(request);
  const result = await resumeMerchantNotificationBotManagedAction({
    attemptId,
  });
  const setupUrl = new URL("/app/setup", origin);

  if (!result.ok) {
    setupUrl.hash = `notification-bot-resume-error=${result.error}`;
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
