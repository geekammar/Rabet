import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  language,
  product,
  productInventory,
  productTranslation,
  storeCommerceSetting,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
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
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
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

type ReadinessProductRow = {
  id: string;
  categoryId: string;
  price: string;
  isActive: boolean;
  revision: string;
};

type ReadinessCategoryRow = {
  id: string;
  parentId: string | null;
  isActive: boolean;
  deletedAt: Date | null;
};

type ReadinessCommerceRow = {
  codEnabled: boolean;
  deliveryFeeConfigured: boolean;
  vodafoneCashEnabled: boolean;
  vodafoneCashNumber: string | null;
  vodafoneCashAccountName: string | null;
  vodafoneCashInstructionsAr: string | null;
  vodafoneCashInstructionsEn: string | null;
};

/**
 * The single readiness evaluation used by both the merchant read path and the
 * transactional activation path. Keeping one evaluator means the browser
 * preview and the activation gate can never disagree about why a product is
 * not publishable.
 */
function evaluateMerchantProductReadiness(input: {
  productRow: ReadinessProductRow;
  categoryRows: ReadinessCategoryRow[];
  translationNames: string[];
  inventory: { onHand: number; reserved: number } | undefined;
  commerce: ReadinessCommerceRow | null;
  storeBotReady: boolean;
}): {
  reasons: MerchantProductReadinessReason[];
  availability: ManagedProductAvailability;
} {
  const categoryById = new Map(
    input.categoryRows.map((row) => [row.id, row]),
  );
  const categoryEligible = isCategoryAncestryActive(
    input.productRow.categoryId,
    (id) => {
      const row = categoryById.get(id);
      return row && row.deletedAt === null ? row : undefined;
    },
  );

  const available = input.inventory
    ? Math.max(0, input.inventory.onHand - input.inventory.reserved)
    : 0;
  const availability = { available, inStock: available > 0 };

  const hasName = input.translationNames.some(
    (name) => name.trim().length > 0,
  );
  const hasPrice = validatePrice(input.productRow.price).success;

  const reasons: MerchantProductReadinessReason[] = [];

  if (!hasName) reasons.push("NAME_MISSING");
  if (!hasPrice) reasons.push("PRICE_MISSING");
  if (!categoryEligible) reasons.push("CATEGORY_NOT_ELIGIBLE");
  if (!availability.inStock) reasons.push("OUT_OF_STOCK");
  if (!input.commerce || !paymentMethodReady(input.commerce)) {
    reasons.push("NO_PAYMENT_METHOD");
  }
  if (!input.commerce?.deliveryFeeConfigured) {
    reasons.push("DELIVERY_FEE_NOT_CONFIGURED");
  }
  if (!input.storeBotReady) reasons.push("STORE_BOT_NOT_CONNECTED");

  return { reasons, availability };
}

function readinessResult(
  productRow: ReadinessProductRow,
  evaluation: {
    reasons: MerchantProductReadinessReason[];
    availability: ManagedProductAvailability;
  },
): MerchantProductReadiness {
  return {
    productId: productRow.id,
    ready: evaluation.reasons.length === 0,
    reasons: evaluation.reasons,
    isActive: productRow.isActive,
    revision: productRow.revision,
    availability: evaluation.availability,
  };
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

  const connection = await readMerchantTelegramConnectionState(db, {
    scope: access.scope,
    merchantUserId: access.userId,
  });
  const storeBotReady =
    connection.state === "connected" &&
    typeof connection.botUsername === "string" &&
    connection.botUsername.trim().length > 0;

  const evaluation = evaluateMerchantProductReadiness({
    productRow,
    categoryRows,
    translationNames: translationRows.map((row) => row.name),
    inventory: inventoryRows[0],
    commerce: commerceRows[0] ?? null,
    storeBotReady,
  });

  return readinessResult(productRow, evaluation);
}

/**
 * Reads readiness while holding a row lock on every input that can make the
 * product unready.
 *
 * The merchant activation path must not trust a readiness value read before
 * the write: inventory, category ancestry, commerce settings, product
 * translations and the Store Bot connection are all independent rows that do
 * not bump the product revision. Locking each row with `SELECT ... FOR UPDATE`
 * inside the caller's transaction means a concurrent change either commits
 * before this read (and is evaluated) or waits until activation commits (and
 * is applied after the product is already active). The caller re-evaluates
 * readiness from these locked reads immediately before the guarded update.
 *
 * Lock order is fixed (product, categories, translations, inventory, commerce,
 * ready connection) to keep concurrent publish calls deterministic.
 */
async function readMerchantProductReadinessForActivation(
  db: TransactionDatabase,
  access: MerchantAccess,
  productId: string,
): Promise<MerchantProductReadiness | null> {
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
        eq(product.id, productId),
        eq(product.storeId, access.scope.storeId),
        isNull(product.deletedAt),
      ),
    )
    .limit(1)
    .for("update");

  if (!productRow) return null;

  const categoryRows = await db
    .select({
      id: category.id,
      parentId: category.parentId,
      isActive: category.isActive,
      deletedAt: category.deletedAt,
    })
    .from(category)
    .where(eq(category.storeId, access.scope.storeId))
    .orderBy(category.id)
    .for("update");

  const translationRows = await db
    .select({ name: productTranslation.name })
    .from(productTranslation)
    .where(eq(productTranslation.productId, productId))
    .orderBy(productTranslation.id)
    .for("update");

  const [inventory] = await db
    .select({
      onHand: productInventory.onHand,
      reserved: productInventory.reserved,
    })
    .from(productInventory)
    .where(
      and(
        eq(productInventory.productId, productId),
        eq(productInventory.storeId, access.scope.storeId),
      ),
    )
    .limit(1)
    .for("update");

  const [commerce] = await db
    .select({
      codEnabled: storeCommerceSetting.codEnabled,
      deliveryFeeConfigured: storeCommerceSetting.deliveryFeeConfigured,
      vodafoneCashEnabled: storeCommerceSetting.vodafoneCashEnabled,
      vodafoneCashNumber: storeCommerceSetting.vodafoneCashNumber,
      vodafoneCashAccountName: storeCommerceSetting.vodafoneCashAccountName,
      vodafoneCashInstructionsAr:
        storeCommerceSetting.vodafoneCashInstructionsAr,
      vodafoneCashInstructionsEn:
        storeCommerceSetting.vodafoneCashInstructionsEn,
    })
    .from(storeCommerceSetting)
    .where(eq(storeCommerceSetting.storeId, access.scope.storeId))
    .limit(1)
    .for("update");

  const [readyConnection] = await db
    .select({ botUsername: telegramConnection.botUsername })
    .from(telegramConnection)
    .where(
      and(
        eq(telegramConnection.storeId, access.scope.storeId),
        eq(telegramConnection.status, "ready"),
      ),
    )
    .orderBy(desc(telegramConnection.verifiedAt))
    .limit(1)
    .for("update");

  const storeBotReady =
    typeof readyConnection?.botUsername === "string" &&
    readyConnection.botUsername.trim().length > 0;

  const evaluation = evaluateMerchantProductReadiness({
    productRow,
    categoryRows,
    translationNames: translationRows.map((row) => row.name),
    inventory,
    commerce: commerce ?? null,
    storeBotReady,
  });

  return readinessResult(productRow, evaluation);
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

/**
 * Publishes one draft product through the same readiness gate used by the
 * availability action.
 *
 * The whole decision runs in one interactive transaction on the transactional
 * client: eligibility is re-resolved, every readiness input is locked and
 * re-read, readiness is re-evaluated, and only then does the guarded activation
 * update run. The product revision supplied by the client is compared in that
 * same update, so a stale revision still yields `CONFLICT` after the locked
 * readiness read confirms the product is currently publishable.
 *
 * The read-only application client cannot open transactions, so callers must
 * pass the transaction client. Deactivation does not require readiness and
 * stays on the ordinary availability path.
 */
export async function publishMerchantCatalogProduct(
  db: TransactionDatabase,
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

  const identity = {
    userId: access.userId,
    sessionVersion: access.sessionVersion,
  };

  try {
    return await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as TransactionDatabase;
      const queryDb = tx as unknown as Database;

      const eligibility = await resolveMerchantEligibility(transactionDb, {
        userId: access.userId,
        sessionVersion: access.sessionVersion,
      });

      if (
        !eligibility ||
        eligibility.readOnly ||
        eligibility.store.id !== access.scope.storeId
      ) {
        return { ok: false, error: "DENIED" } as const;
      }

      const readiness = await readMerchantProductReadinessForActivation(
        transactionDb,
        access,
        productId.data,
      );

      if (!readiness) {
        return { ok: false, error: "NOT_FOUND" } as const;
      }

      if (readiness.isActive) {
        return {
          ok: true,
          productId: readiness.productId,
          isActive: true,
          revision: readiness.revision,
        } as const;
      }

      if (!readiness.ready) {
        return {
          ok: false,
          error: "NOT_READY",
          reasons: readiness.reasons,
        } as const;
      }

      const updated = await updateCatalogProductAvailabilityForMerchant(
        queryDb,
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
        } as const;
      }

      const current = await readCatalogProductAvailabilityForMerchant(
        queryDb,
        access.scope,
        identity,
        productId.data,
      );

      if (current) {
        return { ok: false, error: "CONFLICT", current } as const;
      }

      return { ok: false, error: "NOT_FOUND" } as const;
    });
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
