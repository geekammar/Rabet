import "server-only";

import { eq } from "drizzle-orm";

import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { language, storeLanguageSetting } from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import { isBuyerLocale, type BuyerLocale } from "@/lib/commerce/buyer-language";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";

export type MerchantStoreLanguageResult =
  | { ok: true; code: BuyerLocale; label: string }
  | { ok: false; error: "UNAVAILABLE" | "DENIED" | "INVALID_LANGUAGE" };

const LANGUAGE_META: Record<BuyerLocale, { label: string; textDirection: "ltr" | "rtl" }> = {
  ar: { label: "العربية", textDirection: "rtl" },
  en: { label: "English", textDirection: "ltr" },
};

/**
 * Saves the authenticated merchant's default customer language.
 *
 * The write re-checks the same database-backed eligibility rule as the request
 * that rendered the form, so a suspended store, revoked membership, stale
 * session version or disabled user cannot save through an already-open page.
 * Only the server-minted store scope and the Arabic/English code cross this
 * boundary; no submitted store id is read.
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
  const meta = LANGUAGE_META[code];

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

      const [inserted] = await tx
        .insert(language)
        .values({
          code,
          label: meta.label,
          textDirection: meta.textDirection,
          isEnabled: true,
        })
        .onConflictDoNothing({ target: language.code })
        .returning({ id: language.id });

      let languageId = inserted?.id;

      if (!languageId) {
        const [existing] = await tx
          .select({ id: language.id, isEnabled: language.isEnabled })
          .from(language)
          .where(eq(language.code, code))
          .limit(1);

        if (!existing) {
          return { ok: false, error: "UNAVAILABLE" } as const;
        }

        if (!existing.isEnabled) {
          await tx
            .update(language)
            .set({ isEnabled: true })
            .where(eq(language.id, existing.id));
        }

        languageId = existing.id;
      }

      await tx
        .insert(storeLanguageSetting)
        .values({
          storeId: access.scope.storeId,
          defaultLanguageId: languageId,
        })
        .onConflictDoUpdate({
          target: storeLanguageSetting.storeId,
          set: {
            defaultLanguageId: languageId,
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
