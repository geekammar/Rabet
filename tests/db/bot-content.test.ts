import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { messageTranslation } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  createTemplate,
  ensureLanguage,
  initializeSettings,
  listLanguages,
  listTemplates,
  readTemplate,
  readTranslations,
  resolveMessageText,
  saveTranslation,
} from "@/lib/data";
import {
  getTemplateDefinition,
  validateTemplateBody,
} from "@/lib/bot-content";

/**
 * Bot Content persistence & save contract on real PostgreSQL (DATA_MODEL.md §2, §7).
 *
 * Verifies:
 * - Missing templates and translations remain honest missing states.
 * - Explicit save creates ONLY the requested template and translation.
 * - Repeated save updates one translation without creating duplicates.
 * - Editing one language preserves the other language translation.
 * - Disabled registered-language translations remain editable without enabling it.
 * - Existing language fallback chain remains unchanged.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("bot_content");

  const appDb = asAppDb(testDb.db);

  // Initialize languages: English enabled, Arabic disabled
  await ensureLanguage(appDb, {
    code: "en",
    label: "English",
    textDirection: "ltr",
    isEnabled: true,
  });

  await ensureLanguage(appDb, {
    code: "ar",
    label: "العربية",
    textDirection: "rtl",
    isEnabled: false,
  });

  // Initialize store settings with English as default language
  await initializeSettings(appDb, {
    displayName: "Rabet Store",
    currency: "USD",
    defaultLanguageCode: "en",
  });
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("bot content — persistence & save contract", () => {
  it("missing templates and translations remain honest missing states", async () => {
    const appDb = asAppDb(testDb!.db);

    // Template bot_welcome does not exist initially
    expect(await readTemplate(appDb, "bot_welcome")).toBeNull();

    // Resolving text for an uncreated template returns template_missing
    const resolved = await resolveMessageText(appDb, {
      templateKey: "bot_welcome",
      languageCode: "en",
    });

    expect(resolved).toEqual({
      status: "missing",
      reason: "template_missing",
      templateKey: "bot_welcome",
    });
  });

  it("explicit save creates ONLY the requested template row and selected translation", async () => {
    const appDb = asAppDb(testDb!.db);

    const key = "bot_welcome";
    const def = getTemplateDefinition(key)!;

    // Validate body before write
    const validation = validateTemplateBody(
      "Welcome to {{store_name}}!",
      key
    );
    expect(validation.valid).toBe(true);

    // Save only this template and English translation
    await createTemplate(appDb, {
      key: def.key,
      description: def.purpose,
    });

    await saveTranslation(appDb, {
      templateKey: def.key,
      languageCode: "en",
      body: "Welcome to {{store_name}}!",
    });

    // Check that ONLY bot_welcome was created in messageTemplate
    const templates = await listTemplates(appDb);
    expect(templates.map((t) => t.key)).toEqual(["bot_welcome"]);

    // Check translations: exactly 1 translation exists (English)
    const translations = await readTranslations(appDb, key);
    expect(translations.length).toBe(1);
    expect(translations[0].languageCode).toBe("en");
    expect(translations[0].body).toBe("Welcome to {{store_name}}!");

    // Arabic translation for bot_welcome does not exist
    expect(translations.some((t) => t.languageCode === "ar")).toBe(false);

    // Resolving Arabic falls back to English (default language)
    const resolvedAr = await resolveMessageText(appDb, {
      templateKey: "bot_welcome",
      languageCode: "ar",
    });

    expect(resolvedAr).toEqual({
      status: "resolved",
      body: "Welcome to {{store_name}}!",
      languageCode: "en",
      direction: "ltr",
      matched: "default",
    });
  });

  it("repeated save updates the existing translation without duplicates", async () => {
    const appDb = asAppDb(testDb!.db);

    const key = "bot_welcome";

    // Initial save was "Welcome to {{store_name}}!"
    const updatedBody = "Welcome to {{store_name}}! Browse our digital items.";

    await saveTranslation(appDb, {
      templateKey: key,
      languageCode: "en",
      body: updatedBody,
    });

    const translations = await readTranslations(appDb, key);
    expect(translations.length).toBe(1);
    expect(translations[0].body).toBe(updatedBody);

    // Direct database query confirming single row
    const rawRows = await testDb!.db
      .select()
      .from(messageTranslation);
    expect(rawRows.length).toBe(1);
  });

  it("editing Arabic preserves English translation", async () => {
    const appDb = asAppDb(testDb!.db);

    const key = "bot_welcome";
    const arabicBody = "مرحبًا بك في {{store_name}}!";

    // Save Arabic translation
    await saveTranslation(appDb, {
      templateKey: key,
      languageCode: "ar",
      body: arabicBody,
    });

    // Both translations now exist
    const translations = await readTranslations(appDb, key);
    expect(translations.length).toBe(2);

    const enTrans = translations.find((t) => t.languageCode === "en");
    const arTrans = translations.find((t) => t.languageCode === "ar");

    expect(enTrans?.body).toBe("Welcome to {{store_name}}! Browse our digital items.");
    expect(arTrans?.body).toBe(arabicBody);
    expect(arTrans?.textDirection).toBe("rtl");

    // Resolving Arabic now returns requested match
    const resolvedAr = await resolveMessageText(appDb, {
      templateKey: key,
      languageCode: "ar",
    });

    expect(resolvedAr).toEqual({
      status: "resolved",
      body: arabicBody,
      languageCode: "ar",
      direction: "rtl",
      matched: "requested",
    });
  });

  it("disabled registered-language translations remain editable without enabling it", async () => {
    const appDb = asAppDb(testDb!.db);

    // Confirm Arabic is disabled in language table
    const languagesBefore = await listLanguages(appDb);
    const arBefore = languagesBefore.find((l) => l.code === "ar")!;
    expect(arBefore.isEnabled).toBe(false);

    // Save translation for a different template in disabled Arabic
    const key = "support_welcome";
    const def = getTemplateDefinition(key)!;

    await createTemplate(appDb, {
      key: def.key,
      description: def.purpose,
    });

    await saveTranslation(appDb, {
      templateKey: def.key,
      languageCode: "ar",
      body: "أهلاً بك في دعم {{store_name}}",
    });

    // Verify Arabic row is still disabled
    const languagesAfter = await listLanguages(appDb);
    const arAfter = languagesAfter.find((l) => l.code === "ar")!;
    expect(arAfter.isEnabled).toBe(false);

    // Verify the translation was persisted
    const trans = await readTranslations(appDb, key);
    expect(trans.length).toBe(1);
    expect(trans[0].languageCode).toBe("ar");
    expect(trans[0].body).toBe("أهلاً بك في دعم {{store_name}}");
  });

  it("existing language fallback chain remains unchanged: requested -> default -> missing", async () => {
    const appDb = asAppDb(testDb!.db);

    const key = "support_welcome";
    // support_welcome has ONLY an Arabic translation so far
    // English (default language) translation is missing

    // 1. Requesting Arabic matches requested
    const resolvedAr = await resolveMessageText(appDb, {
      templateKey: key,
      languageCode: "ar",
    });
    expect(resolvedAr.status).toBe("resolved");
    if (resolvedAr.status === "resolved") {
      expect(resolvedAr.matched).toBe("requested");
      expect(resolvedAr.languageCode).toBe("ar");
    }

    // 2. Requesting English: neither English exists nor does another default exist -> missing
    const resolvedEn = await resolveMessageText(appDb, {
      templateKey: key,
      languageCode: "en",
    });
    expect(resolvedEn).toEqual({
      status: "missing",
      reason: "translation_missing",
      templateKey: key,
    });

    // 3. Requesting an unconfigured language (e.g. "fr"): falls back to default ("en"), which is missing
    const resolvedFr = await resolveMessageText(appDb, {
      templateKey: key,
      languageCode: "fr",
    });
    expect(resolvedFr).toEqual({
      status: "missing",
      reason: "translation_missing",
      templateKey: key,
    });
  });
});
