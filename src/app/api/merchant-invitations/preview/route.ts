import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import {
  consumeMerchantThrottle,
  merchantThrottleKey,
} from "@/lib/auth/merchant-throttle";
import {
  isSameOriginRequest,
  merchantJson,
  merchantNotFoundResponse,
  readMerchantJson,
} from "@/lib/merchant-invitation/http";
import { previewMerchantInvitation } from "@/lib/merchant-invitation/service";

/**
 * Read-only invitation preview.
 *
 * The token arrives in the POST body, never in the URL. This handler performs
 * no writes, so opening, refreshing or prefetching the invitation page cannot
 * consume the invitation. Invalid, expired, revoked and consumed invitations
 * all receive the same generic rejection.
 */

const REJECTED = { ok: false, code: "INVITATION_REJECTED" } as const;

export async function POST(request: Request): Promise<Response> {
  if (!isMerchantAppEnabled()) return merchantNotFoundResponse();

  if (!isSameOriginRequest(request)) {
    return merchantJson({ ok: false, code: "INVALID_REQUEST" }, 403);
  }

  const body = await readMerchantJson(request);

  if (!body) {
    return merchantJson({ ok: false, code: "INVALID_REQUEST" }, 400);
  }

  const rawToken = typeof body.token === "string" ? body.token : "";
  const throttleKey = merchantThrottleKey(
    rawToken.length <= 512 ? rawToken : rawToken.slice(0, 512),
  );

  try {
    const attempt = await consumeMerchantThrottle(
      (statement) => getTransactionDb().execute(statement),
      { scope: "invitation_preview", key: throttleKey },
    );

    if (!attempt.allowed) {
      return merchantJson(
        { ok: false, code: "RATE_LIMITED" },
        429,
        { "Retry-After": String(attempt.retryAfterSeconds) },
      );
    }
  } catch {
    console.error(
      "Invitation preview throttling is unavailable; denying the preview.",
    );
    return merchantJson({ ok: false, code: "UNAVAILABLE" }, 503);
  }

  try {
    const preview = await previewMerchantInvitation(
      getTransactionDb(),
      rawToken,
    );

    if (!preview) return merchantJson(REJECTED, 400);

    return merchantJson({
      ok: true,
      email: preview.invitedEmail,
      storeName: preview.storeName,
    });
  } catch {
    console.error(
      "Invitation preview could not be read; returning a generic failure.",
    );
    return merchantJson({ ok: false, code: "UNAVAILABLE" }, 503);
  }
}
