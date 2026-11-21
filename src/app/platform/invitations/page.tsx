import type { Metadata } from "next";
import { connection } from "next/server";

import { PlatformInvitations } from "@/components/platform/platform-invitations";
import { getTransactionDb } from "@/db/transaction-client";
import { requirePlatformAdmin } from "@/lib/auth/platform-session";
import { listPlatformInvitations } from "@/lib/merchant-invitation/platform-admin";

export const metadata: Metadata = {
  title: "Platform invitations",
  description: "Issue and revoke Rabet merchant invitations.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function PlatformInvitationsPage() {
  await connection();

  const admin = await requirePlatformAdmin();
  const invitations = await listPlatformInvitations(getTransactionDb());

  return (
    <PlatformInvitations
      adminEmail={admin.email}
      invitations={invitations.map((invitation) => ({
        id: invitation.id,
        invitedEmail: invitation.invitedEmail,
        storeName: invitation.storeName,
        storeSlug: invitation.storeSlug,
        storeStatus: invitation.storeStatus,
        status: invitation.status,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
        acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
        revokedAt: invitation.revokedAt?.toISOString() ?? null,
        issuedByEmail: invitation.issuedByEmail,
        revokedByEmail: invitation.revokedByEmail,
      }))}
    />
  );
}
