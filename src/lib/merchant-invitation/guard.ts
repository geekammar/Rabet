import "server-only";

import {
  consumeMerchantThrottle,
  merchantInvitationGlobalKey,
  merchantThrottleKey,
  type MerchantThrottleExecutor,
  type MerchantThrottleScope,
} from "@/lib/auth/merchant-throttle";
import type { MerchantInvitationPreview } from "@/lib/merchant-invitation/service";

export type InvitationGuardScope = Extract<
  MerchantThrottleScope,
  "invitation_preview" | "invitation_accept"
>;

export type InvitationGuardResult =
  | { status: "allowed"; preview: MerchantInvitationPreview }
  | { status: "rejected" }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "unavailable" };

/**
 * Applies the public invitation request boundary.
 *
 * Order is deliberate:
 * 1. Consume one coarse global invitation attempt.
 * 2. Inspect the token with a read-only lookup.
 * 3. Only a recognized, eligible invitation consumes a per-token attempt.
 *
 * Unknown, expired, revoked and consumed tokens therefore never create a
 * per-token throttle row and never reach the acceptance service or Argon2.
 * Any limiter or lookup failure is a closed door.
 */
export async function guardInvitationRequest(input: {
  execute: MerchantThrottleExecutor;
  scope: InvitationGuardScope;
  token: string;
  inspect: () => Promise<MerchantInvitationPreview | null>;
}): Promise<InvitationGuardResult> {
  let coarse;

  try {
    coarse = await consumeMerchantThrottle(input.execute, {
      scope: "invitation_global",
      key: merchantInvitationGlobalKey(),
    });
  } catch {
    return { status: "unavailable" };
  }

  if (!coarse.allowed) {
    return {
      status: "rate_limited",
      retryAfterSeconds: coarse.retryAfterSeconds,
    };
  }

  let preview: MerchantInvitationPreview | null;

  try {
    preview = await input.inspect();
  } catch {
    return { status: "unavailable" };
  }

  if (!preview) return { status: "rejected" };

  let scoped;

  try {
    scoped = await consumeMerchantThrottle(input.execute, {
      scope: input.scope,
      key: merchantThrottleKey(
        input.token.length <= 512 ? input.token : input.token.slice(0, 512),
      ),
    });
  } catch {
    return { status: "unavailable" };
  }

  if (!scoped.allowed) {
    return {
      status: "rate_limited",
      retryAfterSeconds: scoped.retryAfterSeconds,
    };
  }

  return { status: "allowed", preview };
}
