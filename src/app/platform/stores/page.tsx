import type { Metadata } from "next";
import { connection } from "next/server";

import { PlatformStoreDirectory } from "@/components/platform/platform-store-directory";
import { getTransactionDb } from "@/db/transaction-client";
import { requirePlatformAdmin } from "@/lib/auth/platform-session";
import { listPlatformStores } from "@/lib/merchant-invitation/platform-admin";

export const metadata: Metadata = {
  title: "Platform stores",
  description: "Read-only directory of stores, owners and invitations.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function PlatformStoresPage() {
  await connection();

  const admin = await requirePlatformAdmin();
  const stores = await listPlatformStores(getTransactionDb());

  return (
    <PlatformStoreDirectory
      adminEmail={admin.email}
      stores={stores.map((store) => ({
        id: store.id,
        name: store.name,
        slug: store.slug,
        status: store.status,
        ownerEmails: store.ownerEmails,
        latestInvitation: store.latestInvitation
          ? {
              id: store.latestInvitation.id,
              invitedEmail: store.latestInvitation.invitedEmail,
              status: store.latestInvitation.status,
              expiresAt: store.latestInvitation.expiresAt.toISOString(),
              createdAt: store.latestInvitation.createdAt.toISOString(),
              acceptedAt:
                store.latestInvitation.acceptedAt?.toISOString() ?? null,
              revokedAt:
                store.latestInvitation.revokedAt?.toISOString() ?? null,
            }
          : null,
      }))}
    />
  );
}
