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
 * For SEND_TEMPLATE_MESSAGE, distinguishes between saved localized label and
 * saved localized message body, correctly reporting fallback or missing state
 * when only the label is present.
 *
 * Draft text must never be presented as persisted fallback content.
 */

import type { SupportedActionType } from "./constants";

export type ActionTranslationStatusKind =
  | "saved"
  | "missing_with_fallback"
  | "missing_no_fallback";

export interface ActionTranslationStatusResult {
  readonly kind: ActionTranslationStatusKind;
  readonly label: string;
  readonly fallbackLanguage?: string;
  readonly isSaved: boolean;
  readonly isLabelSaved?: boolean;
  readonly isBodySaved?: boolean;
  readonly bodyStatusKind?: ActionTranslationStatusKind;
  readonly bodyStatusLabel?: string;
  readonly effectiveSavedBody?: string | null;
}

export interface ResolveActionStatusOptions {
  readonly currentLang: string;
  readonly savedTranslations: Readonly<
    Record<
      string,
      | { label: string; menuText?: string | null; templateBody?: string | null }
      | undefined
    >
  >;
  readonly actionType?: SupportedActionType;
  readonly defaultLanguageCode?: string;
  readonly defaultLanguageLabel?: string;
}

export function resolveActionTranslationStatus({
  currentLang,
  savedTranslations,
  actionType,
  defaultLanguageCode = "en",
  defaultLanguageLabel = "English",
}: ResolveActionStatusOptions): ActionTranslationStatusResult {
  const currentSaved = savedTranslations[currentLang];
  const isLabelSaved =
    currentSaved !== undefined &&
    typeof currentSaved.label === "string" &&
    currentSaved.label.trim().length > 0;

  const isBodySaved =
    currentSaved !== undefined &&
    typeof currentSaved.templateBody === "string" &&
    currentSaved.templateBody.trim().length > 0;

  const isDefaultLang = currentLang === defaultLanguageCode;
  const defaultSaved = savedTranslations[defaultLanguageCode];

  const hasSavedDefaultLabel =
    defaultSaved !== undefined &&
    typeof defaultSaved.label === "string" &&
    defaultSaved.label.trim().length > 0;

  const hasSavedDefaultBody =
    defaultSaved !== undefined &&
    typeof defaultSaved.templateBody === "string" &&
    defaultSaved.templateBody.trim().length > 0;

  let bodyStatusKind: ActionTranslationStatusKind = "missing_no_fallback";
  let bodyStatusLabel = `Missing (${currentLang.toUpperCase()}) — no saved fallback`;
  let effectiveSavedBody: string | null = null;

  if (isBodySaved) {
    bodyStatusKind = "saved";
    bodyStatusLabel = `Saved (${currentLang.toUpperCase()})`;
    effectiveSavedBody = currentSaved!.templateBody!.trim();
  } else if (!isDefaultLang && hasSavedDefaultBody) {
    bodyStatusKind = "missing_with_fallback";
    bodyStatusLabel = `Missing (${currentLang.toUpperCase()}) — falls back to ${defaultLanguageLabel}`;
    effectiveSavedBody = defaultSaved!.templateBody!.trim();
  }

  // SEND_TEMPLATE_MESSAGE evaluation: requires distinguishing label and message body
  if (actionType === "SEND_TEMPLATE_MESSAGE") {
    if (isLabelSaved && isBodySaved) {
      return {
        kind: "saved",
        label: `Saved (${currentLang.toUpperCase()})`,
        isSaved: true,
        isLabelSaved: true,
        isBodySaved: true,
        bodyStatusKind,
        bodyStatusLabel,
        effectiveSavedBody,
      };
    }

    if (isLabelSaved && !isBodySaved) {
      if (!isDefaultLang && hasSavedDefaultBody) {
        return {
          kind: "missing_with_fallback",
          label: `Label saved (${currentLang.toUpperCase()}) • Body falls back to ${defaultLanguageLabel}`,
          fallbackLanguage: defaultLanguageLabel,
          isSaved: false,
          isLabelSaved: true,
          isBodySaved: false,
          bodyStatusKind,
          bodyStatusLabel,
          effectiveSavedBody,
        };
      }
      return {
        kind: "missing_no_fallback",
        label: `Label saved (${currentLang.toUpperCase()}) • Body missing (no fallback)`,
        isSaved: false,
        isLabelSaved: true,
        isBodySaved: false,
        bodyStatusKind,
        bodyStatusLabel,
        effectiveSavedBody,
      };
    }

    if (!isLabelSaved && !isDefaultLang && hasSavedDefaultLabel) {
      return {
        kind: "missing_with_fallback",
        label: `Missing (${currentLang.toUpperCase()}) — falls back to ${defaultLanguageLabel}`,
        fallbackLanguage: defaultLanguageLabel,
        isSaved: false,
        isLabelSaved: false,
        isBodySaved,
        bodyStatusKind,
        bodyStatusLabel,
        effectiveSavedBody,
      };
    }

    return {
      kind: "missing_no_fallback",
      label: `Missing (${currentLang.toUpperCase()}) — no saved fallback`,
      isSaved: false,
      isLabelSaved: false,
      isBodySaved,
      bodyStatusKind,
      bodyStatusLabel,
      effectiveSavedBody,
    };
  }

  // Non-message action types: status driven by label
  if (isLabelSaved) {
    return {
      kind: "saved",
      label: `Saved (${currentLang.toUpperCase()})`,
      isSaved: true,
    };
  }

  if (!isDefaultLang && hasSavedDefaultLabel) {
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
