import { describe, expect, it } from "vitest";
import { resolveTranslationStatus } from "../status";

describe("resolveTranslationStatus (Truthful Missing/Fallback Status)", () => {
  it("reports 'saved' when the selected translation exists in savedTranslations", () => {
    const resultEn = resolveTranslationStatus({
      currentLang: "en",
      savedTranslations: {
        en: "Welcome to Acme!",
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(resultEn).toEqual({
      kind: "saved",
      label: "Saved (EN)",
      isSaved: true,
    });

    const resultAr = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: {
        en: "Welcome to Acme!",
        ar: "مرحبًا بك في Acme!",
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(resultAr).toEqual({
      kind: "saved",
      label: "Saved (AR)",
      isSaved: true,
    });
  });

  it("reports 'missing_with_fallback' when selected translation is missing but saved default exists", () => {
    const result = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: {
        en: "Welcome to Acme!",
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(result).toEqual({
      kind: "missing_with_fallback",
      label: "Missing (AR) — falls back to English",
      fallbackLanguage: "English",
      isSaved: false,
    });
  });

  it("reports 'missing_no_fallback' when both selected translation and default translation are absent", () => {
    const result = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: {},
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(result).toEqual({
      kind: "missing_no_fallback",
      label: "Missing (AR) — no saved fallback",
      isSaved: false,
    });
  });

  it("reports 'missing_no_fallback' when selecting the default language itself and its translation is absent", () => {
    // English is the default language, and English is missing.
    // It must NEVER claim to fall back to English.
    const result = resolveTranslationStatus({
      currentLang: "en",
      savedTranslations: {
        ar: "مرحبًا بك!",
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(result).toEqual({
      kind: "missing_no_fallback",
      label: "Missing (EN) — no saved fallback",
      isSaved: false,
    });
  });

  it("does not treat empty or whitespace-only saved translations as saved", () => {
    const result = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: {
        en: "   ",
        ar: "",
      },
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });

    expect(result).toEqual({
      kind: "missing_no_fallback",
      label: "Missing (AR) — no saved fallback",
      isSaved: false,
    });
  });

  it("updates truthfully when default translation is saved after initially missing", () => {
    const initialSaved: Record<string, string> = {};

    // Initial state: Arabic missing, English missing
    const initialAr = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: initialSaved,
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(initialAr.kind).toBe("missing_no_fallback");

    // After saving English
    const updatedSaved = { ...initialSaved, en: "Welcome to Acme!" };
    const updatedAr = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: updatedSaved,
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(updatedAr).toEqual({
      kind: "missing_with_fallback",
      label: "Missing (AR) — falls back to English",
      fallbackLanguage: "English",
      isSaved: false,
    });

    // After saving Arabic
    const finalSaved = { ...updatedSaved, ar: "مرحبًا!" };
    const finalAr = resolveTranslationStatus({
      currentLang: "ar",
      savedTranslations: finalSaved,
      defaultLanguageCode: "en",
      defaultLanguageLabel: "English",
    });
    expect(finalAr).toEqual({
      kind: "saved",
      label: "Saved (AR)",
      isSaved: true,
    });
  });

  it("handles non-English configured default language correctly", () => {
    // Suppose store default was Arabic ('ar') and Arabic is saved, English is missing
    const result = resolveTranslationStatus({
      currentLang: "en",
      savedTranslations: {
        ar: "مرحبًا!",
      },
      defaultLanguageCode: "ar",
      defaultLanguageLabel: "العربية",
    });

    expect(result).toEqual({
      kind: "missing_with_fallback",
      label: "Missing (EN) — falls back to العربية",
      fallbackLanguage: "العربية",
      isSaved: false,
    });
  });
});
