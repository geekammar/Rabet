import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/auth-merchant";
import { appUser, store, storeMembership } from "@/db/schema";
import {
  getTransactionDb,
  type TransactionDatabase,
} from "@/db/transaction-client";
import { STORE_STATUSES, type StoreStatus } from "@/db/schema/tenant";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import {
  createStoreScopeForExistingStore,
  type StoreScope,
} from "@/lib/data/store-scope";

/**
 * The single server-side merchant store resolver.
 *
 * The encrypted merchant JWT carries only the `app_user` id and the
 * `session_version` observed at sign-in. On **every** protected request this
 * module reloads from PostgreSQL and fails closed unless all of the following
 * still hold:
 *
 * - the user exists and is `active`;
 * - `app_user.session_version` equals the JWT claim;
 * - exactly one `store_membership` is active with role `owner`;
 * - the membership's store exists with a known lifecycle status.
 *
 * The result is a trusted, server-minted `StoreScope` plus the verified store
 * metadata. No store id from a URL, form, header or JWT participates: a
 * dashboard URL may carry a store hint, but this resolver never reads it.
 *
 * Zero and multiple active memberships both fail closed. There is no selector
 * and no "first membership" fallback.
 *
 * `cache()` deduplicates the auth read and database round-trip within one
 * request render. It does not survive the request; the next request re-reads
 * every fact above.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MerchantAccess = {
  userId: string;
  email: string;
  sessionVersion: number;
  role: "owner";
  store: {
    id: string;
    name: string;
    slug: string;
    status: StoreStatus;
  };
  scope: StoreScope;
  readOnly: boolean;
};

type MerchantClaims = {
  userId: string;
  sessionVersion: number;
};

type MerchantSessionLike = {
  user?: {
    id?: string;
    role?: "admin" | "merchant";
    sessionVersion?: number;
  } | null;
} | null;

function claimsFromSession(session: MerchantSessionLike): MerchantClaims | null {
  const user = session?.user;

  if (
    !user ||
    user.role !== "merchant" ||
    typeof user.id !== "string" ||
    !UUID_PATTERN.test(user.id) ||
    typeof user.sessionVersion !== "number" ||
    !Number.isInteger(user.sessionVersion) ||
    user.sessionVersion < 0
  ) {
    return null;
  }

  return { userId: user.id, sessionVersion: user.sessionVersion };
}

function isStoreStatus(value: string): value is StoreStatus {
  return (STORE_STATUSES as readonly string[]).includes(value);
}

/**
 * Resolves verified access from database facts for a given identity claim.
 *
 * Exported for PostgreSQL integration tests. Application code must call
 * `requireMerchantAccess()` or `getMerchantAccess()` instead.
 */
export async function resolveMerchantAccess(
  db: TransactionDatabase,
  claims: MerchantClaims,
): Promise<MerchantAccess | null> {
  if (
    !UUID_PATTERN.test(claims.userId) ||
    !Number.isInteger(claims.sessionVersion) ||
    claims.sessionVersion < 0
  ) {
    return null;
  }

  const users = await db
    .select({
      id: appUser.id,
      email: appUser.email,
      status: appUser.status,
      sessionVersion: appUser.sessionVersion,
    })
    .from(appUser)
    .where(eq(appUser.id, claims.userId))
    .limit(1);

  if (users.length !== 1) return null;

  const user = users[0];

  if (
    user.status !== "active" ||
    user.sessionVersion !== claims.sessionVersion
  ) {
    return null;
  }

  const memberships = await db
    .select({
      membershipId: storeMembership.id,
      storeId: store.id,
      storeName: store.name,
      storeSlug: store.slug,
      storeStatus: store.status,
    })
    .from(storeMembership)
    .innerJoin(store, eq(store.id, storeMembership.storeId))
    .where(
      and(
        eq(storeMembership.userId, user.id),
        eq(storeMembership.role, "owner"),
        eq(storeMembership.status, "active"),
      ),
    );

  if (memberships.length !== 1) return null;

  const membership = memberships[0];

  if (!isStoreStatus(membership.storeStatus)) return null;

  const scope = await createStoreScopeForExistingStore(
    db as unknown as Parameters<typeof createStoreScopeForExistingStore>[0],
    membership.storeId,
  );

  return {
    userId: user.id,
    email: user.email,
    sessionVersion: user.sessionVersion,
    role: "owner",
    store: {
      id: membership.storeId,
      name: membership.storeName,
      slug: membership.storeSlug,
      status: membership.storeStatus,
    },
    scope,
    readOnly: membership.storeStatus === "suspended",
  };
}

/**
 * Returns verified merchant access, or `null` when the gate is off, there is
 * no merchant session, or any database fact no longer grants access.
 */
export const getMerchantAccess = cache(
  async (): Promise<MerchantAccess | null> => {
    if (!isMerchantAppEnabled()) return null;

    const session = (await auth()) as MerchantSessionLike;
    const claims = claimsFromSession(session);

    if (!claims) return null;

    try {
      return await resolveMerchantAccess(getTransactionDb(), claims);
    } catch {
      console.error(
        "Merchant access resolution failed; denying merchant access.",
      );
      return null;
    }
  },
);

/**
 * Asserts verified merchant access. Redirects to `/app/login` when the session
 * is absent or no longer valid. The destination is fixed and internal.
 */
export async function requireMerchantAccess(): Promise<MerchantAccess> {
  const access = await getMerchantAccess();

  if (!access) {
    redirect("/app/login");
  }

  return access;
}
