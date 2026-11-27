import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  language,
  product,
  productInventory,
  productTranslation,
  storeCommerceSetting,
} from "@/db/schema";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  readManagedProduct,
  type ManagedCatalogContentPlan,
  type ManagedProduct,
  type ManagedProductAvailability,
} from "@/lib/catalog/managed-storefront";
import { isCategoryAncestryActive } from "@/lib/catalog/eligibility";
import {
  validatePrice,
  validateProductRevision,
  validateUuid,
} from "@/lib/catalog/validation";
import {
  catalogProductRevisionSql,
  readCatalogProductAvailabilityForMerchant,
  updateCatalogProductAvailabilityForMerchant,
} from "@/lib/data/catalog";
import {
  isCodOrdersDeploymentEnabled,
  isManualTransferDeploymentEnabled,
} from "@/lib/commerce/feature";
import { readStoreCatalogLanguageCode } from "@/lib/data/store-language";
import { readMerchantCommerceSetting } from "@/lib/merchant/store-commerce";
import { readMerchantTelegramConnectionState } from "@/lib/telegram/manager-provisioning";

export type MerchantProductReadinessReason =
  | "NAME_MISSING"
  | "PRICE_MISSING"
  | "CATEGORY_NOT_ELIGIBLE"
  | "OUT_OF_STOCK"
  | "NO_PAYMENT_METHOD"
  | "DELIVERY_FEE_NOT_CONFIGURED"
  | "STORE_BOT_NOT_CONNECTED";

export type MerchantProductReadiness = {
  productId: string;
  ready: boolean;
  reasons: MerchantProductReadinessReason[];
  isActive: boolean;
  revision: string;
  availability: ManagedProductAvailability;
};

function paymentMethodReady(setting: {
  codEnabled: boolean;
  vodafoneCashEnabled: boolean;
  vodafoneCashNumber: string | null;
  vodafoneCashAccountName: string | null;
  vodafoneCashInstructionsAr: string | null;
  vodafoneCashInstructionsEn: string | null;
}): boolean {
  const cod = setting.codEnabled && isCodOrdersDeploymentEnabled();
  const vodafoneCash =
    setting.vodafoneCashEnabled &&
    isManualTransferDeploymentEnabled() &&
    Boolean(setting.vodafoneCashNumber?.trim()) &&
    Boolean(setting.vodafoneCashAccountName?.trim()) &&
    Boolean(
      setting.vodafoneCashInstructionsAr?.trim() ||
        setting.vodafoneCashInstructionsEn?.trim(),
    );

  return cod || vodafoneCash;
}

export async function readMerchantProductReadiness(
  db: Database,
  access: MerchantAccess,
  productId: unknown,
): Promise<MerchantProductReadiness | null> {
  const validated = validateUuid(productId, "Product");

  if (!validated.success) return null;

  const [productRow] = await db
    .select({
      id: product.id,
      categoryId: product.categoryId,
      price: product.price,
      isActive: product.isActive,
      revision: catalogProductRevisionSql(),
    })
    .from(product)
    .where(
      and(
        eq(product.id, validated.data),
        eq(product.storeId, access.scope.storeId),
        isNull(product.deletedAt),
      ),
    )
    .limit(1);

  if (!productRow) return null;

  const [categoryRows, translationRows, inventoryRows, commerceRows] =
    await Promise.all([
      db
        .select({
          id: category.id,
          parentId: category.parentId,
          isActive: category.isActive,
          deletedAt: category.deletedAt,
        })
        .from(category)
        .where(eq(category.storeId, access.scope.storeId)),
      db
        .select({
          code: language.code,
          name: productTranslation.name,
        })
        .from(productTranslation)
        .innerJoin(language, eq(language.id, productTranslation.languageId))
        .where(eq(productTranslation.productId, validated.data)),
      db
        .select({
          onHand: productInventory.onHand,
          reserved: productInventory.reserved,
        })
        .from(productInventory)
        .where(
          and(
            eq(productInventory.productId, validated.data),
            eq(productInventory.storeId, access.scope.storeId),
          ),
        )
        .limit(1),
      db
        .select({
          codEnabled: storeCommerceSetting.codEnabled,
          deliveryFeeConfigured: storeCommerceSetting.deliveryFeeConfigured,
          vodafoneCashEnabled: storeCommerceSetting.vodafoneCashEnabled,
          vodafoneCashNumber: storeCommerceSetting.vodafoneCashNumber,
          vodafoneCashAccountName:
            storeCommerceSetting.vodafoneCashAccountName,
          vodafoneCashInstructionsAr:
            storeCommerceSetting.vodafoneCashInstructionsAr,
          vodafoneCashInstructionsEn:
            storeCommerceSetting.vodafoneCashInstructionsEn,
        })
        .from(storeCommerceSetting)
        .where(eq(storeCommerceSetting.storeId, access.scope.storeId))
        .limit(1),
    ]);

  const categoryById = new Map(categoryRows.map((row) => [row.id, row]));
  const categoryEligible = isCategoryAncestryActive(
    productRow.categoryId,
    (id) => {
      const row = categoryById.get(id);
      return row && row.deletedAt === null ? row : undefined;
    },
  );

  const inventory = inventoryRows[0];
  const available = inventory
    ? Math.max(0, inventory.onHand - inventory.reserved)
    : 0;
  const availability = { available, inStock: available > 0 };

  const hasName = translationRows.some((row) => row.name.trim().length > 0);
  const hasPrice = validatePrice(productRow.price).success;
  const commerce = commerceRows[0] ?? null;
  const connection = await readMerchantTelegramConnectionState(db, {
    scope: access.scope,
    merchantUserId: access.userId,
  });
  const storeBotReady =
    connection.state === "connected" &&
    typeof connection.botUsername === "string" &&
    connection.botUsername.trim().length > 0;

  const reasons: MerchantProductReadinessReason[] = [];

  if (!hasName) reasons.push("NAME_MISSING");
  if (!hasPrice) reasons.push("PRICE_MISSING");
  if (!categoryEligible) reasons.push("CATEGORY_NOT_ELIGIBLE");
  if (!availability.inStock) reasons.push("OUT_OF_STOCK");
  if (!commerce || !paymentMethodReady(commerce)) {
    reasons.push("NO_PAYMENT_METHOD");
  }
  if (!commerce?.deliveryFeeConfigured) {
    reasons.push("DELIVERY_FEE_NOT_CONFIGURED");
  }
  if (!storeBotReady) reasons.push("STORE_BOT_NOT_CONNECTED");

  return {
    productId: productRow.id,
    ready: reasons.length === 0,
    reasons,
    isActive: productRow.isActive,
    revision: productRow.revision,
    availability,
  };
}

export type MerchantProductPublishResult =
  | { ok: true; productId: string; isActive: true; revision: string }
  | {
      ok: false;
      error: "NOT_READY";
      reasons: MerchantProductReadinessReason[];
    }
  | {
      ok: false;
      error: "CONFLICT";
      current: { isActive: boolean; revision: string };
    }
  | {
      ok: false;
      error: "UNAVAILABLE" | "DENIED" | "NOT_FOUND" | "INVALID_REVISION";
    };

export async function publishMerchantCatalogProduct(
  db: Database,
  access: MerchantAccess,
  input: { productId: unknown; revision: unknown },
): Promise<MerchantProductPublishResult> {
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

  const readiness = await readMerchantProductReadiness(db, access, productId.data);

  if (!readiness) {
    return { ok: false, error: "NOT_FOUND" };
  }

  if (readiness.isActive) {
    return {
      ok: true,
      productId: readiness.productId,
      isActive: true,
      revision: readiness.revision,
    };
  }

  if (!readiness.ready) {
    return { ok: false, error: "NOT_READY", reasons: readiness.reasons };
  }

  const identity = {
    userId: access.userId,
    sessionVersion: access.sessionVersion,
  };

  try {
    const updated = await updateCatalogProductAvailabilityForMerchant(
      db,
      access.scope,
      identity,
      productId.data,
      true,
      revision.data,
    );

    if (updated) {
      return {
        ok: true,
        productId: productId.data,
        isActive: true,
        revision: updated.revision,
      };
    }

    const current = await readCatalogProductAvailabilityForMerchant(
      db,
      access.scope,
      identity,
      productId.data,
    );

    if (current) {
      return { ok: false, error: "CONFLICT", current };
    }

    return { ok: false, error: "NOT_FOUND" };
  } catch {
    console.error("Merchant product publish failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}

export type MerchantProductPreviewRecord = {
  product: ManagedProduct;
  isActive: boolean;
  revision: string;
  currency: string | null;
  readiness: MerchantProductReadiness | null;
};

export async function readMerchantProductPreview(
  db: Database,
  access: MerchantAccess,
  productId: unknown,
): Promise<MerchantProductPreviewRecord | null> {
  const validated = validateUuid(productId, "Product");

  if (!validated.success) return null;

  const [defaultLanguageCode, stateRows] = await Promise.all([
    readStoreCatalogLanguageCode(db, access.scope.storeId),
    db
      .select({
        isActive: product.isActive,
        revision: catalogProductRevisionSql(),
      })
      .from(product)
      .where(
        and(
          eq(product.id, validated.data),
          eq(product.storeId, access.scope.storeId),
          isNull(product.deletedAt),
        ),
      )
      .limit(1),
  ]);

  const state = stateRows[0];

  if (!state) return null;

  const plan: ManagedCatalogContentPlan = { defaultLanguageCode };
  const managed = await readManagedProduct(
    db,
    access.scope,
    validated.data,
    plan,
    { mode: "merchant-preview" },
  );

  if (!managed) return null;

  const commerce = await readMerchantCommerceSetting(db, access.scope);
  const readiness = await readMerchantProductReadiness(db, access, validated.data);

  return {
    product: managed,
    isActive: state.isActive,
    revision: state.revision,
    currency: commerce?.currency ?? null,
    readiness,
  };
}
