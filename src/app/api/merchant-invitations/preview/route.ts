import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import {
  isSameOriginRequest,
  merchantJson,
  merchantNotFoundResponse,
  readMerchantJson,
} from "@/lib/merchant-invitation/http";
import { guardInvitationRequest } from "@/lib/merchant-invitation/guard";
import { previewMerchantInvitation } from "@/lib/merchant-invitation/service";

/**
 * Read-only invitation preview.
 *
 * The token arrives in the POST body, never in the URL. This handler performs
 * no writes to the invitation, so opening, refreshing or prefetching the
 * invitation page cannot consume it. Invalid, expired, revoked and consumed
 * invitations all receive the same generic rejection.
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
  const result = await guardInvitationRequest({
    execute: (statement) => getTransactionDb().execute(statement),
    scope: "invitation_preview",
    token: rawToken,
    inspect: () => previewMerchantInvitation(getTransactionDb(), rawToken),
  });

  if (result.status === "rejected") return merchantJson(REJECTED, 400);

  if (result.status === "rate_limited") {
    return merchantJson(
      { ok: false, code: "RATE_LIMITED" },
      429,
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }

  if (result.status === "unavailable") {
    console.error(
      "Invitation preview is temporarily unavailable; returning a generic failure.",
    );
    return merchantJson({ ok: false, code: "UNAVAILABLE" }, 503);
  }

  return merchantJson({
    ok: true,
    email: result.preview.invitedEmail,
    storeName: result.preview.storeName,
  });
}
