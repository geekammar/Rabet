"use server";

import { revalidatePath, refresh } from "next/cache";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  saveMerchantStoreLanguage,
  type MerchantStoreLanguageResult,
} from "@/lib/merchant/store-language";

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
