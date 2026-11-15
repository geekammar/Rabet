export interface TranslationDraftValues {
  name: string;
  description: string;
  details?: string;
}

export interface TranslationDraftUpdate {
  languageCode: string;
  name: string;
  description: string;
  details?: string;
}

function normalize(value: string | undefined): string {
  return value ?? "";
}

export function collectChangedTranslations(
  current: Record<string, TranslationDraftValues>,
  initial: Record<string, TranslationDraftValues>,
): TranslationDraftUpdate[] {
  const changed: TranslationDraftUpdate[] = [];

  for (const [languageCode, values] of Object.entries(current)) {
    const previous = initial[languageCode] ?? {
      name: "",
      description: "",
      details: "",
    };

    if (
      normalize(values.name) === normalize(previous.name) &&
      normalize(values.description) === normalize(previous.description) &&
      normalize(values.details) === normalize(previous.details)
    ) {
      continue;
    }

    changed.push({
      languageCode,
      name: values.name,
      description: values.description,
      details: values.details,
    });
  }

  return changed;
}
