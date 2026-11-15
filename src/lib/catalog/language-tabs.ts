import type { LanguageRow, ResolvedLanguage } from "@/lib/data";

/**
 * Catalog languages the simplified Products and Categories forms can edit.
 *
 * The catalog editor contract currently supports English and Arabic. Tabs are
 * derived from the store's registered language rows and their enabled state, so
 * the default language is not assumed to be English and an English default with
 * Arabic enabled shows both tabs just like an Arabic default with English
 * enabled.
 */
export const CATALOG_LANGUAGE_CODES = ["en", "ar"] as const;

export type CatalogLanguageCode = (typeof CATALOG_LANGUAGE_CODES)[number];

export interface CatalogLanguageTab {
  code: string;
  label: string;
  isRtl: boolean;
  isDefault: boolean;
}

function isSupportedCatalogLanguage(code: string): boolean {
  return (CATALOG_LANGUAGE_CODES as readonly string[]).includes(code);
}

export function getCatalogLanguageTabs(
  languages: LanguageRow[],
  defaultLanguage: ResolvedLanguage | null,
): CatalogLanguageTab[] {
  const tabs: CatalogLanguageTab[] = [];
  const seenIds = new Set<string>();

  for (const languageRow of languages) {
    const isDefault = languageRow.id === defaultLanguage?.id;

    if (!isSupportedCatalogLanguage(languageRow.code)) continue;
    if (!languageRow.isEnabled && !isDefault) continue;
    if (seenIds.has(languageRow.id)) continue;

    seenIds.add(languageRow.id);
    tabs.push({
      code: languageRow.code,
      label: isDefault ? defaultLanguage?.label ?? languageRow.label : languageRow.label,
      isRtl: languageRow.textDirection === "rtl" || languageRow.code === "ar",
      isDefault,
    });
  }

  if (defaultLanguage && !tabs.some((tab) => tab.code === defaultLanguage.code)) {
    tabs.push({
      code: defaultLanguage.code,
      label: defaultLanguage.label,
      isRtl: defaultLanguage.textDirection === "rtl" || defaultLanguage.code === "ar",
      isDefault: true,
    });
  }

  return tabs.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.code.localeCompare(b.code);
  });
}

export function getTranslationStatus(
  values: { name?: string } | undefined,
): "missing" | "complete" {
  return values?.name?.trim() ? "complete" : "missing";
}
