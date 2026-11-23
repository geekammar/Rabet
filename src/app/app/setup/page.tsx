import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { MerchantSetup } from "@/components/merchant/merchant-setup";
import { isAndroidUserAgent } from "@/components/merchant/telegram-official-launch";
import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import { isCodAvailable } from "@/lib/commerce/orders";
import { trustedApplicationOrigin } from "@/lib/http/request-origin";
import {
  readMerchantLocale,
  merchantPageMetadata,
} from "@/lib/merchant/locale-server";
import { readMerchantTelegramConnectionState } from "@/lib/telegram/manager-provisioning";

export async function generateMetadata(): Promise<Metadata> {
  return merchantPageMetadata("setup", "Set up your Rabet store.");
}

export const instant = false;

export default async function MerchantSetupPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const initialLocale = await readMerchantLocale();
  const requestHeaders = await headers();
  const telegramLaunchOrigin = trustedApplicationOrigin();
  const isAndroidTelegramLaunch = isAndroidUserAgent(
    requestHeaders.get("user-agent"),
  );
  const db = getDb();
  const [telegramConnection, codAvailability] = await Promise.all([
    readMerchantTelegramConnectionState(db, {
      scope: access.scope,
      merchantUserId: access.userId,
    }),
    isCodAvailable(db, access.scope),
  ]);

  return (
    <MerchantSetup
      storeName={access.store.name}
      email={access.email}
      status={access.store.status}
      readOnly={access.readOnly}
      initialLocale={initialLocale}
      telegramConnection={telegramConnection}
      isAndroidTelegramLaunch={isAndroidTelegramLaunch}
      telegramLaunchOrigin={telegramLaunchOrigin}
      codOrdersEnabled={codAvailability.enabled}
    />
  );
}
