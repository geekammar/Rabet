import "server-only";

import { and, eq, ne } from "drizzle-orm";

import type { Database } from "@/db/client";
import { store } from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { assertStoreScope, type StoreScope } from "@/lib/data/store-scope";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import { EMPTY_STOREFRONT_PROFILE, type StorefrontProfile } from "./storefront-profile-fields";

export async function readStorefrontProfile(db: Database, scope: StoreScope): Promise<StorefrontProfile> {
  assertStoreScope(scope);
  const [row] = await db.select({ profile: store.storefrontProfile })
    .from(store).where(eq(store.id, scope.storeId)).limit(1);
  return row?.profile ?? EMPTY_STOREFRONT_PROFILE;
}

export async function saveStorefrontProfile(
  db: TransactionDatabase,
  access: MerchantAccess,
  profile: StorefrontProfile,
): Promise<boolean> {
  if (access.readOnly) return false;
  return db.transaction(async (tx) => {
    const eligibility = await resolveMerchantEligibility(tx as unknown as TransactionDatabase, {
      userId: access.userId,
      sessionVersion: access.sessionVersion,
    });
    if (!eligibility || eligibility.readOnly || eligibility.store.id !== access.scope.storeId) {
      return false;
    }

    const rows = await tx.update(store)
      .set({ storefrontProfile: profile, updatedAt: new Date() })
      .where(and(eq(store.id, access.scope.storeId), ne(store.status, "suspended")))
      .returning({ id: store.id });
    return rows.length === 1;
  });
}
