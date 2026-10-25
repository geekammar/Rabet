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
} from "@/lib/data/seller-inbox";
import { createFetchTelegramTransport } from "@/lib/telegram/transport";
import type { TelegramTransport } from "@/lib/telegram/types";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InquiryActionResult<T = unknown> {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
  data?: T;
}

export interface SendReplyActionInput {
  inquiryId: string;
  body: string;
  clientOperationId?: string;
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
 * 2. Server-side UUID and body validation.
 * 3. Atomic DB reservation before Telegram send.
 * 4. Idempotent submission via stable operation UUID.
 * 5. Honest delivery tracking and safe diagnostics.
 */
export async function sendSellerReplyAction(
  input: SendReplyActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  const inquiryId = input.inquiryId?.trim();
  if (!inquiryId || !UUID_REGEX.test(inquiryId)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }

  const rawBody = input.body;
  if (typeof rawBody !== "string" || rawBody.trim().length === 0) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Reply message cannot be empty or whitespace-only.",
    };
  }

  let operationId: string | undefined;
  if (input.clientOperationId) {
    const trimmedOpId = input.clientOperationId.trim();
    if (!UUID_REGEX.test(trimmedOpId)) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "Client operation ID must be a valid UUID.",
      };
    }
    operationId = trimmedOpId;
  }

  try {
    const db = overrides?.db ?? getDb();
    const transport = resolveTransport(overrides?.transport);

    const result = await sendSellerReply(db, transport, {
      inquiryId,
      body: rawBody,
      operationId,
    });

    revalidatePath("/inquiries");
    revalidatePath(`/inquiries/${inquiryId}`);

    if (!result.success) {
      return {
        success: false,
        code: "DELIVERY_FAILED",
        message: `Reply was recorded but delivery failed (${result.error ?? "Telegram error"}). You may retry sending.`,
        data: result.message,
      };
    }

    return {
      success: true,
      message: result.alreadyReserved
        ? "Reply was already processed."
        : "Reply sent successfully.",
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
 */
export async function retrySellerReplyAction(
  input: RetryReplyActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  const inquiryId = input.inquiryId?.trim();
  const sourceMessageId = input.sourceMessageId?.trim();

  if (!inquiryId || !UUID_REGEX.test(inquiryId)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }

  if (!sourceMessageId || !UUID_REGEX.test(sourceMessageId)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid source message ID is required.",
    };
  }

  try {
    const db = overrides?.db ?? getDb();
    const transport = resolveTransport(overrides?.transport);

    const result = await retrySellerReply(db, transport, {
      inquiryId,
      sourceMessageId,
    });

    revalidatePath("/inquiries");
    revalidatePath(`/inquiries/${inquiryId}`);

    if (!result.success) {
      return {
        success: false,
        code: "DELIVERY_FAILED",
        message: `Retry was recorded but delivery failed (${result.error ?? "Telegram error"}).`,
        data: result.message,
      };
    }

    return {
      success: true,
      message: result.alreadyReserved
        ? "Retry was already sent."
        : "Reply retried successfully.",
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
 * 3. Reopen conflict checks under lock.
 */
export async function transitionInquiryStatusAction(
  input: TransitionStatusActionInput,
  overrides?: ActionTestOverrides,
): Promise<InquiryActionResult> {
  await requireAdmin();

  const inquiryId = input.inquiryId?.trim();
  if (!inquiryId || !UUID_REGEX.test(inquiryId)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "Valid inquiry ID is required.",
    };
  }

  const validStatuses: InquiryLifecycleTargetStatus[] = [
    "open",
    "resolved",
    "closed",
  ];
  if (!validStatuses.includes(input.targetStatus)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid target status "${input.targetStatus}".`,
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
      message: `Inquiry successfully ${label}.`,
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
