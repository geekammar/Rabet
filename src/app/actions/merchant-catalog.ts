"use server";

import { revalidatePath, refresh } from "next/cache";

import { getDb } from "@/db/client";
import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  updateMerchantCatalogProductPrice,
  type MerchantProductPriceResult,
} from "@/lib/merchant/catalog";
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
    return { ok: false, error: "UNAVAILABLE" };
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
