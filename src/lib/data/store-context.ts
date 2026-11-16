import "server-only";

import type { Database } from "@/db/client";
import { store } from "@/db/schema";
import { mapDatabaseError, RabetDataError } from "./errors";

/**
 * Trusted legacy store context (S1.3-A).
 *
 * This module is the only place the transitional single-store identity is
 * resolved. It reads PostgreSQL on every call and never keeps a process-wide
 * cache, so a store provisioned or changed by an operator becomes visible on
 * the next write without a redeploy.
 *
 * The legacy transition has exactly three states:
 *
 *   - `missing`  — no store row exists yet. Existing single-store writes must
 *                  keep writing NULL ownership until the approved provisioning
 *                  and backfill window.
 *   - `resolved` — exactly one store exists and its full identity matches the
 *                  approved legacy store.
 *   - invalid    — anything else (wrong identity, more than one store) fails
 *                  closed with `TENANT_CONTEXT_INVALID`.
 *
 * No browser input, Telegram payload or caller-supplied store id can influence
 * the result. The resolver never creates, updates or deletes a store.
 */

export const LEGACY_STORE_SLUG = "legacy-store";
export const LEGACY_STORE_NAME = "Rabet Legacy Store";
export const LEGACY_STORE_STATUS = "active" as const;

export type LegacyStoreContext =
  | {
      status: "missing";
      storeId: null;
    }
  | {
      status: "resolved";
      storeId: string;
      store: {
        id: string;
        name: string;
        slug: string;
        status: string;
      };
    };

/**
 * Resolves the trusted legacy store identity from PostgreSQL.
 *
 * The query deliberately reads every store row instead of `LIMIT 1`: a second
 * store is an explicit, observable conflict during the legacy transition, not
 * something to hide behind a positional guess.
 */
export async function resolveLegacyStoreContext(
  db: Database,
): Promise<LegacyStoreContext> {
  try {
    const rows = await db
      .select({
        id: store.id,
        name: store.name,
        slug: store.slug,
        status: store.status,
      })
      .from(store)
      .orderBy(store.id);

    if (rows.length === 0) {
      return { status: "missing", storeId: null };
    }

    if (rows.length > 1) {
      throw new RabetDataError(
        "TENANT_CONTEXT_INVALID",
        "The legacy transition expects exactly one store, but multiple stores " +
          "exist. Store-owned writes are blocked until the tenant transition " +
          "is completed.",
      );
    }

    const row = rows[0];

    if (
      row.slug !== LEGACY_STORE_SLUG ||
      row.name !== LEGACY_STORE_NAME ||
      row.status !== LEGACY_STORE_STATUS
    ) {
      throw new RabetDataError(
        "TENANT_CONTEXT_INVALID",
        "The only configured store does not match the approved legacy store " +
          "identity. Store-owned writes are blocked.",
      );
    }

    return {
      status: "resolved",
      storeId: row.id,
      store: row,
    };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * The verified legacy store id for a write, or `null` during the documented
 * missing-store transition. Invalid or ambiguous identity throws instead of
 * returning a fallback.
 */
export async function resolveLegacyStoreIdForWrite(
  db: Database,
): Promise<string | null> {
  const context = await resolveLegacyStoreContext(db);
  return context.storeId;
}

/**
 * Two ownership values are compatible while historical NULL rows exist:
 * a NULL side is an unresolved transition value, and two non-NULL values must
 * be equal. This is a temporary compatibility rule, not final isolation.
 */
export function isOwnershipCompatible(
  leftStoreId: string | null | undefined,
  rightStoreId: string | null | undefined,
): boolean {
  if (leftStoreId == null || rightStoreId == null) return true;
  return leftStoreId === rightStoreId;
}

/**
 * Rejects a business relationship whose two sides already belong to different
 * stores. A NULL side is tolerated only because pre-backfill history exists.
 */
export function assertOwnershipCompatible(
  leftStoreId: string | null | undefined,
  rightStoreId: string | null | undefined,
  message: string,
): void {
  if (!isOwnershipCompatible(leftStoreId, rightStoreId)) {
    throw new RabetDataError("CROSS_STORE_REFERENCE", message);
  }
}
