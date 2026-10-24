import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { botSetting, category, language, product } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  pgErrorMessage,
  type TestDatabase,
} from "./helpers";
import {
  hasCatalogPrices,
  initializeSettings,
  isConfigured,
  readSettings,
  requireSettings,
  updateSettings,
} from "@/lib/data";

/**
 * `bot_setting` data access (DATA_MODEL.md §4.5): the singleton that holds the
 * bot's identity, its single display currency and its default language.
 *
 * Everything here runs against real PostgreSQL so the constraints themselves are
 * exercised — the singleton `CHECK`, the currency allowlist and the
 * default-language relationship — not just the TypeScript that shapes them.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("settings");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("settings — unconfigured state", () => {
  it("reads no settings row before initialization", async () => {
    expect(await readSettings(asAppDb(testDb!.db))).toBeNull();
  });

  it("reports the bot as not configured", async () => {
    expect(await isConfigured(asAppDb(testDb!.db))).toBe(false);
  });

  it("refuses to require settings that were never initialized", async () => {
    await expect(requireSettings(asAppDb(testDb!.db))).rejects.toMatchObject({
      code: "SETTINGS_NOT_INITIALIZED",
    });
  });

  it("refuses to update settings that were never initialized", async () => {
    await expect(
      updateSettings(asAppDb(testDb!.db), { displayName: "Rabet Store" }),
    ).rejects.toMatchObject({ code: "SETTINGS_NOT_INITIALIZED" });
  });

  it("rejects initialization without a registered default language", async () => {
    await expect(
      initializeSettings(asAppDb(testDb!.db), {
        defaultLanguageCode: "en",
        currency: "SAR",
        displayName: "Rabet Store",
      }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
  });

  it("rejects a currency outside the schema allowlist before any query runs", async () => {
    await expect(
      initializeSettings(asAppDb(testDb!.db), {
        defaultLanguageCode: "en",
        currency: "EUR",
        displayName: "Rabet Store",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Nothing was written.
    expect(await readSettings(asAppDb(testDb!.db))).toBeNull();
  });
});

describe.skipIf(!shouldRun)("settings — initialization", () => {
  it("rejects a default language that exists but is disabled", async () => {
    await testDb!.db.insert(language).values({
      code: "xy",
      label: "Example",
      textDirection: "ltr",
      isEnabled: false,
    });

    await expect(
      initializeSettings(asAppDb(testDb!.db), {
        defaultLanguageCode: "xy",
        currency: "SAR",
        displayName: "Rabet Store",
      }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_ENABLED" });

    // The failed initialization left no settings row behind.
    expect(await readSettings(asAppDb(testDb!.db))).toBeNull();
  });

  it("initializes the singleton from explicit owner values", async () => {
    await testDb!.db.insert(language).values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });

    const settings = await initializeSettings(asAppDb(testDb!.db), {
      defaultLanguageCode: "en",
      currency: "SAR",
      displayName: "Rabet Store",
      supportCategory: ["Order issue"],
      supportReplyTime: "within 24 hours",
    });

    expect(settings.id).toBe(1);
    expect(settings.currency).toBe("SAR");
    expect(settings.displayName).toBe("Rabet Store");
    expect(settings.askForLanguage).toBe(true);
    expect(settings.supportCategory).toEqual(["Order issue"]);
    expect(settings.supportReplyTime).toBe("within 24 hours");
    expect(settings.defaultLanguageId).not.toBeNull();
  });

  it("reports the bot as configured afterwards", async () => {
    expect(await isConfigured(asAppDb(testDb!.db))).toBe(true);
  });

  it("rejects a second initialization and leaves the existing row untouched", async () => {
    const before = await readSettings(asAppDb(testDb!.db));

    await expect(
      initializeSettings(asAppDb(testDb!.db), {
        defaultLanguageCode: "en",
        currency: "USD",
        displayName: "A Different Name",
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_ALREADY_INITIALIZED" });

    const after = await readSettings(asAppDb(testDb!.db));

    // The owner's configuration survived the duplicate attempt.
    expect(after?.currency).toBe("SAR");
    expect(after?.displayName).toBe("Rabet Store");
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });
});

describe.skipIf(!shouldRun)("settings — the singleton and its constraints", () => {
  it("refuses a second settings row at the database level", async () => {
    const english = await testDb!.db
      .select({ id: language.id })
      .from(language)
      .where(eq(language.code, "en"))
      .limit(1);

    let error: unknown = null;

    try {
      await testDb!.db.insert(botSetting).values({
        id: 2,
        defaultLanguageId: english[0].id,
        currency: "USD",
        displayName: "Second row",
      });
    } catch (thrown) {
      error = thrown;
    }

    // The singleton `CHECK (id = 1)`, not the primary key, is what fires: id 2
    // is not a duplicate key, it is simply forbidden.
    expect(pgErrorCode(error)).toBe("23514");
    expect(pgErrorMessage(error)).toContain("bot_setting_singleton_check");

    // Exactly one row exists.
    const rows = await testDb!.db.select({ id: botSetting.id }).from(botSetting);
    expect(rows).toHaveLength(1);
  });

  it("refuses a currency outside the allowlist at the database level", async () => {
    const english = await testDb!.db
      .select({ id: language.id })
      .from(language)
      .where(eq(language.code, "en"))
      .limit(1);

    let error: unknown = null;

    try {
      await testDb!.db.insert(botSetting).values({
        id: 1,
        defaultLanguageId: english[0].id,
        currency: "EUR",
        displayName: "Euro store",
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(pgErrorCode(error)).toBe("23514");
    expect(pgErrorMessage(error)).toContain(
      "bot_setting_currency_allowlist_check",
    );
  });
});

describe.skipIf(!shouldRun)("settings — updates", () => {
  it("writes only the provided fields", async () => {
    const updated = await updateSettings(asAppDb(testDb!.db), {
      displayName: "Rabet Store Updated",
      askForLanguage: false,
    });

    expect(updated.displayName).toBe("Rabet Store Updated");
    expect(updated.askForLanguage).toBe(false);
    // Untouched fields keep their values.
    expect(updated.currency).toBe("SAR");
    expect(updated.supportReplyTime).toBe("within 24 hours");
  });

  it("accepts an allowlisted currency", async () => {
    const updated = await updateSettings(asAppDb(testDb!.db), {
      currency: "AED",
    });

    expect(updated.currency).toBe("AED");
  });

  it("rejects an unallowlisted currency before any query runs", async () => {
    await expect(
      updateSettings(asAppDb(testDb!.db), { currency: "GBP" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect((await readSettings(asAppDb(testDb!.db)))?.currency).toBe("AED");
  });

  it("rejects an unknown default language", async () => {
    await expect(
      updateSettings(asAppDb(testDb!.db), { defaultLanguageCode: "zz" }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
  });

  it("rejects a disabled language as the new default", async () => {
    await expect(
      updateSettings(asAppDb(testDb!.db), { defaultLanguageCode: "xy" }),
    ).rejects.toMatchObject({ code: "LANGUAGE_NOT_ENABLED" });
  });

  it("is idempotent: repeating the same update yields the same row", async () => {
    const first = await updateSettings(asAppDb(testDb!.db), {
      displayName: "Stable Name",
    });
    const second = await updateSettings(asAppDb(testDb!.db), {
      displayName: "Stable Name",
    });

    expect(second.displayName).toBe(first.displayName);
    expect(second.currency).toBe(first.currency);
    expect(second.defaultLanguageId).toBe(first.defaultLanguageId);
  });

  it("persists askForLanguage false and toggles back to true", async () => {
    const turnedFalse = await updateSettings(asAppDb(testDb!.db), {
      askForLanguage: false,
    });
    expect(turnedFalse.askForLanguage).toBe(false);

    const reloadedFalse = await readSettings(asAppDb(testDb!.db));
    expect(reloadedFalse?.askForLanguage).toBe(false);

    const turnedTrue = await updateSettings(asAppDb(testDb!.db), {
      askForLanguage: true,
    });
    expect(turnedTrue.askForLanguage).toBe(true);

    const reloadedTrue = await readSettings(asAppDb(testDb!.db));
    expect(reloadedTrue?.askForLanguage).toBe(true);
  });

  it("rejects blank or whitespace-only displayName and preserves stored settings", async () => {
    const before = await readSettings(asAppDb(testDb!.db));

    await expect(
      updateSettings(asAppDb(testDb!.db), { displayName: "" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      updateSettings(asAppDb(testDb!.db), { displayName: "    " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const after = await readSettings(asAppDb(testDb!.db));
    expect(after?.displayName).toBe(before?.displayName);
  });

  it("explicitly clears supportCategory when empty array is provided and preserves when omitted", async () => {
    // Set categories
    await updateSettings(asAppDb(testDb!.db), {
      supportCategory: ["Sales", "Billing"],
    });
    let current = await readSettings(asAppDb(testDb!.db));
    expect(current?.supportCategory).toEqual(["Sales", "Billing"]);

    // Update another field without supportCategory (omitted)
    await updateSettings(asAppDb(testDb!.db), {
      displayName: "Preserved Categories Store",
    });
    current = await readSettings(asAppDb(testDb!.db));
    expect(current?.displayName).toBe("Preserved Categories Store");
    expect(current?.supportCategory).toEqual(["Sales", "Billing"]);

    // Explicitly clear categories
    await updateSettings(asAppDb(testDb!.db), {
      supportCategory: [],
    });
    current = await readSettings(asAppDb(testDb!.db));
    expect(current?.supportCategory).toEqual([]);
  });
});

describe.skipIf(!shouldRun)("settings — catalog price detection for currency safeguards", () => {
  it("detects when catalog contains active prices and when it is empty", async () => {
    const db = asAppDb(testDb!.db);

    // Initial state: no products exist
    expect(await hasCatalogPrices(db)).toBe(false);

    // Insert a category to satisfy foreign key
    const [cat] = await db
      .insert(category)
      .values({
        slug: "test-category",
        isActive: true,
      })
      .returning();

    // Insert a product with a displayed price
    const [prod] = await db
      .insert(product)
      .values({
        categoryId: cat.id,
        slug: "test-product",
        price: "49.99",
        isActive: true,
      })
      .returning();

    // Active product with price exists
    expect(await hasCatalogPrices(db)).toBe(true);

    // Soft delete the product
    await db
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, prod.id));

    // After soft-deletion, no active catalog prices exist
    expect(await hasCatalogPrices(db)).toBe(false);
  });
});
