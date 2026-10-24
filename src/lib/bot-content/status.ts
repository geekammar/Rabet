/**
 * ===========================================================================
 * Bot Content Translation Status & Truthful Fallback Resolver (DATA_MODEL.md §7)
 * ===========================================================================
 *
 * Implements truthful translation status using SAVED translations only:
 * - Selected translation exists: Saved.
 * - Selected translation missing, and a different configured-default translation exists:
 *   Missing; falls back to that saved language.
 * - Selected translation and usable default translation absent:
 *   Missing; no saved fallback available.
 *
 * Rules:
 * 1. A draft or suggested text MUST NEVER count as saved fallback.
 * 2. Selecting the default language itself must never imply fallback to its own missing translation.
 * 3. Fallback resolution strictly follows: requested language -> configured default -> explicit missing.
 */

export type TemplateStatusKind =
  | "saved"
  | "missing_with_fallback"
  | "missing_no_fallback";

export interface TemplateStatusResult {
  readonly kind: TemplateStatusKind;
  readonly label: string;
  readonly fallbackLanguage?: string;
  readonly isSaved: boolean;
}

export interface ResolveStatusOptions {
  readonly currentLang: string;
  readonly savedTranslations: Readonly<Record<string, string | undefined>>;
  readonly defaultLanguageCode?: string;
  readonly defaultLanguageLabel?: string;
}

/**
 * Resolves the truthful status of a message template for the currently active language.
 */
export function resolveTranslationStatus({
  currentLang,
  savedTranslations,
  defaultLanguageCode = "en",
  defaultLanguageLabel = "English",
}: ResolveStatusOptions): TemplateStatusResult {
  const currentSaved = savedTranslations[currentLang];
  const isCurrentSaved =
    typeof currentSaved === "string" && currentSaved.trim().length > 0;

  if (isCurrentSaved) {
    return {
      kind: "saved",
      label: `Saved (${currentLang.toUpperCase()})`,
      isSaved: true,
    };
  }

  // Translation for currentLang is missing.
  // Check if a DIFFERENT configured default language has a SAVED translation.
  const isDefaultLang = currentLang === defaultLanguageCode;
  const defaultSaved = savedTranslations[defaultLanguageCode];
  const hasSavedDefault =
    typeof defaultSaved === "string" && defaultSaved.trim().length > 0;

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
