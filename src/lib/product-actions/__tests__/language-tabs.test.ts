import { describe, expect, it } from "vitest";

import type { LanguageRow, ResolvedLanguage } from "@/lib/data";

import { getActionLanguageTabs } from "../language-tabs";

function language(
  code: string,
  label: string,
  isEnabled: boolean,
  textDirection: "ltr" | "rtl" = "ltr",
): LanguageRow {
  return {
    id: `lang-${code}`,
    code,
    label,
    textDirection,
    isEnabled,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
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

describe("getActionLanguageTabs", () => {
  it("shows Arabic and English when Arabic is the default", () => {
    const tabs = getActionLanguageTabs(
      [language("ar", "العربية", true, "rtl"), language("en", "English", true)],
      resolved("ar", "العربية", "rtl"),
    );

    expect(tabs).toEqual([
      { code: "ar", label: "العربية", textDirection: "rtl", isDefault: true },
      { code: "en", label: "English", textDirection: "ltr", isDefault: false },
    ]);
  });

  it("shows English and Arabic when English is the default", () => {
    const tabs = getActionLanguageTabs(
      [language("ar", "العربية", true, "rtl"), language("en", "English", true)],
      resolved("en", "English"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["en", "ar"]);
    expect(tabs[0]?.isDefault).toBe(true);
    expect(tabs[1]?.textDirection).toBe("rtl");
  });

  it("shows every enabled language, not only English and Arabic", () => {
    const tabs = getActionLanguageTabs(
      [
        language("ar", "العربية", true, "rtl"),
        language("en", "English", true),
        language("fr", "Français", true),
        language("es", "Español", false),
      ],
      resolved("ar", "العربية", "rtl"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["ar", "en", "fr"]);
    expect(tabs.some((tab) => tab.code === "es")).toBe(false);
  });

  it("supports a single enabled language", () => {
    const tabs = getActionLanguageTabs(
      [language("ar", "العربية", false, "rtl"), language("en", "English", true)],
      resolved("en", "English"),
    );

    expect(tabs).toEqual([
      { code: "en", label: "English", textDirection: "ltr", isDefault: true },
    ]);
  });

  it("keeps the default language when the language list is partial", () => {
    const tabs = getActionLanguageTabs(
      [language("ar", "العربية", true, "rtl")],
      resolved("en", "English"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["en", "ar"]);
    expect(tabs[0]?.isDefault).toBe(true);
  });

  it("preserves enabled language ordering while keeping the default first", () => {
    const tabs = getActionLanguageTabs(
      [
        language("ar", "العربية", true, "rtl"),
        language("de", "Deutsch", true),
        language("en", "English", true),
        language("fr", "Français", true),
      ],
      resolved("de", "Deutsch"),
    );

    expect(tabs.map((tab) => tab.code)).toEqual(["de", "ar", "en", "fr"]);
    expect(tabs.filter((tab) => tab.isDefault)).toHaveLength(1);
  });

  it("deduplicates repeated language rows by code", () => {
    const tabs = getActionLanguageTabs(
      [
        language("en", "English", true),
        { ...language("en", "English duplicate", true), id: "lang-en-copy" },
      ],
      resolved("en", "English"),
    );

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.code).toBe("en");
  });
});
