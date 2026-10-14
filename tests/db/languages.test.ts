import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  botSetting,
  language,
  messageTemplate,
  messageTranslation,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  pgErrorMessage,
  type TestDatabase,
} from "./helpers";
import {
  ensureLanguage,
  listEnabledLanguages,
  listLanguages,
  readLanguage,
  requireDefaultLanguage,
  requireLanguage,
  resolveDefaultLanguage,
  setLanguageEnabled,
} from "@/lib/data";

/**
 * Language data access (DATA_MODEL.md §4.6, §7): the registry of bot languages,
 * the enable/disable gate, and the resolution of the configured default.
 *
 * Policy under test:
 *   - English is the primary/default language; Arabic is optional and RTL.
 *   - Disabling a language preserves its translations.
 *   - The active default language cannot be disabled without choosing another
 *     default first.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("languages");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("languages — registration", () => {
  it("creates a language and reports it as unregistered before that", async () => {
    expect(await readLanguage(asAppDb(testDb!.db), "en")).toBeNull();
    await expect(
      requireLanguage(asAppDb(testDb!.db), "en"),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });

    const created = await ensureLanguage(asAppDb(testDb!.db), {
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });

    expect(created.code).toBe("en");
    expect(created.isEnabled).toBe(true);
  });

  it("is idempotent and never overwrites an existing language", async () => {
    const repeated = await ensureLanguage(asAppDb(testDb!.db), {
      code: "en",
      label: "A completely different label",
      textDirection: "rtl",
      isEnabled: false,
    });

    // The existing row is returned untouched — setup can be re-run safely.
    expect(repeated.label).toBe("English");
    expect(repeated.textDirection).toBe("ltr");
    expect(repeated.isEnabled).toBe(true);
  });

  it("rejects an invalid language code", async () => {
    await expect(
      ensureLanguage(asAppDb(testDb!.db), {
        code: "eng",
        label: "English",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects an invalid text direction", async () => {
    await expect(
      ensureLanguage(asAppDb(testDb!.db), {
        code: "ar",
        label: "العربية",
        textDirection: "ttb",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enforces the text-direction CHECK at the database level", async () => {
    let error: unknown = null;

    try {
      await testDb!.db
        .insert(language)
        .values({ code: "xy", label: "Example", textDirection: "ttb" });
    } catch (thrown) {
      error = thrown;
    }

    expect(pgErrorCode(error)).toBe("23514");
    expect(pgErrorMessage(error)).toContain("language_text_direction_check");
  });
});

describe.skipIf(!shouldRun)("languages — listing and reading", () => {
  it("lists every language, enabled and disabled", async () => {
    await ensureLanguage(asAppDb(testDb!.db), {
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    });

    const codes = (await listLanguages(asAppDb(testDb!.db))).map((row) => row.code);

    expect(codes).toEqual(["ar", "en"]);
  });

  it("lists only enabled languages for the customer-facing set", async () => {
    await setLanguageEnabled(asAppDb(testDb!.db), { code: "ar", isEnabled: false });

    const codes = (await listEnabledLanguages(asAppDb(testDb!.db))).map(
      (row) => row.code,
    );

    expect(codes).toEqual(["en"]);
  });

  it("reads a language by code", async () => {
    const arabic = await readLanguage(asAppDb(testDb!.db), "ar");

    expect(arabic?.label).toBe("العربية");
    expect(arabic?.textDirection).toBe("rtl");
  });

  it("reads nothing for a well-formed but unregistered code", async () => {
    expect(await readLanguage(asAppDb(testDb!.db), "fr")).toBeNull();
  });
});

describe.skipIf(!shouldRun)("languages — enabling and disabling", () => {
  it("enables a disabled language", async () => {
    const enabled = await setLanguageEnabled(asAppDb(testDb!.db), {
      code: "ar",
      isEnabled: true,
    });

    expect(enabled.isEnabled).toBe(true);
  });

  it("is idempotent: enabling an enabled language succeeds", async () => {
    const enabled = await setLanguageEnabled(asAppDb(testDb!.db), {
      code: "ar",
      isEnabled: true,
    });

    expect(enabled.isEnabled).toBe(true);
  });

  it("disabling a language preserves its translations", async () => {
    const arabic = await requireLanguage(asAppDb(testDb!.db), "ar");
    const template = await testDb!.db
      .insert(messageTemplate)
      .values({ key: "greeting" })
      .returning({ id: messageTemplate.id });

    await testDb!.db.insert(messageTranslation).values({
      templateId: template[0].id,
      languageId: arabic.id,
      body: "مرحبا",
    });

    await setLanguageEnabled(asAppDb(testDb!.db), { code: "ar", isEnabled: false });

    const survivors = await testDb!.db
      .select({ body: messageTranslation.body })
      .from(messageTranslation)
      .where(eq(messageTranslation.languageId, arabic.id));

    // The row is still there; only the offering of the language stopped.
    expect(survivors.map((row) => row.body)).toEqual(["مرحبا"]);
  });

  it("refuses to disable an unknown language", async () => {
    await expect(
      setLanguageEnabled(asAppDb(testDb!.db), { code: "fr", isEnabled: true }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
  });
});

describe.skipIf(!shouldRun)("languages — the default language", () => {
  it("reports no default language before settings are initialized", async () => {
    expect(await resolveDefaultLanguage(asAppDb(testDb!.db))).toBeNull();

    await expect(
      requireDefaultLanguage(asAppDb(testDb!.db)),
    ).rejects.toMatchObject({ code: "SETTINGS_NOT_INITIALIZED" });
  });

  it("refuses to disable the configured default language", async () => {
    const english = await requireLanguage(asAppDb(testDb!.db), "en");

    await testDb!.db.insert(botSetting).values({
      id: 1,
      defaultLanguageId: english.id,
      currency: "SAR",
      displayName: "Rabet Store",
    });

    await expect(
      setLanguageEnabled(asAppDb(testDb!.db), { code: "en", isEnabled: false }),
    ).rejects.toMatchObject({ code: "DEFAULT_LANGUAGE_REQUIRED" });

    // English stayed enabled.
    expect((await readLanguage(asAppDb(testDb!.db), "en"))?.isEnabled).toBe(true);
  });

  it("resolves the configured default language", async () => {
    const resolved = await resolveDefaultLanguage(asAppDb(testDb!.db));

    expect(resolved).toMatchObject({ code: "en", label: "English" });
    expect(resolved?.textDirection).toBe("ltr");
  });

  it("allows disabling the default once another default is chosen", async () => {
    await setLanguageEnabled(asAppDb(testDb!.db), { code: "ar", isEnabled: true });

    const arabic = await requireLanguage(asAppDb(testDb!.db), "ar");

    await testDb!.db
      .update(botSetting)
      .set({ defaultLanguageId: arabic.id })
      .where(eq(botSetting.id, 1));

    const disabled = await setLanguageEnabled(asAppDb(testDb!.db), {
      code: "en",
      isEnabled: false,
    });

    expect(disabled.isEnabled).toBe(false);
    expect((await resolveDefaultLanguage(asAppDb(testDb!.db)))?.code).toBe("ar");
  });
});
