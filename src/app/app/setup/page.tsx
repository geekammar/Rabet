import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { MerchantSetup } from "@/components/merchant/merchant-setup";
import { isAndroidUserAgent } from "@/components/merchant/telegram-official-launch";
import { getDb } from "@/db/client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import {
  countMerchantOrdersAwaitingAcceptance,
  countMerchantTransfersAwaitingReview,
  isCodAvailable,
  listMerchantOrdersAwaitingAcceptance,
  listMerchantTransfersAwaitingReview,
} from "@/lib/commerce/orders";
import {
  checkMerchantNotificationBotCapability,
  readMerchantNotificationBotState,
} from "@/lib/data/merchant-notification-bot";
import { readStoreDefaultLanguage } from "@/lib/data/store-language";
import { readStoreTelegramSupportUsername } from "@/lib/data/store-telegram-contact";
import { trustedApplicationOrigin } from "@/lib/http/request-origin";
import {
  readMerchantLocale,
  merchantPageMetadata,
} from "@/lib/merchant/locale-server";
import { readMerchantCommerceSetting } from "@/lib/merchant/store-commerce";
import { readVodafoneCashSetting } from "@/lib/merchant/store-vodafone-cash";
import {
  readMerchantNotificationManagedAttemptState,
  readMerchantTelegramConnectionState,
} from "@/lib/telegram/manager-provisioning";

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
  const [
    telegramConnection,
    codAvailability,
    storeDefaultLanguage,
    telegramSupportUsername,
    needsAttentionOrders,
    needsAttentionTotal,
    needsAttentionTransfers,
    needsAttentionTransferTotal,
    vodafoneCashSetting,
    commerceSetting,
    notificationBotCapability,
  ] = await Promise.all([
    readMerchantTelegramConnectionState(db, {
      scope: access.scope,
      merchantUserId: access.userId,
    }),
    isCodAvailable(db, access.scope),
    readStoreDefaultLanguage(db, access.store.id),
    readStoreTelegramSupportUsername(db, access.store.id),
    listMerchantOrdersAwaitingAcceptance(db, access.scope),
    countMerchantOrdersAwaitingAcceptance(db, access.scope),
    listMerchantTransfersAwaitingReview(db, access.scope),
    countMerchantTransfersAwaitingReview(db, access.scope),
    readVodafoneCashSetting(db, access.scope),
    readMerchantCommerceSetting(db, access.scope),
    checkMerchantNotificationBotCapability(db),
  ]);

  const notificationBotState = notificationBotCapability.supported
    ? await readMerchantNotificationBotState(db, access.store.id)
    : null;

  const notificationBotManaged =
    notificationBotCapability.supported && !notificationBotState
      ? await readMerchantNotificationManagedAttemptState(db, {
          storeId: access.store.id,
          merchantUserId: access.userId,
        })
      : null;

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
      needsAttentionOrders={needsAttentionOrders}
      needsAttentionTotal={needsAttentionTotal}
      needsAttentionTransfers={needsAttentionTransfers}
      needsAttentionTransferTotal={needsAttentionTransferTotal}
      vodafoneCashSetting={vodafoneCashSetting}
      commerceSetting={commerceSetting}
      storeDefaultLanguageCode={storeDefaultLanguage?.code === "ar" ? "ar" : "en"}
      telegramSupportUsername={telegramSupportUsername}
      notificationBot={{
        supported: notificationBotCapability.supported,
        state: notificationBotState,
        managed: notificationBotManaged,
      }}
    />
  );
}
