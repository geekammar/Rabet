import { describe, expect, it } from "vitest";

import {
  buildTranslationDrafts,
  createEmptyTranslationDraft,
  reconcileSavedTranslationDraft,
  updateTranslationDraft,
} from "../drafts";

describe("product action translation drafts", () => {
  it("keeps unsaved edits isolated per language when switching languages", () => {
    const initial = buildTranslationDrafts({
      ar: { label: "خيارات", menuText: "القائمة", templateBody: null },
      en: { label: "Options", menuText: null, templateBody: null },
    });

    const withArabicDraft = updateTranslationDraft(initial, "ar", {
      label: "خيارات محدثة",
    });
    const withEnglishDraft = updateTranslationDraft(withArabicDraft, "en", {
      label: "Updated options",
    });

    expect(withEnglishDraft.ar).toEqual({
      label: "خيارات محدثة",
      menuText: "القائمة",
      templateBody: "",
    });
    expect(withEnglishDraft.en).toEqual({
      label: "Updated options",
      menuText: "",
      templateBody: "",
    });
  });

  it("creates a missing language draft without mutating another language", () => {
    const initial = buildTranslationDrafts({
      ar: { label: "خيارات" },
    });

    const updated = updateTranslationDraft(initial, "en", { label: "Options" });

    expect(updated.ar).toEqual({
      label: "خيارات",
      menuText: "",
      templateBody: "",
    });
    expect(updated.en).toEqual({
      label: "Options",
      menuText: "",
      templateBody: "",
    });
  });

  it("reconciles only the submitted language after a successful save", () => {
    const drafts = buildTranslationDrafts({
      ar: { label: "مسودة عربية" },
      en: { label: "Old English" },
    });

    const reconciled = reconcileSavedTranslationDraft(
      drafts,
      "en",
      drafts.en,
      { label: "Saved English", menuText: null, templateBody: null },
    );

    expect(reconciled.en?.label).toBe("Saved English");
    expect(reconciled.ar?.label).toBe("مسودة عربية");
  });

  it("does not overwrite text typed while the save was in flight", () => {
    const drafts = buildTranslationDrafts({
      en: { label: "Edited during save" },
    });
    const submitted = { ...createEmptyTranslationDraft(), label: "Submitted" };

    const reconciled = reconcileSavedTranslationDraft(drafts, "en", submitted, {
      label: "Persisted",
    });

    expect(reconciled).toBe(drafts);
    expect(reconciled.en?.label).toBe("Edited during save");
  });
});
