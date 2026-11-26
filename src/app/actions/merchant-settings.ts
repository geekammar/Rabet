"use server";

import { revalidatePath, refresh } from "next/cache";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  saveMerchantStoreLanguage,
  type MerchantStoreLanguageResult,
} from "@/lib/merchant/store-language";
import {
  saveMerchantTelegramSupport,
  type MerchantTelegramSupportResult,
} from "@/lib/merchant/store-telegram-contact";
import {
  saveMerchantVodafoneCash,
  type MerchantVodafoneCashResult,
} from "@/lib/merchant/store-vodafone-cash";

/**
 * Saves the signed-in merchant's default buyer language for their own store.
 *
 * The enablement gate and merchant eligibility are re-read on every call, so a
 * stale page cannot write after revocation, suspension or a session-version
 * change. Only the submitted `code` is used; the store comes from the verified
 * session scope.
 */
export async function saveMerchantStoreLanguageAction(
  input: unknown,
): Promise<MerchantStoreLanguageResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const result = await saveMerchantStoreLanguage(getTransactionDb(), access, {
    code: submitted.code,
  });

  if (result.ok) {
    revalidatePath("/app/setup");
    refresh();
  }

  return result;
}

/**
 * Saves or clears the signed-in merchant's Telegram support account.
 *
 * The store comes from the verified session scope, never from the submitted
 * payload. The enablement gate, eligibility and read-only status are re-read on
 * every call, and the write layer repeats the same checks inside its
 * transaction before updating the row.
 */
export async function saveMerchantTelegramSupportAction(
  input: unknown,
): Promise<MerchantTelegramSupportResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const result = await saveMerchantTelegramSupport(
    getTransactionDb(),
    access,
    { username: submitted.username },
  );

  if (result.ok) {
    revalidatePath("/app/setup");
    refresh();
  }

  return result;
}

/**
 * Saves the signed-in merchant's manual Vodafone Cash configuration.
 *
 * The store comes from the verified session scope, never from the submitted
 * payload. Read-only stores, revoked sessions and cross-store access are
 * rejected by the write layer inside its transaction.
 */
export async function saveMerchantVodafoneCashAction(
  input: unknown,
): Promise<MerchantVodafoneCashResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const result = await saveMerchantVodafoneCash(getTransactionDb(), access, {
    enabled: submitted.enabled,
    number: submitted.number,
    accountName: submitted.accountName,
    instructionsAr: submitted.instructionsAr,
    instructionsEn: submitted.instructionsEn,
  });

  if (result.ok) {
    revalidatePath("/app/setup");
    refresh();
  }

  return result;
}
