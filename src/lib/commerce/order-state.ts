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

export type MerchantOrderNextAction =
  | "accept"
  | "prepare"
  | "hand_to_shipping"
  | "deliver"
  | "collect_cod";

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
 * The one normal next action still available from the current state. An order
 * that is already collected, failed, or cancelled has no next step.
 */
export function nextMerchantOrderAction(
  status: string,
  fulfillmentStatus: string,
  paymentStatus = "awaiting_collection",
  paymentMethod = "cod",
): MerchantOrderNextAction | null {
  if (status === "cancelled" || fulfillmentStatus === "cancelled") return null;

  if (fulfillmentStatus === "unfulfilled") {
    if (status === "placed") return "accept";
    if (status === "accepted") return "prepare";
    if (
      status === "preparing" &&
      canHandMerchantOrderToShipping(
        status,
        fulfillmentStatus,
        paymentMethod,
        paymentStatus,
      )
    ) {
      return "hand_to_shipping";
    }
    return null;
  }

  if (fulfillmentStatus === "handed_to_shipping") return "deliver";

  if (fulfillmentStatus === "delivered" && paymentMethod === "cod") {
    return paymentStatus === "awaiting_collection" ? "collect_cod" : null;
  }

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

/**
 * Handoff is the commit point for stock, so a manual-transfer order may only
 * be shipped after the merchant has verified the transfer. COD keeps its
 * existing pre-collection handoff behaviour.
 */
export function canHandMerchantOrderToShipping(
  status: string,
  fulfillmentStatus: string,
  paymentMethod = "cod",
  paymentStatus = "awaiting_collection",
): boolean {
  if (status !== "preparing" || fulfillmentStatus !== "unfulfilled") {
    return false;
  }

  return (
    paymentMethod === "cod" || paymentStatus === "transfer_verified"
  );
}

/**
 * Clear, channel-independent state for a buyer-reported transfer that still
 * needs a merchant decision. A future Needs Attention integration can consume
 * this without depending on Telegram or any provider automation.
 */
export function isTransferAwaitingReview(
  paymentStatus: string,
  paymentMethod = "vodafone_cash",
): boolean {
  return (
    paymentMethod === "vodafone_cash" &&
    paymentStatus === "transfer_awaiting_review"
  );
}

export function canMarkMerchantOrderDelivered(
  _status: string,
  fulfillmentStatus: string,
): boolean {
  return fulfillmentStatus === "handed_to_shipping";
}

export function canRecordMerchantOrderCollection(
  fulfillmentStatus: string,
  paymentStatus: string,
): boolean {
  return (
    fulfillmentStatus === "delivered" && paymentStatus === "awaiting_collection"
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
