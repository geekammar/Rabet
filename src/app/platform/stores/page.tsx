import type { Metadata } from "next";
import { connection } from "next/server";

import { PlatformStoreDirectory } from "@/components/platform/platform-store-directory";
import { getTransactionDb } from "@/db/transaction-client";
import { requirePlatformAdmin } from "@/lib/auth/platform-session";
import {
  listPlatformStores,
  parsePlatformStorePageParam,
} from "@/lib/merchant-invitation/platform-admin";

export const metadata: Metadata = {
  title: "Platform stores",
  description: "Read-only directory of stores, owners and invitations.",
  robots: { index: false, follow: false },
};

export const instant = false;

type PlatformStoresPageProps = {
  searchParams?: Promise<{ page?: string | string[] }>;
};

export default async function PlatformStoresPage({
  searchParams,
}: PlatformStoresPageProps) {
  await connection();

  const admin = await requirePlatformAdmin();
  const params = searchParams ? await searchParams : {};
  const page = parsePlatformStorePageParam(params.page);
  const directory = await listPlatformStores(getTransactionDb(), { page });

  return (
    <PlatformStoreDirectory
      adminEmail={admin.email}
      stores={directory.stores.map((store) => ({
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
      pagination={{
        page: directory.page,
        pageSize: directory.pageSize,
        totalStores: directory.totalStores,
        totalPages: directory.totalPages,
        hasPreviousPage: directory.hasPreviousPage,
        hasNextPage: directory.hasNextPage,
      }}
    />
  );
}
