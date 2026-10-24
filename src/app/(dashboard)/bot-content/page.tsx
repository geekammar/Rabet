import type { Metadata } from "next";
import { connection } from "next/server";

import { BotContentEditor } from "@/components/dashboard/bot-content/bot-content-editor";
import { BotContentStoreSetupRequired } from "@/components/dashboard/bot-content/bot-content-store-setup-required";
import type { SavedTranslation, TemplateData } from "@/components/dashboard/bot-content/types";
import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import { APPROVED_TEMPLATE_KEYS } from "@/lib/bot-content";
import {
  isConfigured,
  listLanguages,
  listTemplates,
  readSettings,
  readTranslations,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export const metadata: Metadata = {
  title: "Bot Content",
  description: "Global bot messages and templates.",
};

// Navigations into bot-content block on the server while session and data are loaded.
export const instant = false;

type BotContentViewData =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "store_setup_required" }
  | {
      kind: "ready";
      settings: NonNullable<Awaited<ReturnType<typeof readSettings>>>;
      defaultLanguage: Awaited<ReturnType<typeof resolveDefaultLanguage>>;
      languages: Awaited<ReturnType<typeof listLanguages>>;
      templatesData: TemplateData[];
    };

async function loadBotContentViewData(): Promise<BotContentViewData> {
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

    const [languages, defaultLanguage, existingTemplates] = await Promise.all([
      listLanguages(db),
      resolveDefaultLanguage(db),
      listTemplates(db),
    ]);

    const templatesData: TemplateData[] = await Promise.all(
      APPROVED_TEMPLATE_KEYS.map(async (key) => {
        const hasTemplate = existingTemplates.some((t) => t.key === key);
        const translations: Record<string, SavedTranslation> = {};

        if (hasTemplate) {
          const transRows = await readTranslations(db, key);
          for (const row of transRows) {
            translations[row.languageCode] = {
              body: row.body,
              updatedAt: row.updatedAt,
            };
          }
        }

        return {
          key,
          translations,
        };
      })
    );

    return {
      kind: "ready",
      settings,
      defaultLanguage,
      languages,
      templatesData,
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}

export default async function BotContentPage() {
  await connection();

  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const data = await loadBotContentViewData();

  switch (data.kind) {
    case "database_setup_required":
      return (
        <DatabaseSetupRequired
          title="Bot Content"
          description="Global bot messages and templates."
        />
      );
    case "database_unavailable":
      return (
        <DatabaseUnavailable
          title="Bot Content"
          description="Global bot messages and templates."
          message={data.message}
        />
      );
    case "store_setup_required":
      return <BotContentStoreSetupRequired />;
    case "ready":
      return (
        <BotContentEditor
          settings={data.settings}
          defaultLanguage={data.defaultLanguage}
          languages={data.languages}
          templatesData={data.templatesData}
        />
      );
  }
}
