import "server-only";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { store } from "@/db/schema";
import { mapDatabaseError, RabetDataError } from "./errors";

/**
 * Trusted store scope (SaaS Phase 1).
 *
 * A `StoreScope` is not a store id with a different name. It is an opaque,
 * server-minted capability whose identity is tracked in module-private state,
 * so a string, a plain `{ storeId }` object, `null` or `undefined` can never be
 * accepted where a scope is required. Even an object that copies the shape is
 * rejected: only the exact object issued here is trusted.
 *
 * Phase 1 has no merchant session. The only issuer is the test fixture, which
 * first proves the seeded store exists in PostgreSQL. No route, Server Action,
 * page, loader or Telegram handler calls this module. A later, separately
 * reviewed slice will mint scopes from an authenticated active membership.
 */

declare const storeScopeBrand: unique symbol;

export type StoreScope = {
  readonly storeId: string;
  readonly [storeScopeBrand]: true;
};

const trustedScopes = new WeakSet<object>();

/**
 * Mints a scope for a store that exists in PostgreSQL.
 *
 * This deliberately reads the `store` table instead of trusting the caller's
 * string: a nonexistent store can never receive a usable scope. The id is not
 * a browser credential — Phase 1 only calls this from test fixtures, and the
 * later production issuer will resolve the store from an authenticated
 * membership rather than from form or URL input.
 *
 * Not exported from the `@/lib/data` barrel, so importing the data layer does
 * not expose scope issuance to application code.
 */
export async function createStoreScopeForExistingStore(
  db: Database,
  storeId: unknown,
): Promise<StoreScope> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "A store id is required to create a store scope.",
    );
  }

  try {
    const rows = await db
      .select({ id: store.id })
      .from(store)
      .where(eq(store.id, storeId))
      .limit(1);

    if (rows.length === 0) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The store does not exist, so no store scope can be issued.",
      );
    }

    const scope = Object.freeze({ storeId: rows[0].id }) as StoreScope;
    trustedScopes.add(scope);

    return scope;
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * Runtime trust check for every scoped data operation.
 *
 * Rejects `null`, `undefined`, raw strings and lookalike plain objects before
 * the caller performs any catalog SQL. The `asserts` signature narrows the
 * value for callers that receive it from an untyped boundary.
 */
export function assertStoreScope(value: unknown): asserts value is StoreScope {
  if (
    typeof value !== "object" ||
    value === null ||
    !trustedScopes.has(value) ||
    typeof (value as { storeId?: unknown }).storeId !== "string" ||
    (value as { storeId: string }).storeId.trim().length === 0
  ) {
    throw new RabetDataError(
      "TENANT_CONTEXT_INVALID",
      "A trusted store scope is required for this operation.",
    );
  }
}
