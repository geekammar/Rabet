import { notFound } from "next/navigation";
import { connection } from "next/server";

import { MerchantStorefrontProfile } from "@/components/merchant/merchant-storefront-profile";
import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import { readMerchantLocale } from "@/lib/merchant/locale-server";
import { readStorefrontProfile } from "@/lib/merchant/storefront-profile";

export const instant = false;

export default async function MerchantStorefrontPage() {
  await connection();
  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const [profile, locale] = await Promise.all([
    readStorefrontProfile(getDb(), access.scope),
    readMerchantLocale(),
  ]);

  return <MerchantStorefrontProfile
    initial={profile} locale={locale} storeName={access.store.name} readOnly={access.readOnly}
  />;
}
