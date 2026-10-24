/**
 * Action translation status and fallback resolver (DATA_MODEL.md §7).
 *
 * Implements truthful translation status using SAVED translations only:
 * - Selected translation exists: Saved.
 * - Selected translation missing, and default language translation exists:
 *   Missing; falls back to that saved language.
 * - Selected translation and default translation absent:
 *   Missing; no saved fallback available.
 *
 * Draft text must never be presented as persisted fallback content.
 */

export type ActionTranslationStatusKind =
  | "saved"
  | "missing_with_fallback"
  | "missing_no_fallback";

export interface ActionTranslationStatusResult {
  readonly kind: ActionTranslationStatusKind;
  readonly label: string;
  readonly fallbackLanguage?: string;
  readonly isSaved: boolean;
}

export interface ResolveActionStatusOptions {
  readonly currentLang: string;
  readonly savedTranslations: Readonly<
    Record<
      string,
      | { label: string; menuText?: string | null }
      | undefined
    >
  >;
  readonly defaultLanguageCode?: string;
  readonly defaultLanguageLabel?: string;
}

export function resolveActionTranslationStatus({
  currentLang,
  savedTranslations,
  defaultLanguageCode = "en",
  defaultLanguageLabel = "English",
}: ResolveActionStatusOptions): ActionTranslationStatusResult {
  const currentSaved = savedTranslations[currentLang];
  const isCurrentSaved =
    currentSaved !== undefined &&
    typeof currentSaved.label === "string" &&
    currentSaved.label.trim().length > 0;

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
    typeof defaultSaved.label === "string" &&
    defaultSaved.label.trim().length > 0;

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
