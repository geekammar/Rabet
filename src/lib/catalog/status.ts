/**
 * Catalog translation status and fallback resolver (DATA_MODEL.md §7).
 *
 * Implements truthful translation status using SAVED translations only:
 * - Selected translation exists: Saved.
 * - Selected translation missing, and default language translation exists:
 *   Missing; falls back to that saved language.
 * - Selected translation and default translation absent:
 *   Missing; no saved fallback available.
 *
 * Reuses the requested-language -> configured-default -> explicit-missing contract.
 */

export type CatalogTranslationStatusKind =
  | "saved"
  | "missing_with_fallback"
  | "missing_no_fallback";

export interface CatalogTranslationStatusResult {
  readonly kind: CatalogTranslationStatusKind;
  readonly label: string;
  readonly fallbackLanguage?: string;
  readonly isSaved: boolean;
}

export interface ResolveCatalogStatusOptions {
  readonly currentLang: string;
  readonly savedTranslations: Readonly<
    Record<string, { name: string; description?: string | null; details?: string | null } | undefined>
  >;
  readonly defaultLanguageCode?: string;
  readonly defaultLanguageLabel?: string;
}

export function resolveCatalogTranslationStatus({
  currentLang,
  savedTranslations,
  defaultLanguageCode = "en",
  defaultLanguageLabel = "English",
}: ResolveCatalogStatusOptions): CatalogTranslationStatusResult {
  const currentSaved = savedTranslations[currentLang];
  const isCurrentSaved =
    currentSaved !== undefined &&
    typeof currentSaved.name === "string" &&
    currentSaved.name.trim().length > 0;

  if (isCurrentSaved) {
    return {
      kind: "saved",
      label: `Saved (${currentLang.toUpperCase()})`,
      isSaved: true,
    };
  }

  const isDefaultLang = currentLang === defaultLanguageCode;
  const defaultSaved = savedTranslations[defaultLanguageCode];
  const hasSavedDefault =
    defaultSaved !== undefined &&
    typeof defaultSaved.name === "string" &&
    defaultSaved.name.trim().length > 0;

  if (!isDefaultLang && hasSavedDefault) {
    return {
      kind: "missing_with_fallback",
      label: `Missing (${currentLang.toUpperCase()}) — falls back to ${defaultLanguageLabel}`,
      fallbackLanguage: defaultLanguageLabel,
      isSaved: false,
    };
  }

  return {
    kind: "missing_no_fallback",
    label: `Missing (${currentLang.toUpperCase()}) — no saved fallback`,
    isSaved: false,
  };
}
