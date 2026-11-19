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
import {
  acceptMerchantInvitation,
  MerchantInvitationError,
  previewMerchantInvitation,
} from "@/lib/merchant-invitation/service";

/**
 * Explicit invitation acceptance.
 *
 * Only a form submission reaches this handler. The token is in the JSON body
 * and is inspected (without hashing) before the Argon2 work starts. The
 * merged transactional service remains the final authority: it locks the
 * invitation, creates the account, credential and membership, and consumes
 * the invitation in one transaction. A second submission cannot create a
 * second membership.
 *
 * Every invitation-level rejection — invalid, expired, revoked, consumed or
 * already-registered email — returns the same generic response.
 */

const REJECTED = { ok: false, code: "INVITATION_REJECTED" } as const;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

type FieldErrors = {
  password?: "PASSWORD_LENGTH";
  passwordConfirmation?: "PASSWORD_MISMATCH";
};

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
  const password = typeof body.password === "string" ? body.password : "";
  const confirmation =
    typeof body.passwordConfirmation === "string"
      ? body.passwordConfirmation
      : "";

  const fieldErrors: FieldErrors = {};

  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    fieldErrors.password = "PASSWORD_LENGTH";
  }

  if (password !== confirmation) {
    fieldErrors.passwordConfirmation = "PASSWORD_MISMATCH";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return merchantJson(
      { ok: false, code: "FIELD_ERROR", fieldErrors },
      400,
    );
  }

  const throttleKey = merchantThrottleKey(
    rawToken.length <= 512 ? rawToken : rawToken.slice(0, 512),
  );

  try {
    const attempt = await consumeMerchantThrottle(
      (statement) => getTransactionDb().execute(statement),
      { scope: "invitation_accept", key: throttleKey },
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
      "Invitation acceptance throttling is unavailable; denying the attempt.",
    );
    return merchantJson({ ok: false, code: "UNAVAILABLE" }, 503);
  }

  try {
    // Cheap pre-check: an unrecognized token never reaches Argon2. The
    // transactional service re-reads and locks the row and remains final.
    const preview = await previewMerchantInvitation(
      getTransactionDb(),
      rawToken,
    );

    if (!preview) return merchantJson(REJECTED, 400);

    await acceptMerchantInvitation(getTransactionDb(), {
      token: rawToken,
      password,
    });

    return merchantJson({ ok: true, redirectTo: "/app/login" });
  } catch (error) {
    if (error instanceof MerchantInvitationError) {
      return merchantJson(REJECTED, 400);
    }

    console.error(
      "Invitation acceptance failed unexpectedly; returning a generic failure.",
    );
    return merchantJson({ ok: false, code: "UNAVAILABLE" }, 503);
  }
}
