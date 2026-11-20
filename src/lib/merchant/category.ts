import "server-only";

import type { Database } from "@/db/client";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  validateCategoryRevision,
  validateUuid,
} from "@/lib/catalog/validation";
import {
  readCatalogCategoryAvailabilityForMerchant,
  updateCatalogCategoryAvailabilityForMerchant,
  type MerchantPriceWriteIdentity,
} from "@/lib/data/catalog";
import { RabetDataError } from "@/lib/data/errors";

/**
 * Merchant-scoped category availability mutation.
 *
 * The caller resolves the current merchant access; this module re-validates
 * the submitted category id, the explicit boolean decision and the exact
 * category revision, then binds the server-derived identity, session version
 * and store scope to the guarded `UPDATE` itself.
 *
 * Only `is_active` is written. A stale revision, a foreign or missing category,
 * a revoked membership, a session-version change or a suspended store all
 * produce the same safe result. A revision conflict is disclosed only after an
 * authorized scoped read confirms the target still belongs to this merchant.
 */

export type MerchantCategoryAvailabilityError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_REVISION"
  | "CONFLICT";

export type MerchantCategoryAvailabilityResult =
  | { ok: true; categoryId: string; isActive: boolean; revision: string }
  | {
      ok: false;
      error: "CONFLICT";
      current: { isActive: boolean; revision: string };
    }
  | {
      ok: false;
      error: Exclude<MerchantCategoryAvailabilityError, "CONFLICT">;
    };

export type MerchantCategoryAvailabilityInput = {
  categoryId: unknown;
  isActive: unknown;
  revision: unknown;
};

export async function updateMerchantCatalogCategoryAvailability(
  db: Database,
  access: MerchantAccess,
  input: MerchantCategoryAvailabilityInput,
): Promise<MerchantCategoryAvailabilityResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const categoryId = validateUuid(input.categoryId, "Category");

  if (!categoryId.success) {
    return { ok: false, error: "NOT_FOUND" };
  }

  if (typeof input.isActive !== "boolean") {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const revision = validateCategoryRevision(input.revision);

  if (!revision.success) {
    return { ok: false, error: "INVALID_REVISION" };
  }

  const identity: MerchantPriceWriteIdentity = {
    userId: access.userId,
    sessionVersion: access.sessionVersion,
  };

  try {
    const updated = await updateCatalogCategoryAvailabilityForMerchant(
      db,
      access.scope,
      identity,
      categoryId.data,
      input.isActive,
      revision.data,
    );

    if (updated) {
      return {
        ok: true,
        categoryId: categoryId.data,
        isActive: updated.isActive,
        revision: updated.revision,
      };
    }

    const current = await readCatalogCategoryAvailabilityForMerchant(
      db,
      access.scope,
      identity,
      categoryId.data,
    );

    if (current) {
      return { ok: false, error: "CONFLICT", current };
    }

    return { ok: false, error: "NOT_FOUND" };
  } catch (error) {
    if (error instanceof RabetDataError && error.code === "INVALID_INPUT") {
      return { ok: false, error: "INVALID_INPUT" };
    }

    console.error("Merchant category availability update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
