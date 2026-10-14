import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { language, messageTranslation } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  pgErrorMessage,
  type TestDatabase,
} from "./helpers";
import {
  createTemplate,
  initializeSettings,
  listTemplates,
  readTemplate,
  readTranslations,
  requireLanguage,
  requireTemplate,
  resolveMessageText,
  saveTranslation,
  updateTemplate,
} from "@/lib/data";

/**
 * Message template data access (DATA_MODEL.md §2, §7): stable-keyed global bot
 * strings with one row per language, resolved through the single fallback
 * chain — requested language, then configured default, then an explicit
 * "missing" result. Nothing is ever fabricated.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("templates");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("templates — registration", () => {
  it("creates a template and reports an unknown key as missing", async () => {
    expect(await readTemplate(asAppDb(testDb!.db), "greeting")).toBeNull();

    await expect(
      requireTemplate(asAppDb(testDb!.db), "greeting"),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    const created = await createTemplate(asAppDb(testDb!.db), {
      key: "greeting",
      description: "Sent when the customer starts the bot",
    });

    expect(created.key).toBe("greeting");
    expect(created.description).toBe("Sent when the customer starts the bot");
  });

  it("is idempotent and never overwrites an existing template's description", async () => {
    const repeated = await createTemplate(asAppDb(testDb!.db), {
      key: "greeting",
      description: "A completely different description",
    });

    expect(repeated.description).toBe("Sent when the customer starts the bot");
  });

  it("lists templates ordered by their stable keys", async () => {
    await createTemplate(asAppDb(testDb!.db), { key: "empty_menu" });
    await createTemplate(asAppDb(testDb!.db), { key: "inquiry_received" });

    const keys = (await listTemplates(asAppDb(testDb!.db))).map((row) => row.key);

    expect(keys).toEqual(["empty_menu", "greeting", "inquiry_received"]);
  });

  it("rejects a key that cannot be a stable identifier", async () => {
    await expect(
      createTemplate(asAppDb(testDb!.db), { key: "Not A Key" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(await readTemplate(asAppDb(testDb!.db), "Not A Key")).toBeNull();
  });

  it("updates the description without allowing the key to change", async () => {
    const updated = await updateTemplate(asAppDb(testDb!.db), {
      key: "greeting",
      description: "The bot's first message",
    });

    expect(updated.description).toBe("The bot's first message");

    // There is no path that renames a key; updating an absent key is an error.
    await expect(
      updateTemplate(asAppDb(testDb!.db), {
        key: "absent",
        description: "x",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe.skipIf(!shouldRun)("templates — translations", () => {
  it("saves a validated localized body", async () => {
    await testDb!.db.insert(language).values([
      { code: "en", label: "English", textDirection: "ltr", isEnabled: true },
      {
        code: "ar",
        label: "العربية",
        textDirection: "rtl",
        isEnabled: true,
      },
    ]);

    const saved = await saveTranslation(asAppDb(testDb!.db), {
      templateKey: "greeting",
      languageCode: "en",
      body: "Welcome to the store.",
    });

    expect(saved.body).toBe("Welcome to the store.");
  });

  it("replaces the body when the same language is saved again", async () => {
    const saved = await saveTranslation(asAppDb(testDb!.db), {
      templateKey: "greeting",
      languageCode: "en",
      body: "Welcome back.",
    });

    expect(saved.body).toBe("Welcome back.");

    const translations = await readTranslations(asAppDb(testDb!.db), "greeting");
    expect(translations).toHaveLength(1);
    expect(translations[0].languageCode).toBe("en");
    expect(translations[0].textDirection).toBe("ltr");
  });

  it("keeps exactly one row per template per language", async () => {
    await saveTranslation(asAppDb(testDb!.db), {
      templateKey: "greeting",
      languageCode: "ar",
      body: "مرحبا بك",
    });

    const translations = await readTranslations(asAppDb(testDb!.db), "greeting");

    expect(translations.map((row) => row.languageCode).sort()).toEqual([
      "ar",
      "en",
    ]);

    // Saving English again must not create a second English row.
    await saveTranslation(asAppDb(testDb!.db), {
      templateKey: "greeting",
      languageCode: "en",
      body: "Welcome once more.",
    });

    expect(
      (await readTranslations(asAppDb(testDb!.db), "greeting")).filter(
        (row) => row.languageCode === "en",
      ),
    ).toHaveLength(1);
  });

  it("enforces one row per language at the database level", async () => {
    const template = await requireTemplate(asAppDb(testDb!.db), "greeting");
    const english = await testDb!.db
      .select()
      .from(language)
      .where(eq(language.code, "en"))
      .limit(1);

    let error: unknown = null;

    try {
      await testDb!.db.insert(messageTranslation).values({
        templateId: template.id,
        languageId: english[0].id,
        body: "A duplicate English body.",
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(pgErrorCode(error)).toBe("23505");
    expect(pgErrorMessage(error)).toContain(
      "message_translation_template_language_idx",
    );
  });

  it("reads no translations for a template that has none", async () => {
    await createTemplate(asAppDb(testDb!.db), { key: "empty_menu" });

    expect(await readTranslations(asAppDb(testDb!.db), "empty_menu")).toEqual([]);
  });

  it("rejects a translation for an unknown language", async () => {
    await expect(
      saveTranslation(asAppDb(testDb!.db), {
        templateKey: "greeting",
        languageCode: "fr",
        body: "Bonjour",
      }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
  });

  it("rejects an empty body before any query runs", async () => {
    await expect(
      saveTranslation(asAppDb(testDb!.db), {
        templateKey: "greeting",
        languageCode: "en",
        body: "   ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("accepts a body at the 4096-character limit and rejects one over it", async () => {
    await expect(
      saveTranslation(asAppDb(testDb!.db), {
        templateKey: "greeting",
        languageCode: "en",
        body: "x".repeat(4097),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const saved = await saveTranslation(asAppDb(testDb!.db), {
      templateKey: "greeting",
      languageCode: "en",
      body: "y".repeat(4096),
    });

    expect(saved.body).toHaveLength(4096);
  });

  it("enforces the 4096-character cap at the database level", async () => {
    const template = await requireTemplate(asAppDb(testDb!.db), "empty_menu");
    const arabic = await testDb!.db
      .select()
      .from(language)
      .where(eq(language.code, "ar"))
      .limit(1);

    let error: unknown = null;

    try {
      await testDb!.db.insert(messageTranslation).values({
        templateId: template.id,
        languageId: arabic[0].id,
        body: "z".repeat(4097),
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(pgErrorCode(error)).toBe("23514");
    expect(pgErrorMessage(error)).toContain(
      "message_translation_body_length_check",
    );
  });
});

describe.skipIf(!shouldRun)("templates — the fallback chain", () => {
  // A dedicated template keeps every case's state unambiguous regardless of what
  // the translation tests did to `greeting` earlier in the file.
  it("reports no default language while settings are unconfigured", async () => {
    await createTemplate(asAppDb(testDb!.db), { key: "arabic_only" });

    const arabic = await requireLanguage(asAppDb(testDb!.db), "ar");

    // Only Arabic has a body; English is requested and there is no default to
    // fall back to because the bot has not been initialized.
    await testDb!.db.insert(messageTranslation).values({
      templateId: (await readTemplate(asAppDb(testDb!.db), "arabic_only"))!.id,
      languageId: arabic.id,
      body: "مرحبا بك",
    });

    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "arabic_only",
      languageCode: "en",
    });

    expect(result).toMatchObject({
      status: "missing",
      reason: "no_default_language",
    });
  });

  it("initializes settings with English as the default", async () => {
    const settings = await initializeSettings(asAppDb(testDb!.db), {
      defaultLanguageCode: "en",
      currency: "SAR",
      displayName: "Rabet Store",
    });

    expect(settings.defaultLanguageId).not.toBeNull();
  });

  it("resolves the requested language's body when it exists", async () => {
    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "arabic_only",
      languageCode: "ar",
    });

    expect(result.status).toBe("resolved");

    if (result.status === "resolved") {
      expect(result.body).toBe("مرحبا بك");
      expect(result.languageCode).toBe("ar");
      expect(result.direction).toBe("rtl");
      expect(result.matched).toBe("requested");
    }
  });

  it("reports a missing translation when neither language has a body", async () => {
    // English is requested and is the default, but only Arabic has a body.
    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "arabic_only",
      languageCode: "en",
    });

    expect(result).toMatchObject({
      status: "missing",
      reason: "translation_missing",
      templateKey: "arabic_only",
    });
  });

  it("falls back to the default language when the requested one is missing", async () => {
    await createTemplate(asAppDb(testDb!.db), { key: "english_only" });

    const english = await requireLanguage(asAppDb(testDb!.db), "en");

    await testDb!.db.insert(messageTranslation).values({
      templateId: (await readTemplate(asAppDb(testDb!.db), "english_only"))!.id,
      languageId: english.id,
      body: "Welcome to the store.",
    });

    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "english_only",
      languageCode: "ar",
    });

    expect(result.status).toBe("resolved");

    if (result.status === "resolved") {
      expect(result.body).toBe("Welcome to the store.");
      expect(result.languageCode).toBe("en");
      expect(result.direction).toBe("ltr");
      expect(result.matched).toBe("default");
    }
  });

  it("resolves the default directly when no language is requested", async () => {
    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "english_only",
    });

    expect(result.status).toBe("resolved");

    if (result.status === "resolved") {
      expect(result.languageCode).toBe("en");
      expect(result.matched).toBe("default");
    }
  });

  it("falls back to the default for a well-formed but unregistered language", async () => {
    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "english_only",
      languageCode: "fr",
    });

    expect(result.status).toBe("resolved");

    if (result.status === "resolved") {
      expect(result.matched).toBe("default");
    }
  });

  it("reports a missing template", async () => {
    const result = await resolveMessageText(asAppDb(testDb!.db), {
      templateKey: "does_not_exist",
      languageCode: "en",
    });

    expect(result).toMatchObject({
      status: "missing",
      reason: "template_missing",
      templateKey: "does_not_exist",
    });
  });

  it("rejects a malformed requested language code", async () => {
    await expect(
      resolveMessageText(asAppDb(testDb!.db), {
        templateKey: "english_only",
        languageCode: "eng",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
