import "server-only";

import { and, eq } from "drizzle-orm";

import { botSetting, storeCommerceSetting } from "@/db/schema";
import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { validatePrice } from "@/lib/catalog/validation";
import type { StoreScope } from "@/lib/data/store-scope";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";

export type MerchantCommerceSetting = {
  currency: string;
  codEnabled: boolean;
  deliveryFee: string;
  deliveryFeeConfigured: boolean;
};

export type MerchantCommerceSettingResult =
  | { ok: true; setting: MerchantCommerceSetting }
  | {
      ok: false;
      error:
        | "UNAVAILABLE"
        | "DENIED"
        | "INVALID_INPUT"
        | "COMMERCE_NOT_CONFIGURED";
    };

export async function readMerchantCommerceSetting(
  db: Pick<Database, "select">,
  scope: StoreScope,
): Promise<MerchantCommerceSetting | null> {
  const [row] = await db
    .select({
      currency: storeCommerceSetting.currency,
      codEnabled: storeCommerceSetting.codEnabled,
      deliveryFee: storeCommerceSetting.deliveryFee,
      deliveryFeeConfigured: storeCommerceSetting.deliveryFeeConfigured,
    })
    .from(storeCommerceSetting)
    .where(eq(storeCommerceSetting.storeId, scope.storeId))
    .limit(1);

  return row ?? null;
}

export async function saveMerchantCommerceSetting(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: { codEnabled: unknown; deliveryFee: unknown },
): Promise<MerchantCommerceSettingResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  if (typeof input.codEnabled !== "boolean") {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const codEnabled = input.codEnabled;

  const rawDeliveryFee =
    typeof input.deliveryFee === "string" ? input.deliveryFee.trim() : null;

  if (rawDeliveryFee === null) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  let deliveryFee = "0.00";
  let deliveryFeeConfigured = false;

  if (rawDeliveryFee.length > 0) {
    const validated = validatePrice(rawDeliveryFee);

    if (!validated.success) {
      return { ok: false, error: "INVALID_INPUT" };
    }

    deliveryFee = validated.data;
    deliveryFeeConfigured = true;
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

      if (existing) {
        await tx
          .update(storeCommerceSetting)
          .set({
            codEnabled,
            deliveryFee,
            deliveryFeeConfigured,
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
          codEnabled,
          deliveryFee,
          deliveryFeeConfigured,
        });
      }

      const setting = await readMerchantCommerceSetting(
        tx as unknown as Database,
        access.scope,
      );

      if (!setting) {
        return { ok: false, error: "UNAVAILABLE" } as const;
      }

      return { ok: true, setting } as const;
    });
  } catch {
    console.error("Merchant commerce settings update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
