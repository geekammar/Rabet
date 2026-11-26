"use server";

import { refresh, revalidatePath } from "next/cache";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  checkMerchantNotificationBotPairing,
  connectMerchantNotificationBot,
  disconnectMerchantNotificationBot,
  sendMerchantNotificationBotTest,
  startMerchantNotificationBotPairing,
  type MerchantNotificationBotResult,
} from "@/lib/merchant/notification-bot";

export type MerchantNotificationBotActionResult = MerchantNotificationBotResult;

function safeCategory(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)) {
    return error.name;
  }

  return "unknown";
}

function logActionFailure(phase: string, error: unknown): void {
  console.error("[merchant-notification-bot] action failed", {
    phase,
    category: safeCategory(error),
  });
}

function submittedRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Validates and stores the signed-in merchant's notification bot token.
 *
 * The enablement gate and merchant eligibility are re-read on every call. The
 * store always comes from the verified session; the action payload can only
 * carry the token. The result contains a short-lived pairing link, never the
 * token or its ciphertext.
 */
export async function connectMerchantNotificationBotAction(
  input: unknown,
): Promise<MerchantNotificationBotActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access || access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const result = await connectMerchantNotificationBot(
      getTransactionDb(),
      access,
      { token: submittedRecord(input).token },
    );

    if (result.ok) {
      revalidatePath("/app/setup");
      refresh();
    }

    return result;
  } catch (error) {
    logActionFailure("connect", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Replaces the current pairing challenge and returns a fresh short-lived
 * deep link for the already connected bot.
 */
export async function startMerchantNotificationBotPairingAction(): Promise<MerchantNotificationBotActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access || access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const result = await startMerchantNotificationBotPairing(
      getTransactionDb(),
      access,
    );

    if (result.ok) {
      revalidatePath("/app/setup");
      refresh();
    }

    return result;
  } catch (error) {
    logActionFailure("pairing_start", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Checks Telegram for the private chat that sent the current pairing code.
 * The store and code digest come from the server row, not the payload.
 */
export async function checkMerchantNotificationBotPairingAction(): Promise<MerchantNotificationBotActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access || access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const result = await checkMerchantNotificationBotPairing(
      getTransactionDb(),
      access,
    );

    if (result.ok) {
      revalidatePath("/app/setup");
      refresh();
    }

    return result;
  } catch (error) {
    logActionFailure("pairing_check", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Sends a test notification to the paired chat and records verification only
 * when Telegram accepted the message for the same destination and bot.
 */
export async function sendMerchantNotificationBotTestAction(
  input: unknown,
): Promise<MerchantNotificationBotActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access || access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const result = await sendMerchantNotificationBotTest(
      getTransactionDb(),
      access,
      { locale: submittedRecord(input).locale },
    );

    if (result.ok) {
      revalidatePath("/app/setup");
      refresh();
    }

    return result;
  } catch (error) {
    logActionFailure("test_send", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/**
 * Disconnects the store's notification bot and deletes the encrypted token.
 */
export async function disconnectMerchantNotificationBotAction(): Promise<MerchantNotificationBotActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access || access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  try {
    const result = await disconnectMerchantNotificationBot(
      getTransactionDb(),
      access,
    );

    if (result.ok) {
      revalidatePath("/app/setup");
      refresh();
    }

    return result;
  } catch (error) {
    logActionFailure("disconnect", error);
    return { ok: false, error: "OPERATION_FAILED" };
  }
}
