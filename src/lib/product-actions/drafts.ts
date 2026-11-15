export interface ActionTranslationDraft {
  label: string;
  menuText: string;
  templateBody: string;
}

export function createEmptyTranslationDraft(): ActionTranslationDraft {
  return { label: "", menuText: "", templateBody: "" };
}

export function updateTranslationDraft(
  drafts: Record<string, ActionTranslationDraft>,
  languageCode: string,
  patch: Partial<ActionTranslationDraft>,
): Record<string, ActionTranslationDraft> {
  const current = drafts[languageCode] ?? createEmptyTranslationDraft();
  return {
    ...drafts,
    [languageCode]: { ...current, ...patch },
  };
}

export function buildTranslationDrafts(
  translations: Readonly<
    Record<
      string,
      | {
          label?: string | null;
          menuText?: string | null;
          templateBody?: string | null;
        }
      | undefined
    >
  >,
): Record<string, ActionTranslationDraft> {
  const drafts: Record<string, ActionTranslationDraft> = {};

  for (const [code, translation] of Object.entries(translations)) {
    drafts[code] = {
      label: translation?.label ?? "",
      menuText: translation?.menuText ?? "",
      templateBody: translation?.templateBody ?? "",
    };
  }

  return drafts;
}

export function reconcileSavedTranslationDraft(
  drafts: Record<string, ActionTranslationDraft>,
  languageCode: string,
  submittedDraft: ActionTranslationDraft,
  savedTranslation:
    | {
        label?: string | null;
        menuText?: string | null;
        templateBody?: string | null;
      }
    | undefined,
): Record<string, ActionTranslationDraft> {
  const current = drafts[languageCode];

  if (
    current &&
    (current.label !== submittedDraft.label ||
      current.menuText !== submittedDraft.menuText ||
      current.templateBody !== submittedDraft.templateBody)
  ) {
    return drafts;
  }

  return {
    ...drafts,
    [languageCode]: {
      label: savedTranslation?.label ?? "",
      menuText: savedTranslation?.menuText ?? "",
      templateBody: savedTranslation?.templateBody ?? "",
    },
  };
}
