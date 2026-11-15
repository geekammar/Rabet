import { describe, expect, it } from "vitest";

import type { LanguageRow, ResolvedLanguage } from "@/lib/data";

import { getCatalogLanguageTabs, getTranslationStatus } from "../language-tabs";

function language(
  code: string,
  label: string,
  isEnabled: boolean,
  textDirection: "ltr" | "rtl" = "ltr",
): LanguageRow {
  const now = new Date("2026-01-01T00:00:00.000Z");

  return {
    id: `lang-${code}`,
    code,
    label,
    textDirection,
    isEnabled,
    createdAt: now,
  };
}

function resolved(
  code: string,
  label: string,
  textDirection: "ltr" | "rtl" = "ltr",
): ResolvedLanguage {
  return {
    id: `lang-${code}`,
    code,
    label,
    textDirection,
  };
}

describe("simplified catalog language tabs", () => {
  it("shows Arabic and English when Arabic is the default", () => {
    const tabs = getCatalogLanguageTabs(
      [language("ar", "العربية", true, "rtl"), language("en", "English", true)],
      resolved("ar", "العربية", "rtl"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["ar", "en"]);
    expect(tabs[0]?.isDefault).toBe(true);
    expect(tabs[0]?.isRtl).toBe(true);
    expect(tabs[1]?.isDefault).toBe(false);
  });

  it("shows English and Arabic when English is the default", () => {
    const tabs = getCatalogLanguageTabs(
      [language("ar", "العربية", true, "rtl"), language("en", "English", true)],
      resolved("en", "English"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["en", "ar"]);
    expect(tabs[0]?.isDefault).toBe(true);
    expect(tabs[1]?.isRtl).toBe(true);
  });

  it("shows only the one enabled language", () => {
    const tabs = getCatalogLanguageTabs(
      [language("ar", "العربية", false, "rtl"), language("en", "English", true)],
      resolved("en", "English"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["en"]);
  });

  it("keeps the default language tab even if the language list is partial", () => {
    const tabs = getCatalogLanguageTabs(
      [language("ar", "العربية", false, "rtl")],
      resolved("ar", "العربية", "rtl"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["ar"]);
    expect(tabs[0]?.isDefault).toBe(true);
  });

  it("reports accurate missing and complete translation status", () => {
    expect(getTranslationStatus(undefined)).toBe("missing");
    expect(getTranslationStatus({ name: "   " })).toBe("missing");
    expect(getTranslationStatus({ name: "منتج" })).toBe("complete");
  });
});
