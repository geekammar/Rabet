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

  describe("SEND_TEMPLATE_MESSAGE translation and body status", () => {
    it("reports saved when both label and template body are persisted", () => {
      const res = resolveActionTranslationStatus({
        currentLang: "en",
        actionType: "SEND_TEMPLATE_MESSAGE",
        savedTranslations: {
          en: { label: "Info", templateBody: "Hello {{store_name}}" },
        },
      });
      expect(res.isSaved).toBe(true);
      expect(res.isLabelSaved).toBe(true);
      expect(res.isBodySaved).toBe(true);
      expect(res.bodyStatusKind).toBe("saved");
      expect(res.effectiveSavedBody).toBe("Hello {{store_name}}");
    });

    it("distinguishes saved label with fallback template body", () => {
      const res = resolveActionTranslationStatus({
        currentLang: "ar",
        actionType: "SEND_TEMPLATE_MESSAGE",
        savedTranslations: {
          en: { label: "Info", templateBody: "Hello {{store_name}}" },
          ar: { label: "معلومات", templateBody: "" },
        },
        defaultLanguageCode: "en",
        defaultLanguageLabel: "English",
      });
      expect(res.isSaved).toBe(false);
      expect(res.isLabelSaved).toBe(true);
      expect(res.isBodySaved).toBe(false);
      expect(res.bodyStatusKind).toBe("missing_with_fallback");
      expect(res.effectiveSavedBody).toBe("Hello {{store_name}}");
      expect(res.label).toContain("Body falls back to English");
    });

    it("distinguishes saved label with missing body and no fallback", () => {
      const res = resolveActionTranslationStatus({
        currentLang: "ar",
        actionType: "SEND_TEMPLATE_MESSAGE",
        savedTranslations: {
          en: { label: "Info" },
          ar: { label: "معلومات" },
        },
        defaultLanguageCode: "en",
        defaultLanguageLabel: "English",
      });
      expect(res.isSaved).toBe(false);
      expect(res.isLabelSaved).toBe(true);
      expect(res.isBodySaved).toBe(false);
      expect(res.bodyStatusKind).toBe("missing_no_fallback");
      expect(res.effectiveSavedBody).toBe(null);
    });
  });
});
