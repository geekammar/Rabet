import "server-only";

import type { Database } from "@/db/client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import { validatePrice, validateUuid } from "@/lib/catalog/validation";
import { updateCatalogProductPriceForMerchant } from "@/lib/data/catalog";
import { RabetDataError } from "@/lib/data/errors";

/**
 * Merchant-scoped catalog price mutation.
 *
 * Authorization is resolved by the caller, then re-bound to the guarded price
 * `UPDATE` itself. The caller's access result supplies only server-derived
 * identity, session version and store scope; the database statement rechecks
 * the same eligibility facts and the writable store state when it writes.
 *
 * - a suspended (read-only) store may not write;
 * - the product identifier must be a server-validated UUID;
 * - the price must pass the existing exact-decimal `validatePrice` contract;
 * - the guarded scoped update decides ownership, so a missing, ineligible or
 *   foreign product produces one indistinguishable not-found result.
 *
 * Only a product id and a price string cross this boundary. No store id,
 * membership role or ownership field is accepted; the `StoreScope` comes from
 * the server-side access result.
 */

export type MerchantProductPriceError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_PRICE";

export type MerchantProductPriceResult =
  | { ok: true; productId: string; price: string }
  | { ok: false; error: MerchantProductPriceError };

export type MerchantProductPriceInput = {
  productId: unknown;
  price: unknown;
};

export async function updateMerchantCatalogProductPrice(
  db: Database,
  access: MerchantAccess,
  input: MerchantProductPriceInput,
): Promise<MerchantProductPriceResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const productId = validateUuid(input.productId, "Product");

  if (!productId.success) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const price = validatePrice(input.price);

  if (!price.success) {
    return { ok: false, error: "INVALID_PRICE" };
  }

  try {
    const updated = await updateCatalogProductPriceForMerchant(
      db,
      access.scope,
      {
        userId: access.userId,
        sessionVersion: access.sessionVersion,
      },
      productId.data,
      price.data,
    );

    if (!updated) {
      return { ok: false, error: "NOT_FOUND" };
    }

    return { ok: true, productId: productId.data, price: price.data };
  } catch (error) {
    if (error instanceof RabetDataError && error.code === "INVALID_INPUT") {
      return { ok: false, error: "INVALID_PRICE" };
    }

    console.error("Merchant product price update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
