"use server";

import { refresh } from "next/cache";

import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  updateMerchantCatalogProductPrice,
  type MerchantProductPriceResult,
} from "@/lib/merchant/catalog";

/**
 * Saves one exact decimal price for a product in the signed-in merchant's own
 * store.
 *
 * The enablement gate and the database-backed merchant eligibility rule run on
 * every invocation, not only when the page was rendered. A revoked or
 * multi-store membership, a stale `session_version`, a disabled user and a
 * suspended store therefore deny the write even when the form is already open.
 *
 * Only `productId` and `price` are read from the submitted object. Any
 * submitted store, ownership or role field is ignored; the store scope is
 * minted from the current session.
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
  });

  if (result.ok) {
    refresh();
  }

  return result;
}
