"use server";

import { revalidatePath } from "next/cache";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import { RabetDataError, toSafeErrorMessage } from "@/lib/data/errors";
import {
  retrySellerReply,
  sendSellerReply,
  transitionInquiryStatus,
  type InquiryLifecycleTargetStatus,
  type SellerDeliveryOutcome,
} from "@/lib/data/seller-inbox";
import { createFetchTelegramTransport } from "@/lib/telegram/transport";
import type { TelegramTransport } from "@/lib/telegram/types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InquiryActionResult<T = unknown> {
  success: boolean;
  outcome?: SellerDeliveryOutcome;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  data?: T;
  reserved?: boolean;
}

export interface SendReplyActionInput {
  inquiryId: string;
  body: string;
  clientOperationId: string;
}

export interface RetryReplyActionInput {
  inquiryId: string;
  sourceMessageId: string;
}

export interface TransitionStatusActionInput {
  inquiryId: string;
  targetStatus: InquiryLifecycleTargetStatus;
}

export interface ActionTestOverrides {
  db?: Database;
  transport?: TelegramTransport;
}

function resolveTransport(override?: TelegramTransport): TelegramTransport {
  if (override) {
    return override;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "Telegram bot token is not configured. Reply cannot be dispatched.",
    );
  }
  return createFetchTelegramTransport(token);
}

/**
 * Sends a plain-text seller reply to an active customer inquiry.
 *
 * Enforces:
 * 1. requireAdmin() called first before DB or network operations.
 * 2. Server-side UUID, payload shape, and body validation.
 * 3. Client operation ID is required and must be a valid UUID.
 * 4. Atomic DB reservation before Telegram send.
 * 5. Idempotent submission via stable operation UUID.
 * 6. Honest delivery tracking distinguishing confirmed sent, failed, pending, and unconfirmed.
 */
export async function sendSellerReplyAction(
  input: SendReplyActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      success: false,
      reserved: false,
      code: "INVALID_INPUT",
      message: "Payload must be a non-null object.",
    };
  }

  const payload = input as unknown as Record<string, unknown>;
  const rawInquiryId = payload.inquiryId;
  if (typeof rawInquiryId !== "string" || !UUID_REGEX.test(rawInquiryId.trim())) {
    return {
      success: false,
      reserved: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }
  const inquiryId = rawInquiryId.trim();

  const rawBody = payload.body;
  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    return {
      success: false,
      reserved: false,
      code: "INVALID_INPUT",
      message: "Reply message cannot be empty or whitespace-only.",
    };
  }

  const rawOpId = payload.clientOperationId;
  if (typeof rawOpId !== "string" || !UUID_REGEX.test(rawOpId.trim())) {
    return {
      success: false,
      reserved: false,
      code: "INVALID_INPUT",
      message: "Client operation ID is required and must be a valid UUID.",
    };
  }
  const operationId = rawOpId.trim();

  try {
    let transport: TelegramTransport;
    try {
      transport = resolveTransport(overrides?.transport);
    } catch (err) {
      if (err instanceof RabetDataError) {
        return {
          success: false,
          reserved: false,
          code: err.code,
          message: err.message,
        };
      }
      throw err;
    }

    const db = overrides?.db ?? getDb();

    const result = await sendSellerReply(db, transport, {
      inquiryId,
      body: rawBody,
      operationId,
    });

    revalidatePath("/inquiries");
    revalidatePath(`/inquiries/${inquiryId}`);

    if (result.outcome === "confirmed_sent") {
      return {
        success: true,
        reserved: true,
        outcome: "confirmed_sent",
        message: result.alreadyReserved
          ? "Reply was already sent successfully."
          : "Reply sent successfully.",
        data: result.message,
      };
    }

    if (result.outcome === "recorded_pending") {
      return {
        success: false,
        reserved: true,
        outcome: "recorded_pending",
        code: "DELIVERY_PENDING",
        message: "Reply is already recorded and pending delivery.",
        data: result.message,
      };
    }

    if (result.outcome === "unconfirmed_outcome") {
      return {
        success: false,
        reserved: true,
        outcome: "unconfirmed_outcome",
        code: "DELIVERY_UNCONFIRMED",
        message: `Delivery status is unconfirmed (${result.error}). The message may have reached the customer.`,
        data: result.message,
      };
    }

    return {
      success: false,
      reserved: true,
      outcome: "confirmed_failed",
      code: "DELIVERY_FAILED",
      message: `Reply was recorded but delivery failed (${result.error ?? "Telegram error"}). You may retry sending.`,
      data: result.message,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "INTERNAL_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Retries sending an existing failed or stale-pending seller reply.
 *
 * Enforces:
 * 1. requireAdmin() called first.
 * 2. Deterministic retry ID derivation.
 * 3. Source message validation.
 * 4. Active conversation status.
 * 5. Honest outcome reporting (distinguishing sent, pending, failed, unconfirmed).
 */
export async function retrySellerReplyAction(
  input: RetryReplyActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Payload must be a non-null object.",
    };
  }

  const payload = input as unknown as Record<string, unknown>;
  const rawInquiryId = payload.inquiryId;
  if (typeof rawInquiryId !== "string" || !UUID_REGEX.test(rawInquiryId.trim())) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }
  const inquiryId = rawInquiryId.trim();

  const rawSourceMsgId = payload.sourceMessageId;
  if (
    typeof rawSourceMsgId !== "string" ||
    !UUID_REGEX.test(rawSourceMsgId.trim())
  ) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid source message ID is required.",
    };
  }
  const sourceMessageId = rawSourceMsgId.trim();

  try {
    const db = overrides?.db ?? getDb();
    const transport = resolveTransport(overrides?.transport);

    const result = await retrySellerReply(db, transport, {
      inquiryId,
      sourceMessageId,
    });

    revalidatePath("/inquiries");
    revalidatePath(`/inquiries/${inquiryId}`);

    if (result.outcome === "confirmed_sent") {
      return {
        success: true,
        outcome: "confirmed_sent",
        message: result.alreadyReserved
          ? "Retry was already sent successfully."
          : "Reply retried successfully.",
        data: result.message,
      };
    }

    if (result.outcome === "recorded_pending") {
      return {
        success: false,
        outcome: "recorded_pending",
        code: "DELIVERY_PENDING",
        message: "Retry is already in progress and pending delivery.",
        data: result.message,
      };
    }

    if (result.outcome === "unconfirmed_outcome") {
      return {
        success: false,
        outcome: "unconfirmed_outcome",
        code: "DELIVERY_UNCONFIRMED",
        message: `Delivery status is unconfirmed (${result.error}). The message may have reached the customer.`,
        data: result.message,
      };
    }

    return {
      success: false,
      outcome: "confirmed_failed",
      code: "DELIVERY_FAILED",
      message: `Retry was recorded but delivery failed (${result.error ?? "Telegram error"}).`,
      data: result.message,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "INTERNAL_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Transitions an inquiry's lifecycle status (resolve, close, or reopen).
 *
 * Enforces:
 * 1. requireAdmin() called first.
 * 2. Strict transition allowlist.
 * 3. Authoritative concurrency protection under locks.
 * 4. Explicit distinction between actual transition and already-at-target requests.
 */
export async function transitionInquiryStatusAction(
  input: TransitionStatusActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Payload must be a non-null object.",
    };
  }

  const payload = input as unknown as Record<string, unknown>;
  const rawInquiryId = payload.inquiryId;
  if (typeof rawInquiryId !== "string" || !UUID_REGEX.test(rawInquiryId.trim())) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }
  const inquiryId = rawInquiryId.trim();

  const validStatuses: InquiryLifecycleTargetStatus[] = [
    "open",
    "resolved",
    "closed",
  ];
  if (!validStatuses.includes(input.targetStatus)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid target status "${String(input.targetStatus)}".`,
    };
  }

  try {
    const db = overrides?.db ?? getDb();

    const updated = await transitionInquiryStatus(db, {
      inquiryId,
      targetStatus: input.targetStatus,
    });

    revalidatePath("/inquiries");
    revalidatePath(`/inquiries/${inquiryId}`);

    const label =
      input.targetStatus === "open"
        ? "reopened"
        : input.targetStatus === "resolved"
          ? "resolved"
          : "closed";

    return {
      success: true,
      message: updated.alreadyAtTarget
        ? `Inquiry is already ${label}.`
        : `Inquiry successfully ${label}.`,
      data: updated,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }
    return {
      success: false,
      code: "INTERNAL_ERROR",
      message: toSafeErrorMessage(error),
    };
  }
}
