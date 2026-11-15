import type { LanguageRow, ResolvedLanguage } from "@/lib/data";

export interface ActionLanguageTab {
  code: string;
  label: string;
  textDirection: "ltr" | "rtl";
  isDefault: boolean;
}

export function getActionLanguageTabs(
  languages: readonly LanguageRow[],
  defaultLanguage: ResolvedLanguage | null,
): ActionLanguageTab[] {
  const defaultCode = defaultLanguage?.code ?? "en";
  const seenCodes = new Set<string>();
  const tabs: ActionLanguageTab[] = [];

  for (const languageRow of languages) {
    if (seenCodes.has(languageRow.code)) continue;

    const isDefault =
      languageRow.code === defaultCode || languageRow.id === defaultLanguage?.id;

    if (!languageRow.isEnabled && !isDefault) continue;

    seenCodes.add(languageRow.code);
    tabs.push({
      code: languageRow.code,
      label: isDefault ? defaultLanguage?.label ?? languageRow.label : languageRow.label,
      textDirection: languageRow.textDirection === "rtl" ? "rtl" : "ltr",
      isDefault,
    });
  }

  if (!seenCodes.has(defaultCode)) {
    tabs.push({
      code: defaultCode,
      label:
        defaultLanguage?.label ??
        (defaultCode === "ar" ? "العربية" : defaultCode.toUpperCase()),
      textDirection:
        defaultLanguage?.textDirection === "rtl" || defaultCode === "ar" ? "rtl" : "ltr",
      isDefault: true,
    });
  }

  return [
    ...tabs.filter((tab) => tab.isDefault),
    ...tabs.filter((tab) => !tab.isDefault),
  ];
}
