export type InvitationFailureState = "invalid" | "rate_limited" | "unavailable";

/**
 * Maps an invitation endpoint HTTP status to the public UI state.
 *
 * A rate limit and a temporary server/limiter outage are distinct from an
 * invalid invitation, so the screen must not tell a merchant that their link
 * is invalid when the failure is temporary.
 */
export function classifyInvitationFailure(
  status: number,
): InvitationFailureState {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "invalid";
}
