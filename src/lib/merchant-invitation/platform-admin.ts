import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { StoreStatus } from "@/db/schema/tenant";
import {
  appUser,
  merchantInvitation,
  store,
  storeMembership,
} from "@/db/schema";
import type { MerchantInvitationDb } from "@/lib/merchant-invitation/service";

/**
 * Read model for the platform invitation page.
 *
 * This loader is read-only and never selects `token_digest`: once an
 * invitation is issued, the raw token is returned only to the issuing caller
 * and is not recoverable from this listing. Every invitation row, including
 * accepted, revoked and expired rows, remains available as its own audit
 * record with the issuing and revoking identities and timestamps.
 */

export type PlatformInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export type PlatformInvitationRecord = {
  id: string;
  invitedEmail: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeStatus: StoreStatus;
  status: PlatformInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  issuedByEmail: string;
  revokedByEmail: string | null;
};

export const PLATFORM_INVITATION_LIST_LIMIT = 200;

type InvitationStatusInput = {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
};

/**
 * Derives the operator-visible status with the same precedence as the
 * service: acceptance wins, then revocation, then expiry.
 */
export function platformInvitationStatus(
  invitation: InvitationStatusInput,
  now: number = Date.now(),
): PlatformInvitationStatus {
  if (invitation.acceptedAt !== null) return "accepted";
  if (invitation.revokedAt !== null) return "revoked";
  if (invitation.expiresAt.getTime() <= now) return "expired";
  return "pending";
}

export async function listPlatformInvitations(
  db: MerchantInvitationDb,
  options: { limit?: number } = {},
): Promise<PlatformInvitationRecord[]> {
  const requestedLimit = options.limit ?? PLATFORM_INVITATION_LIST_LIMIT;
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), PLATFORM_INVITATION_LIST_LIMIT)
    : PLATFORM_INVITATION_LIST_LIMIT;

  const issuer = alias(appUser, "invitation_issuer");
  const revoker = alias(appUser, "invitation_revoker");

  const rows = await db
    .select({
      id: merchantInvitation.id,
      invitedEmail: merchantInvitation.invitedEmail,
      storeId: merchantInvitation.storeId,
      storeName: store.name,
      storeSlug: store.slug,
      storeStatus: store.status,
      expiresAt: merchantInvitation.expiresAt,
      createdAt: merchantInvitation.createdAt,
      acceptedAt: merchantInvitation.acceptedAt,
      revokedAt: merchantInvitation.revokedAt,
      issuedByEmail: issuer.email,
      revokedByEmail: revoker.email,
    })
    .from(merchantInvitation)
    .innerJoin(store, eq(store.id, merchantInvitation.storeId))
    .innerJoin(issuer, eq(issuer.id, merchantInvitation.invitedByUserId))
    .leftJoin(revoker, eq(revoker.id, merchantInvitation.revokedByUserId))
    .orderBy(desc(merchantInvitation.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    invitedEmail: row.invitedEmail,
    storeId: row.storeId,
    storeName: row.storeName,
    storeSlug: row.storeSlug,
    storeStatus: row.storeStatus as StoreStatus,
    status: platformInvitationStatus(row),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    issuedByEmail: row.issuedByEmail,
    revokedByEmail: row.revokedByEmail,
  }));
}


export const PLATFORM_STORE_LIST_LIMIT = 200;
export const PLATFORM_STORE_INVITATION_SCAN_LIMIT = 2000;

export type PlatformStoreInvitationSummary = {
  id: string;
  invitedEmail: string;
  status: PlatformInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export type PlatformStoreDirectoryRecord = {
  id: string;
  name: string;
  slug: string;
  status: StoreStatus;
  ownerEmails: string[];
  latestInvitation: PlatformStoreInvitationSummary | null;
};

/**
 * Read-only store directory for platform administration.
 *
 * The query starts from `store` and merges owners and invitations in memory so
 * multiple memberships or invitations can never duplicate a store row. No
 * credential, token digest or password material is selected.
 */
export async function listPlatformStores(
  db: MerchantInvitationDb,
  options: { limit?: number } = {},
): Promise<PlatformStoreDirectoryRecord[]> {
  const requestedLimit = options.limit ?? PLATFORM_STORE_LIST_LIMIT;
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), PLATFORM_STORE_LIST_LIMIT)
    : PLATFORM_STORE_LIST_LIMIT;

  const storeRows = await db
    .select({
      id: store.id,
      name: store.name,
      slug: store.slug,
      status: store.status,
    })
    .from(store)
    .orderBy(asc(store.createdAt), asc(store.name))
    .limit(limit);

  if (storeRows.length === 0) return [];

  const storeIds = storeRows.map((row) => row.id);

  const membershipRows = await db
    .select({
      storeId: storeMembership.storeId,
      email: appUser.email,
    })
    .from(storeMembership)
    .innerJoin(appUser, eq(appUser.id, storeMembership.userId))
    .where(
      and(
        inArray(storeMembership.storeId, storeIds),
        eq(storeMembership.status, "active"),
      ),
    )
    .orderBy(asc(storeMembership.createdAt));

  const invitationRows = await db
    .select({
      id: merchantInvitation.id,
      storeId: merchantInvitation.storeId,
      invitedEmail: merchantInvitation.invitedEmail,
      expiresAt: merchantInvitation.expiresAt,
      createdAt: merchantInvitation.createdAt,
      acceptedAt: merchantInvitation.acceptedAt,
      revokedAt: merchantInvitation.revokedAt,
    })
    .from(merchantInvitation)
    .where(inArray(merchantInvitation.storeId, storeIds))
    .orderBy(desc(merchantInvitation.createdAt))
    .limit(PLATFORM_STORE_INVITATION_SCAN_LIMIT);

  const ownersByStore = new Map<string, string[]>();
  const seenOwner = new Set<string>();

  for (const membership of membershipRows) {
    const key = `${membership.storeId}:${membership.email.toLowerCase()}`;
    if (seenOwner.has(key)) continue;
    seenOwner.add(key);
    const owners = ownersByStore.get(membership.storeId) ?? [];
    owners.push(membership.email);
    ownersByStore.set(membership.storeId, owners);
  }

  const latestInvitationByStore = new Map<
    string,
    PlatformStoreInvitationSummary
  >();

  for (const invitation of invitationRows) {
    if (latestInvitationByStore.has(invitation.storeId)) continue;
    latestInvitationByStore.set(invitation.storeId, {
      id: invitation.id,
      invitedEmail: invitation.invitedEmail,
      status: platformInvitationStatus(invitation),
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
    });
  }

  return storeRows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as StoreStatus,
    ownerEmails: ownersByStore.get(row.id) ?? [],
    latestInvitation: latestInvitationByStore.get(row.id) ?? null,
  }));
}
