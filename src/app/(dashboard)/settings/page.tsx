import type { Metadata } from "next";

import { DatabaseSetupRequired } from "@/components/dashboard/settings/database-setup-required";
import { DatabaseUnavailable } from "@/components/dashboard/settings/database-unavailable";
import { OnboardingForm } from "@/components/dashboard/settings/onboarding-form";
import { SettingsEditForm } from "@/components/dashboard/settings/settings-edit-form";
import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  BotSettings,
  hasCatalogPrices,
  isConfigured,
  LanguageRow,
  listLanguages,
  readSettings,
  ResolvedLanguage,
  resolveDefaultLanguage,
  toSafeErrorMessage,
} from "@/lib/data";

export const metadata: Metadata = {
  title: "Settings",
  description: "Store-wide configuration.",
};

// Navigations into settings block on the server while session and data are loaded.
export const instant = false;

type SettingsViewData =
  | { kind: "database_setup_required" }
  | { kind: "database_unavailable"; message: string }
  | { kind: "onboarding" }
  | {
      kind: "edit";
      settings: BotSettings;
      languages: LanguageRow[];
      defaultLanguage: ResolvedLanguage | null;
      hasCatalogPrices: boolean;
    };

async function loadSettingsViewData(): Promise<SettingsViewData> {
  const rawDbUrl = process.env.DATABASE_URL;
  if (!rawDbUrl || rawDbUrl.trim().length === 0) {
    return { kind: "database_setup_required" };
  }

  try {
    const db = getDb();
    const configured = await isConfigured(db);

    if (!configured) {
      return { kind: "onboarding" };
    }

    const settings = await readSettings(db);
    if (!settings) {
      return { kind: "onboarding" };
    }

    const [languages, defaultLanguage, hasPrices] = await Promise.all([
      listLanguages(db),
      resolveDefaultLanguage(db),
      hasCatalogPrices(db),
    ]);

    return {
      kind: "edit",
      settings,
      languages,
      defaultLanguage,
      hasCatalogPrices: hasPrices,
    };
  } catch (error) {
    return {
      kind: "database_unavailable",
      message: toSafeErrorMessage(error),
    };
  }
}

export default async function SettingsPage() {
  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const data = await loadSettingsViewData();

  switch (data.kind) {
    case "database_setup_required":
      return <DatabaseSetupRequired />;
    case "database_unavailable":
      return <DatabaseUnavailable message={data.message} />;
    case "onboarding":
      return <OnboardingForm />;
    case "edit":
      return (
        <SettingsEditForm
          settings={data.settings}
          languages={data.languages}
          defaultLanguage={data.defaultLanguage}
          hasCatalogPrices={data.hasCatalogPrices}
        />
      );
  }
}
