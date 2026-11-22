import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { MerchantSetup } from "@/components/merchant/merchant-setup";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  readMerchantLocale,
  merchantPageMetadata,
} from "@/lib/merchant/locale-server";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata("setup", "Set up your Rabet store.");
}

export const instant = false;

export default async function MerchantSetupPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const initialLocale = await readMerchantLocale();

  return (
    <MerchantSetup
      storeName={access.store.name}
      email={access.email}
      status={access.store.status}
      readOnly={access.readOnly}
      initialLocale={initialLocale}
    />
  );
}
