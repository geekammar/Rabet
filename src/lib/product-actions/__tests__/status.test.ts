import { describe, expect, it } from "vitest";

import { resolveActionTranslationStatus } from "../status";

describe("resolveActionTranslationStatus", () => {
  it("reports 'Saved' when the requested language translation is present", () => {
    const res = resolveActionTranslationStatus({
      currentLang: "en",
      savedTranslations: {
        en: { label: "Choose Options" },
      },
    });
    expect(res).toEqual({
      kind: "saved",
      label: "Saved (EN)",
      isSaved: true,
    });
  });

  it("reports 'Missing — falls back' when current language is missing but default language is saved", () => {
    const res = resolveActionTranslationStatus({
      currentLang: "ar",
      savedTranslations: {
        en: { label: "Choose Options" },
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(res).toEqual({
      kind: "missing_with_fallback",
      label: "Missing (AR) — falls back to English",
      fallbackLanguage: "English",
      isSaved: false,
    });
  });

  it("reports 'Missing — no saved fallback' when both current and default language translations are missing", () => {
    const res = resolveActionTranslationStatus({
      currentLang: "ar",
      savedTranslations: {},
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(res).toEqual({
      kind: "missing_no_fallback",
      label: "Missing (AR) — no saved fallback",
      isSaved: false,
    });
  });

  it("does not report fallback when the default language itself is missing", () => {
    const res = resolveActionTranslationStatus({
      currentLang: "en",
      savedTranslations: {},
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(res).toEqual({
      kind: "missing_no_fallback",
      label: "Missing (EN) — no saved fallback",
      isSaved: false,
    });
  });
});
