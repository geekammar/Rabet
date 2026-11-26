"use server";

import { refresh, revalidatePath } from "next/cache";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  acceptMerchantOrder,
  cancelMerchantOrder,
  collectMerchantOrderPayment,
  handMerchantOrderToShipping,
  markMerchantOrderDelivered,
  prepareMerchantOrder,
  rejectVodafoneCashTransfer,
  verifyVodafoneCashTransfer,
  type MerchantOrderMutationResult,
  type MerchantTransferDecisionResult,
} from "@/lib/commerce/orders";
import { normalizeCancellationReason } from "@/lib/commerce/order-state";

export type MerchantOrderActionCode =
  | "UNAVAILABLE"
  | "DENIED"
  | "INVALID_INPUT"
  | "INVALID_REASON"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "ALREADY_APPLIED"
  | "ACCEPTED"
  | "PREPARED"
  | "HANDED_TO_SHIPPING"
  | "DELIVERED"
  | "COLLECTED"
  | "TRANSFER_VERIFIED"
  | "TRANSFER_REJECTED"
  | "INVALID_NOTE"
  | "CANCELLED"
  | "DATABASE_ERROR";

export type MerchantOrderActionState = {
  success: boolean;
  code: MerchantOrderActionCode;
  orderId?: string;
  status?: string;
  fulfillmentStatus?: string;
  paymentStatus?: string;
  releasedQuantity?: number;
  shippedQuantity?: number;
  claimStatus?: string;
};

const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actionStateFromResult(
  result: MerchantOrderMutationResult,
  successCode:
    | "ACCEPTED"
    | "PREPARED"
    | "HANDED_TO_SHIPPING"
    | "DELIVERED"
    | "COLLECTED"
    | "CANCELLED",
): MerchantOrderActionState {
  switch (result.status) {
    case "accepted":
    case "preparing":
    case "handed_to_shipping":
    case "delivered":
    case "collected":
    case "cancelled": {
      const state: MerchantOrderActionState = {
        success: true,
        code: successCode,
        orderId: result.orderId,
        status: result.orderStatus,
        fulfillmentStatus: result.fulfillmentStatus,
        releasedQuantity: result.releasedQuantity,
      };
      if (result.paymentStatus !== undefined) {
        state.paymentStatus = result.paymentStatus;
      }
      if (result.shippedQuantity !== undefined) {
        state.shippedQuantity = result.shippedQuantity;
      }
      return state;
    }
    case "already_applied": {
      const state: MerchantOrderActionState = {
        success: true,
        code: "ALREADY_APPLIED",
        orderId: result.orderId,
        status: result.orderStatus,
        fulfillmentStatus: result.fulfillmentStatus,
        releasedQuantity: result.releasedQuantity,
      };
      if (result.paymentStatus !== undefined) {
        state.paymentStatus = result.paymentStatus;
      }
      if (result.shippedQuantity !== undefined) {
        state.shippedQuantity = result.shippedQuantity;
      }
      return state;
    }
    case "not_found":
      return { success: false, code: "NOT_FOUND" };
    case "invalid_transition":
      return {
        success: false,
        code: "INVALID_TRANSITION",
        status: result.currentStatus,
        fulfillmentStatus: result.fulfillmentStatus,
      };
    case "invalid_reason":
      return { success: false, code: "INVALID_REASON" };
  }
}

function readOrderId(value: unknown): string | null {
  return typeof value === "string" && ORDER_ID_PATTERN.test(value) ? value : null;
}

function transferDecisionState(
  result: MerchantTransferDecisionResult,
  successCode: "TRANSFER_VERIFIED" | "TRANSFER_REJECTED",
): MerchantOrderActionState {
  switch (result.status) {
    case "verified":
    case "rejected": {
      return {
        success: true,
        code: successCode,
        orderId: result.orderId,
        status: result.orderStatus,
        fulfillmentStatus: result.fulfillmentStatus,
        paymentStatus: result.paymentStatus,
        releasedQuantity: result.releasedQuantity,
        claimStatus: result.claimStatus,
      };
    }
    case "already_applied":
      return {
        success: true,
        code: "ALREADY_APPLIED",
        orderId: result.orderId,
        status: result.orderStatus,
        fulfillmentStatus: result.fulfillmentStatus,
        paymentStatus: result.paymentStatus,
        releasedQuantity: result.releasedQuantity,
        claimStatus: result.claimStatus,
      };
    case "not_found":
      return { success: false, code: "NOT_FOUND" };
    case "invalid_transition":
      return {
        success: false,
        code: "INVALID_TRANSITION",
        status: result.currentStatus,
        paymentStatus: result.paymentStatus,
      };
    case "invalid_note":
      return { success: false, code: "INVALID_NOTE" };
  }
}

function refreshOrdersPage(): void {
  revalidatePath("/app/orders");
  revalidatePath("/app/setup");
  refresh();
}

export async function acceptMerchantOrderAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await acceptMerchantOrder(
      getTransactionDb(),
      access.scope,
      orderId,
    );
    const state = actionStateFromResult(result, "ACCEPTED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function prepareMerchantOrderAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await prepareMerchantOrder(
      getTransactionDb(),
      access.scope,
      orderId,
    );
    const state = actionStateFromResult(result, "PREPARED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function handMerchantOrderToShippingAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await handMerchantOrderToShipping(
      getTransactionDb(),
      access.scope,
      orderId,
    );
    const state = actionStateFromResult(result, "HANDED_TO_SHIPPING");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function markMerchantOrderDeliveredAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await markMerchantOrderDelivered(
      getTransactionDb(),
      access.scope,
      orderId,
    );
    const state = actionStateFromResult(result, "DELIVERED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function collectMerchantOrderPaymentAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await collectMerchantOrderPayment(
      getTransactionDb(),
      access.scope,
      orderId,
    );
    const state = actionStateFromResult(result, "COLLECTED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function cancelMerchantOrderAction(
  input: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const orderId = readOrderId(submitted.orderId);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  if (!normalizeCancellationReason(submitted.reason)) {
    return { success: false, code: "INVALID_REASON" };
  }

  try {
    const result = await cancelMerchantOrder(
      getTransactionDb(),
      access.scope,
      { orderId, reason: submitted.reason },
    );
    const state = actionStateFromResult(result, "CANCELLED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function verifyVodafoneCashTransferAction(
  orderIdInput: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const orderId = readOrderId(orderIdInput);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await verifyVodafoneCashTransfer(
      getTransactionDb(),
      access.scope,
      { orderId, actorUserId: access.userId },
    );
    const state = transferDecisionState(result, "TRANSFER_VERIFIED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}

export async function rejectVodafoneCashTransferAction(
  input: unknown,
): Promise<MerchantOrderActionState> {
  if (!isMerchantAppEnabled()) {
    return { success: false, code: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();
  if (!access || access.readOnly) {
    return { success: false, code: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const orderId = readOrderId(submitted.orderId);
  if (!orderId) return { success: false, code: "INVALID_INPUT" };

  try {
    const result = await rejectVodafoneCashTransfer(
      getTransactionDb(),
      access.scope,
      { orderId, actorUserId: access.userId, note: submitted.note },
    );
    const state = transferDecisionState(result, "TRANSFER_REJECTED");
    if (state.success) refreshOrdersPage();
    return state;
  } catch {
    return { success: false, code: "DATABASE_ERROR" };
  }
}
