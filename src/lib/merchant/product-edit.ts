import "server-only";

import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  product,
  productInventory,
  productTranslation,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  validateDescription,
  validateProductRevision,
  validateUuid,
} from "@/lib/catalog/validation";
import {
  readCatalogProductAvailabilityForMerchant,
  readCatalogProductForMerchantEdit,
  updateCatalogProductImageForMerchant,
  type MerchantProductEditRecord,
} from "@/lib/data/catalog";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import {
  validateProductImageUrl,
  validateProductStock,
  type MerchantCatalogLanguage,
} from "@/lib/merchant/product-create";

export type MerchantProductEditResult =
  | { ok: true; productId: string; revision: string }
  | {
      ok: false;
      error:
        | "UNAVAILABLE"
        | "DENIED"
        | "NOT_FOUND"
        | "INVALID_INPUT"
        | "INVALID_REVISION"
        | "CONFLICT"
        | "STOCK_BELOW_RESERVED";
      current?: { isActive: boolean; revision: string };
      fields?: {
        description?: boolean;
        imageUrl?: boolean;
        stock?: boolean;
      };
    };

export async function readMerchantCatalogProductForEdit(
  db: Database,
  access: MerchantAccess,
  productId: unknown,
): Promise<MerchantProductEditRecord | null> {
  const validated = validateUuid(productId, "Product");

  if (!validated.success) return null;

  return readCatalogProductForMerchantEdit(db, access.scope, validated.data);
}

export async function updateMerchantCatalogProductDraft(
  db: TransactionDatabase,
  access: MerchantAccess,
  language: MerchantCatalogLanguage,
  input: {
    productId: unknown;
    revision: unknown;
    description: unknown;
    imageUrl: unknown;
    stock: unknown;
  },
): Promise<MerchantProductEditResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const productId = validateUuid(input.productId, "Product");

  if (!productId.success) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const revision = validateProductRevision(input.revision);

  if (!revision.success) {
    return { ok: false, error: "INVALID_REVISION" };
  }

  const description = validateDescription(input.description);
  const imageUrl = validateProductImageUrl(input.imageUrl);
  const stock = validateProductStock(input.stock);
  const fields: NonNullable<
    Extract<MerchantProductEditResult, { ok: false }>["fields"]
  > = {};

  if (!description.success) fields.description = true;
  if (!imageUrl.success) fields.imageUrl = true;
  if (!stock.success) fields.stock = true;

  if (Object.keys(fields).length > 0) {
    return { ok: false, error: "INVALID_INPUT", fields };
  }

  const nextDescription = description.success ? description.data : null;
  const nextImageUrl = imageUrl.success ? imageUrl.data : null;
  const nextOnHand = stock.success ? (stock.data ?? 0) : 0;

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

      const [inventory] = await tx
        .select({
          onHand: productInventory.onHand,
          reserved: productInventory.reserved,
        })
        .from(productInventory)
        .where(
          and(
            eq(productInventory.productId, productId.data),
            eq(productInventory.storeId, access.scope.storeId),
          ),
        )
        .limit(1);

      if (inventory && nextOnHand < inventory.reserved) {
        return { ok: false, error: "STOCK_BELOW_RESERVED" } as const;
      }

      const identity = {
        userId: access.userId,
        sessionVersion: access.sessionVersion,
      };
      const updated = await updateCatalogProductImageForMerchant(
        tx as unknown as Database,
        access.scope,
        identity,
        productId.data,
        nextImageUrl,
        revision.data,
      );

      if (!updated) {
        const current = await readCatalogProductAvailabilityForMerchant(
          tx as unknown as Database,
          access.scope,
          identity,
          productId.data,
        );

        if (current) {
          return { ok: false, error: "CONFLICT", current } as const;
        }

        return { ok: false, error: "NOT_FOUND" } as const;
      }

      const [translation] = await tx
        .select({ name: productTranslation.name })
        .from(productTranslation)
        .where(
          and(
            eq(productTranslation.productId, productId.data),
            eq(productTranslation.languageId, language.id),
          ),
        )
        .limit(1);

      if (translation) {
        await tx
          .update(productTranslation)
          .set({ description: nextDescription, updatedAt: new Date() })
          .where(
            and(
              eq(productTranslation.productId, productId.data),
              eq(productTranslation.languageId, language.id),
            ),
          );
      } else {
        const [productRow] = await tx
          .select({ slug: product.slug })
          .from(product)
          .where(eq(product.id, productId.data))
          .limit(1);
        const [fallbackTranslation] = await tx
          .select({ name: productTranslation.name })
          .from(productTranslation)
          .where(eq(productTranslation.productId, productId.data))
          .limit(1);

        await tx.insert(productTranslation).values({
          productId: productId.data,
          languageId: language.id,
          name:
            fallbackTranslation?.name?.trim() ||
            productRow?.slug ||
            "Product",
          description: nextDescription,
        });
      }

      await tx
        .insert(productInventory)
        .values({
          productId: productId.data,
          storeId: access.scope.storeId,
          onHand: nextOnHand,
        })
        .onConflictDoUpdate({
          target: productInventory.productId,
          set: {
            onHand: nextOnHand,
            updatedAt: new Date(),
          },
        });

      return {
        ok: true,
        productId: productId.data,
        revision: updated.revision,
      } as const;
    });
  } catch {
    console.error("Merchant product draft update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
