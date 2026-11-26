import "server-only";

import { and, eq } from "drizzle-orm";

import { botSetting, storeCommerceSetting } from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import type { Database } from "@/db/client";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import type { StoreScope } from "@/lib/data/store-scope";

/**
 * Store-scoped manual Vodafone Cash configuration.
 *
 * The transfer number, account name and instructions belong to one store and
 * are written only through the authenticated merchant scope. Enabling the
 * method does not activate provider automation or Telegram notifications: a
 * buyer claim still waits for the merchant's own review.
 */

export type VodafoneCashSetting = {
  enabled: boolean;
  number: string | null;
  accountName: string | null;
  instructionsAr: string | null;
  instructionsEn: string | null;
};

export type MerchantVodafoneCashResult =
  | { ok: true; setting: VodafoneCashSetting }
  | {
      ok: false;
      error:
        | "UNAVAILABLE"
        | "DENIED"
        | "INVALID_CONFIG"
        | "COMMERCE_NOT_CONFIGURED";
    };

const NUMBER_PATTERN = /^\+?[0-9][0-9 ()\-]{6,24}$/;
const MAX_NUMBER_LENGTH = 32;
const MAX_ACCOUNT_NAME_LENGTH = 120;
const MAX_INSTRUCTIONS_LENGTH = 1000;

function cleanText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeNumber(value: unknown): string | null | false {
  const text = cleanText(value);
  if (text === null) return null;
  if (text.length > MAX_NUMBER_LENGTH) return false;
  return NUMBER_PATTERN.test(text) ? text : false;
}

function normalizeInstructions(value: unknown): string | null | false {
  const text = cleanText(value);
  if (text === null) return null;
  if (text.length > MAX_INSTRUCTIONS_LENGTH) return false;
  return text;
}

export async function readVodafoneCashSetting(
  db: Pick<Database, "select">,
  scope: StoreScope,
): Promise<VodafoneCashSetting | null> {
  const [row] = await db
    .select({
      enabled: storeCommerceSetting.vodafoneCashEnabled,
      number: storeCommerceSetting.vodafoneCashNumber,
      accountName: storeCommerceSetting.vodafoneCashAccountName,
      instructionsAr: storeCommerceSetting.vodafoneCashInstructionsAr,
      instructionsEn: storeCommerceSetting.vodafoneCashInstructionsEn,
    })
    .from(storeCommerceSetting)
    .where(eq(storeCommerceSetting.storeId, scope.storeId))
    .limit(1);

  return row ?? null;
}

export async function saveMerchantVodafoneCash(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: {
    enabled: unknown;
    number: unknown;
    accountName: unknown;
    instructionsAr: unknown;
    instructionsEn: unknown;
  },
): Promise<MerchantVodafoneCashResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  if (typeof input.enabled !== "boolean") {
    return { ok: false, error: "INVALID_CONFIG" };
  }

  const enabled = input.enabled;
  const number = normalizeNumber(input.number);
  const accountName = cleanText(input.accountName);
  const instructionsAr = normalizeInstructions(input.instructionsAr);
  const instructionsEn = normalizeInstructions(input.instructionsEn);

  if (
    number === false ||
    instructionsAr === false ||
    instructionsEn === false ||
    (accountName !== null && accountName.length > MAX_ACCOUNT_NAME_LENGTH)
  ) {
    return { ok: false, error: "INVALID_CONFIG" };
  }

  if (
    enabled &&
    (number === null ||
      accountName === null ||
      (instructionsAr === null && instructionsEn === null))
  ) {
    return { ok: false, error: "INVALID_CONFIG" };
  }

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

      const [existing] = await tx
        .select({ storeId: storeCommerceSetting.storeId })
        .from(storeCommerceSetting)
        .where(eq(storeCommerceSetting.storeId, access.scope.storeId))
        .limit(1);

      const setting: VodafoneCashSetting = {
        enabled,
        number,
        accountName,
        instructionsAr,
        instructionsEn,
      };

      if (existing) {
        await tx
          .update(storeCommerceSetting)
          .set({
            vodafoneCashEnabled: enabled,
            vodafoneCashNumber: number,
            vodafoneCashAccountName: accountName,
            vodafoneCashInstructionsAr: instructionsAr,
            vodafoneCashInstructionsEn: instructionsEn,
            updatedAt: new Date(),
          })
          .where(eq(storeCommerceSetting.storeId, access.scope.storeId));
      } else {
        const [legacyCurrency] = await tx
          .select({ currency: botSetting.currency })
          .from(botSetting)
          .where(
            and(
              eq(botSetting.id, 1),
              eq(botSetting.storeId, access.scope.storeId),
            ),
          )
          .limit(1);

        if (!legacyCurrency) {
          return { ok: false, error: "COMMERCE_NOT_CONFIGURED" } as const;
        }

        await tx.insert(storeCommerceSetting).values({
          storeId: access.scope.storeId,
          currency: legacyCurrency.currency,
          deliveryFee: "0.00",
          codEnabled: false,
          vodafoneCashEnabled: enabled,
          vodafoneCashNumber: number,
          vodafoneCashAccountName: accountName,
          vodafoneCashInstructionsAr: instructionsAr,
          vodafoneCashInstructionsEn: instructionsEn,
        });
      }

      return { ok: true, setting } as const;
    });
  } catch {
    console.error("Merchant Vodafone Cash configuration update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
