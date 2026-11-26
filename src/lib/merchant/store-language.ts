import "server-only";

import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { storeLanguageSetting } from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  BUYER_LOCALE_META,
  isBuyerLocale,
  type BuyerLocale,
} from "@/lib/commerce/buyer-language";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";

export type MerchantStoreLanguageResult =
  | { ok: true; code: BuyerLocale; label: string }
  | { ok: false; error: "UNAVAILABLE" | "DENIED" | "INVALID_LANGUAGE" };

/**
 * Saves the authenticated merchant's default buyer UI language.
 *
 * The write re-checks the same database-backed eligibility rule as the request
 * that rendered the form, so a suspended store, revoked membership, stale
 * session version or disabled user cannot save through an already-open page.
 * Only the server-minted store scope and the Arabic/English locale cross this
 * boundary; no submitted store id is read.
 *
 * The locale is stored as data on the store's own row. This function never
 * inserts, enables, disables or modifies a global catalog `language` row.
 */
export async function saveMerchantStoreLanguage(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: { code: unknown },
): Promise<MerchantStoreLanguageResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  if (!isBuyerLocale(input.code)) {
    return { ok: false, error: "INVALID_LANGUAGE" };
  }

  const code = input.code;
  const meta = BUYER_LOCALE_META[code];

  try {
    return await db.transaction(async (tx) => {
      const eligibility = await resolveMerchantEligibility(
        tx as unknown as TransactionDatabase,
        {
          userId: access.userId,
          sessionVersion: access.sessionVersion,
        },
      );

      if (
        !eligibility ||
        eligibility.readOnly ||
        eligibility.store.id !== access.scope.storeId
      ) {
        return { ok: false, error: "DENIED" } as const;
      }

      await tx
        .insert(storeLanguageSetting)
        .values({
          storeId: access.scope.storeId,
          locale: code,
        })
        .onConflictDoUpdate({
          target: storeLanguageSetting.storeId,
          set: {
            locale: code,
            updatedAt: new Date(),
          },
        });

      return { ok: true, code, label: meta.label } as const;
    });
  } catch {
    console.error("Merchant store language update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
