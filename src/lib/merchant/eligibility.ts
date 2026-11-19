import "server-only";

import { and, eq } from "drizzle-orm";

import { appUser, store, storeMembership } from "@/db/schema";
import type { StoreStatus } from "@/db/schema/tenant";
import { STORE_STATUSES } from "@/db/schema/tenant";
import type { TransactionDatabase } from "@/db/transaction-client";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MerchantEligibility = {
  userId: string;
  email: string;
  sessionVersion: number;
  membershipId: string;
  store: {
    id: string;
    name: string;
    slug: string;
    status: StoreStatus;
  };
  readOnly: boolean;
};

export type MerchantEligibilityClaim = {
  userId: string;
  sessionVersion: number;
};

function isStoreStatus(value: string): value is StoreStatus {
  return (STORE_STATUSES as readonly string[]).includes(value);
}

/**
 * The single database-backed merchant eligibility rule.
 *
 * One joined statement reads the current user, platform role, session version,
 * active owner membership and store together, so an access decision can never
 * mix facts from different database snapshots. It returns `null` unless all of
 * the following hold:
 *
 * - the user exists, is active and has the plain `user` platform role;
 * - `app_user.session_version` equals the claimed version;
 * - the user has exactly one active owner membership;
 * - that membership's store has a known lifecycle status.
 *
 * `suspended` is eligible and returns `readOnly: true`; zero or multiple
 * memberships, revoked membership, disabled users and platform identities all
 * fail closed.
 */
export async function resolveMerchantEligibility(
  db: TransactionDatabase,
  claim: MerchantEligibilityClaim,
): Promise<MerchantEligibility | null> {
  if (
    !UUID_PATTERN.test(claim.userId) ||
    !Number.isInteger(claim.sessionVersion) ||
    claim.sessionVersion < 0
  ) {
    return null;
  }

  const rows = await db
    .select({
      userId: appUser.id,
      email: appUser.email,
      status: appUser.status,
      platformRole: appUser.platformRole,
      sessionVersion: appUser.sessionVersion,
      membershipId: storeMembership.id,
      membershipRole: storeMembership.role,
      membershipStatus: storeMembership.status,
      storeId: store.id,
      storeName: store.name,
      storeSlug: store.slug,
      storeStatus: store.status,
    })
    .from(appUser)
    .innerJoin(storeMembership, eq(storeMembership.userId, appUser.id))
    .innerJoin(store, eq(store.id, storeMembership.storeId))
    .where(
      and(
        eq(appUser.id, claim.userId),
        eq(appUser.status, "active"),
        eq(appUser.platformRole, "user"),
        eq(appUser.sessionVersion, claim.sessionVersion),
        eq(storeMembership.role, "owner"),
        eq(storeMembership.status, "active"),
      ),
    );

  if (rows.length !== 1) return null;

  const row = rows[0];

  if (!isStoreStatus(row.storeStatus)) return null;

  return {
    userId: row.userId,
    email: row.email,
    sessionVersion: row.sessionVersion,
    membershipId: row.membershipId,
    store: {
      id: row.storeId,
      name: row.storeName,
      slug: row.storeSlug,
      status: row.storeStatus,
    },
    readOnly: row.storeStatus === "suspended",
  };
}
