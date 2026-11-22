import "server-only";

import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { StoreStatus } from "@/db/schema/tenant";
import {
  appUser,
  merchantInvitation,
  store,
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
