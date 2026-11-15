import { describe, expect, it } from "vitest";

import { collectChangedTranslations } from "@/lib/catalog/translation-draft";

describe("changed translation draft collection", () => {
  const initial = {
    en: { name: "Phone", description: "English short", details: "English full" },
    ar: { name: "هاتف", description: "وصف عربي", details: "تفاصيل عربية" },
  };

  it("returns every modified language, not only the active tab", () => {
    const changed = collectChangedTranslations(
      {
        en: { ...initial.en, description: "English edited" },
        ar: { ...initial.ar, name: "هاتف معدل" },
      },
      initial,
    );

    expect(changed).toHaveLength(2);
    expect(changed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ languageCode: "en", description: "English edited" }),
        expect.objectContaining({ languageCode: "ar", name: "هاتف معدل" }),
      ]),
    );
  });

  it("omits untouched translations so they cannot be overwritten", () => {
    const changed = collectChangedTranslations(
      {
        en: { ...initial.en, name: "Phone Pro" },
        ar: initial.ar,
      },
      initial,
    );

    expect(changed).toEqual([
      {
        languageCode: "en",
        name: "Phone Pro",
        description: "English short",
        details: "English full",
      },
    ]);
  });

  it("omits blank language tabs that do not exist in the saved record", () => {
    const changed = collectChangedTranslations(
      {
        en: initial.en,
        ar: initial.ar,
        fr: { name: "", description: "", details: "" },
      },
      initial,
    );

    expect(changed).toEqual([]);
  });

  it("supports category drafts that do not carry product details", () => {
    const changed = collectChangedTranslations(
      {
        en: { name: "Category EN", description: "English" },
        ar: { name: "فئة", description: "عربي" },
      },
      {
        en: { name: "Category EN", description: "English" },
        ar: { name: "فئة", description: "عربي" },
      },
    );

    expect(changed).toEqual([]);

    const arabicOnly = collectChangedTranslations(
      {
        en: { name: "Category EN", description: "English" },
        ar: { name: "فئة محدثة", description: "عربي" },
      },
      {
        en: { name: "Category EN", description: "English" },
        ar: { name: "فئة", description: "عربي" },
      },
    );

    expect(arabicOnly).toHaveLength(1);
    expect(arabicOnly[0].languageCode).toBe("ar");
  });

  it("includes an explicitly cleared description for an existing translation", () => {
    const changed = collectChangedTranslations(
      {
        en: { ...initial.en, description: "" },
        ar: initial.ar,
      },
      initial,
    );

    expect(changed).toEqual([
      {
        languageCode: "en",
        name: "Phone",
        description: "",
        details: "English full",
      },
    ]);
  });
});
