import "server-only";

import type { Database } from "@/db/client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  validatePrice,
  validateProductRevision,
  validateUuid,
} from "@/lib/catalog/validation";
import {
  readCatalogProductPriceForMerchant,
  updateCatalogProductPriceForMerchant,
} from "@/lib/data/catalog";
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
 * - the expected product revision is validated and compared in the same
 *   guarded `UPDATE`, so a stale draft cannot overwrite a newer price;
 * - the guarded scoped update decides ownership, so a missing, ineligible or
 *   foreign product produces one indistinguishable not-found result.
 *
 * Only a product id, an exact-decimal price string and the expected product
 * revision cross this boundary. No store id, membership role or ownership
 * field is accepted; the `StoreScope` comes from the server-side access
 * result.
 */

export type MerchantProductPriceError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_PRICE"
  | "INVALID_REVISION"
  | "CONFLICT";

export type MerchantProductPriceResult =
  | { ok: true; productId: string; price: string; revision: string }
  | {
      ok: false;
      error: "CONFLICT";
      current: { price: string; revision: string };
    }
  | { ok: false; error: Exclude<MerchantProductPriceError, "CONFLICT"> };

export type MerchantProductPriceInput = {
  productId: unknown;
  price: unknown;
  revision: unknown;
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

  const revision = validateProductRevision(input.revision);

  if (!revision.success) {
    return { ok: false, error: "INVALID_REVISION" };
  }

  const identity = {
    userId: access.userId,
    sessionVersion: access.sessionVersion,
  };

  try {
    const updated = await updateCatalogProductPriceForMerchant(
      db,
      access.scope,
      identity,
      productId.data,
      price.data,
      revision.data,
    );

    if (updated) {
      return {
        ok: true,
        productId: productId.data,
        price: updated.price,
        revision: updated.revision,
      };
    }

    // The guarded write returned no row. Only an authorized, writable merchant
    // looking at an eligible product may learn that this was a revision
    // conflict; every other no-match path stays a generic not-found result.
    const current = await readCatalogProductPriceForMerchant(
      db,
      access.scope,
      identity,
      productId.data,
    );

    if (current) {
      return { ok: false, error: "CONFLICT", current };
    }

    return { ok: false, error: "NOT_FOUND" };
  } catch (error) {
    if (error instanceof RabetDataError && error.code === "INVALID_INPUT") {
      return { ok: false, error: "INVALID_PRICE" };
    }

    console.error("Merchant product price update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
