"use server";

import { revalidatePath, refresh } from "next/cache";

import { getDb } from "@/db/client";
import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  updateMerchantCatalogProductAvailability,
  updateMerchantCatalogProductPrice,
  type MerchantProductAvailabilityResult,
  type MerchantProductPriceResult,
} from "@/lib/merchant/catalog";
import {
  updateMerchantCatalogCategoryAvailability,
  type MerchantCategoryAvailabilityResult,
} from "@/lib/merchant/category";
import {
  createMerchantCatalogProduct,
  resolveMerchantCatalogLanguage,
  type MerchantProductCreateResult,
} from "@/lib/merchant/product-create";

/**
 * Saves one exact decimal price for a product in the signed-in merchant's own
 * store.
 *
 * The enablement gate and the database-backed merchant eligibility rule run on
 * every invocation, not only when the page was rendered. A revoked or
 * multi-store membership, a stale `session_version`, a disabled user and a
 * suspended store therefore deny the write even when the form is already open.
 *
 * Only `productId`, `price` and the expected product `revision` are read from
 * the submitted object. Any submitted store, ownership or role field is
 * ignored; the store scope is minted from the current session.
 */
export async function saveMerchantProductPrice(
  input: unknown,
): Promise<MerchantProductPriceResult> {
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

  const result = await updateMerchantCatalogProductPrice(getDb(), access, {
    productId: submitted.productId,
    price: submitted.price,
    revision: submitted.revision,
  });

  if (result.ok) {
    refresh();
  }

  return result;
}

export async function saveMerchantProductAvailability(
  input: unknown,
): Promise<MerchantProductAvailabilityResult> {
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

  const result = await updateMerchantCatalogProductAvailability(
    getDb(),
    access,
    {
      productId: submitted.productId,
      isActive: submitted.isActive,
      revision: submitted.revision,
    },
  );

  if (result.ok) {
    refresh();
  }

  return result;
}

/**
 * Saves one explicit availability decision for a category in the signed-in
 * merchant's own store.
 *
 * The enablement gate and the database-backed merchant eligibility rule run on
 * every invocation. Only `categoryId`, a literal `isActive` boolean and the
 * expected category `revision` are read from the submitted object; submitted
 * store, ownership or role fields are ignored and the scope is minted from the
 * current session.
 */
export async function saveMerchantCategoryAvailability(
  input: unknown,
): Promise<MerchantCategoryAvailabilityResult> {
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

  const result = await updateMerchantCatalogCategoryAvailability(
    getDb(),
    access,
    {
      categoryId: submitted.categoryId,
      isActive: submitted.isActive,
      revision: submitted.revision,
    },
  );

  if (result.ok) {
    revalidatePath("/app/categories");
    revalidatePath("/app/products");
    refresh();
  }

  return result;
}

export async function createMerchantProductDraft(
  input: unknown,
): Promise<MerchantProductCreateResult> {
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

  const language = await resolveMerchantCatalogLanguage(getDb());

  if (!language) {
    return { ok: false, error: "LANGUAGE_UNAVAILABLE" };
  }

  const result = await createMerchantCatalogProduct(
    getTransactionDb(),
    access,
    language,
    {
      name: submitted.name,
      price: submitted.price,
      categoryId: submitted.categoryId,
      newCategoryName: submitted.newCategoryName,
    },
  );

  if (result.ok) {
    revalidatePath("/app/products");
    revalidatePath("/app/products/new");
  }

  return result;
}
