import type { Metadata } from "next";
import { connection } from "next/server";

import { StorefrontSettingsManager } from "@/components/dashboard/storefront/storefront-settings-manager";
import { CatalogStoreSetupRequired } from "@/components/dashboard/catalog/catalog-store-setup-required";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import { interpolateTemplate } from "@/lib/bot-content/placeholders";
import { hasEligibleStorefrontProducts } from "@/lib/catalog/storefront";
import {
  isConfigured,
  listEnabledLanguages,
  readSettings,
  resolveMessageText,
  toSafeErrorMessage,
} from "@/lib/data";
import {
  resolveStorefrontMenuConfig,
  type StorefrontMenuConfig,
  type StorefrontMenuConfigSource,
} from "@/lib/storefront/menu";

export const metadata: Metadata = {
  title: "Storefront",
  description: "Configure the default customer menu and preview it safely.",
};

export const instant = false;

const PAGE_TITLE = "Storefront";
const PAGE_DESCRIPTION =
  "Choose which customer menu entries appear in Telegram, and in what order.";

type StorefrontViewData =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "store_setup_required" }
  | {
      kind: "ready";
      savedConfig: StorefrontMenuConfig;
      configSource: StorefrontMenuConfigSource;
      displayName: string;
      defaultLanguageCode: string;
      enabledLanguages: Array<{ code: string; label: string; isRtl: boolean }>;
      hasEligibleProducts: boolean;
      welcomeMessages: Record<string, string>;
    };

function fallbackWelcome(displayName: string, isRtl: boolean): string {
  return isRtl ? `مرحبًا بك في ${displayName}!` : `Welcome to ${displayName}!`;
}

async function loadStorefrontViewData(): Promise<StorefrontViewData> {
  const rawDbUrl = process.env.DATABASE_URL;

  if (!rawDbUrl || rawDbUrl.trim().length === 0) {
    return { kind: "database_setup_required" };
  }

  try {
    const db = getDb();
    const configured = await isConfigured(db);

    if (!configured) {
      return { kind: "store_setup_required" };
    }

    const settings = await readSettings(db);
    if (!settings) {
      return { kind: "store_setup_required" };
    }

    const [languages, hasProducts] = await Promise.all([
      listEnabledLanguages(db),
      hasEligibleStorefrontProducts(db),
    ]);

    const orderedLanguages = [...languages].sort((a, b) => {
      if (a.id === settings.defaultLanguageId) return -1;
      if (b.id === settings.defaultLanguageId) return 1;
      return a.code.localeCompare(b.code);
    });

    const defaultLanguage = orderedLanguages.find(
      (languageRow) => languageRow.id === settings.defaultLanguageId,
    ) ?? { code: "en" };

    const welcomeMessages: Record<string, string> = {};

    for (const languageRow of orderedLanguages) {
      const isRtl = languageRow.textDirection === "rtl";
      let text = fallbackWelcome(settings.displayName, isRtl);

      try {
        const resolved = await resolveMessageText(db, {
          templateKey: "bot_welcome",
          languageCode: languageRow.code,
        });

        if (resolved.status === "resolved") {
          text = interpolateTemplate(resolved.body, {
            store_name: settings.displayName,
          });
        }
      } catch {
        // The fallback greeting is safe and representative.
      }

      welcomeMessages[languageRow.code] = text;
    }

    const menu = resolveStorefrontMenuConfig(settings.storefrontMenu);

    return {
      kind: "ready",
      savedConfig: menu.config,
      configSource: menu.source,
      displayName: settings.displayName,
      defaultLanguageCode: defaultLanguage.code,
      enabledLanguages: orderedLanguages.map((languageRow) => ({
        code: languageRow.code,
        label: languageRow.label,
        isRtl: languageRow.textDirection === "rtl",
      })),
      hasEligibleProducts: hasProducts,
      welcomeMessages,
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}

export default async function StorefrontPage() {
  await connection();
  await requireAdmin();

  const data = await loadStorefrontViewData();

  switch (data.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title={PAGE_TITLE}
          description={PAGE_DESCRIPTION}
          message={data.message}
        />
      );
    case "store_setup_required":
      return <CatalogStoreSetupRequired />;
    case "ready":
      return (
        <StorefrontSettingsManager
          savedConfig={data.savedConfig}
          configSource={data.configSource}
          displayName={data.displayName}
          defaultLanguageCode={data.defaultLanguageCode}
          enabledLanguages={data.enabledLanguages}
          visibility={{
            hasEligibleProducts: data.hasEligibleProducts,
            enabledLanguageCount: data.enabledLanguages.length,
          }}
          welcomeMessages={data.welcomeMessages}
        />
      );
  }
}
