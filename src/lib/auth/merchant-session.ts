import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth-merchant";
import type { StoreStatus } from "@/db/schema/tenant";
import {
  getTransactionDb,
  type TransactionDatabase,
} from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import {
  createStoreScopeForExistingStore,
  type StoreScope,
} from "@/lib/data/store-scope";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";

/**
 * The single server-side merchant store resolver.
 *
 * The encrypted merchant JWT carries only the `app_user` id and the
 * `session_version` observed at sign-in. On **every** protected request this
 * module calls the same eligibility rule as sign-in, which reads the current
 * user, platform role, session version, active owner membership and store in
 * one joined statement. It fails closed unless all of those facts still hold.
 *
 * The result is a trusted, server-minted `StoreScope` plus verified store
 * metadata. No store id from a URL, form, header or JWT participates: a
 * dashboard URL may carry a store hint, but this resolver never reads it.
 *
 * Zero and multiple active memberships both fail closed. There is no selector
 * and no "first membership" fallback.
 *
 * `cache()` deduplicates the auth read and database round-trip within one
 * request render. It does not survive the request; the next request re-reads
 * every eligibility fact.
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

/**
 * Resolves verified access from the shared eligibility rule.
 *
 * Exported for PostgreSQL integration tests. Application code must call
 * `requireMerchantAccess()` or `getMerchantAccess()` instead.
 */
export async function resolveMerchantAccess(
  db: TransactionDatabase,
  claims: MerchantClaims,
): Promise<MerchantAccess | null> {
  const eligibility = await resolveMerchantEligibility(db, claims);

  if (!eligibility) return null;

  const scope = await createStoreScopeForExistingStore(
    db,
    eligibility.store.id,
  );

  return {
    userId: eligibility.userId,
    email: eligibility.email,
    sessionVersion: eligibility.sessionVersion,
    role: "owner",
    store: eligibility.store,
    scope,
    readOnly: eligibility.readOnly,
  };
}

/**
 * Returns verified merchant access, or `null` when the gate is off, there is
 * no merchant session, or any eligibility fact no longer grants access.
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
