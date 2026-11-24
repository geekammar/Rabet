/**
 * Pure merchant order-workflow rules shared by the server mutation and the
 * phone Orders UI. Nothing here reads a database or an authorization fact.
 */

export const CANCELLATION_REASON_MIN_LENGTH = 3;
export const CANCELLATION_REASON_MAX_LENGTH = 300;

export type MerchantOrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "cancelled";

export type MerchantOrderNextAction = "accept" | "prepare";

export function isMerchantOrderStatus(
  value: string,
): value is MerchantOrderStatus {
  return (
    value === "placed" ||
    value === "accepted" ||
    value === "preparing" ||
    value === "cancelled"
  );
}

/**
 * The one normal pre-shipment action still available. A cancelled order, an
 * order already handed to shipping, and a preparing order have no next step in
 * this slice.
 */
export function nextMerchantOrderAction(
  status: string,
  fulfillmentStatus: string,
): MerchantOrderNextAction | null {
  if (fulfillmentStatus !== "unfulfilled") return null;
  if (status === "placed") return "accept";
  if (status === "accepted") return "prepare";
  return null;
}

/**
 * Cancellation is available only before shipment and before any stock is
 * committed. It remains available after acceptance and during preparation.
 */
export function canCancelMerchantOrder(
  status: string,
  fulfillmentStatus: string,
): boolean {
  return (
    fulfillmentStatus === "unfulfilled" &&
    (status === "placed" || status === "accepted" || status === "preparing")
  );
}

export function normalizeCancellationReason(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (
    trimmed.length < CANCELLATION_REASON_MIN_LENGTH ||
    trimmed.length > CANCELLATION_REASON_MAX_LENGTH
  ) {
    return null;
  }

  return trimmed;
}
