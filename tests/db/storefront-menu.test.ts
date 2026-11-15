import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { botSetting, language } from "@/db/schema";
import {
  initializeSettings,
  readStorefrontMenuSettings,
  resetStorefrontMenuConfig,
  saveStorefrontMenuConfig,
} from "@/lib/data";
import { defaultStorefrontMenuConfig } from "@/lib/storefront/menu";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("storefront_menu");

  const [english] = await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning();

  await initializeSettings(asAppDb(testDb.db), {
    defaultLanguageCode: "en",
    currency: "USD",
    displayName: "Menu Test Store",
  });

  expect(english.id).toBeTruthy();
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db
    .update(botSetting)
    .set({ storefrontMenu: null })
    .where(eq(botSetting.id, 1));
});

describe.skipIf(!shouldRun)("storefront menu persistence", () => {
  it("reads the Phase 28 defaults without writing on page load", async () => {
    const before = await testDb!.db.select().from(botSetting);

    const result = await readStorefrontMenuSettings(asAppDb(testDb!.db));

    expect(result.source).toBe("default");
    expect(result.config).toEqual(defaultStorefrontMenuConfig());

    const after = await testDb!.db.select().from(botSetting);
    expect(after[0].storefrontMenu).toBeNull();
    expect(after[0].updatedAt.getTime()).toBe(before[0].updatedAt.getTime());
  });

  it("persists merchant order and enabled choices", async () => {
    const config = {
      version: 1 as const,
      items: [
        { key: "support" as const, enabled: true },
        { key: "inquiries" as const, enabled: true },
        { key: "products" as const, enabled: false },
        { key: "categories" as const, enabled: true },
        { key: "languages" as const, enabled: true },
      ],
    };

    await saveStorefrontMenuConfig(asAppDb(testDb!.db), config);

    const result = await readStorefrontMenuSettings(asAppDb(testDb!.db));
    expect(result.source).toBe("saved");
    expect(result.config).toEqual(config);
  });

  it("rejects an all-disabled configuration without changing the saved value", async () => {
    const saved = {
      version: 1 as const,
      items: [
        { key: "products" as const, enabled: true },
        { key: "categories" as const, enabled: false },
        { key: "support" as const, enabled: false },
        { key: "languages" as const, enabled: false },
        { key: "inquiries" as const, enabled: false },
      ],
    };
    await saveStorefrontMenuConfig(asAppDb(testDb!.db), saved);

    await expect(
      saveStorefrontMenuConfig(asAppDb(testDb!.db), {
        version: 1,
        items: saved.items.map((item) => ({ ...item, enabled: false })),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const result = await readStorefrontMenuSettings(asAppDb(testDb!.db));
    expect(result.config).toEqual(saved);
  });

  it("resets customization by clearing the stored value", async () => {
    await saveStorefrontMenuConfig(asAppDb(testDb!.db), {
      version: 1,
      items: [
        { key: "support", enabled: true },
        { key: "products", enabled: true },
        { key: "categories", enabled: true },
        { key: "languages", enabled: true },
        { key: "inquiries", enabled: true },
      ],
    });

    const reset = await resetStorefrontMenuConfig(asAppDb(testDb!.db));

    expect(reset).toEqual(defaultStorefrontMenuConfig());
    const rows = await testDb!.db.select().from(botSetting);
    expect(rows[0].storefrontMenu).toBeNull();
  });

  it("falls back safely for malformed stored data and can repair it", async () => {
    await testDb!.db.execute(
      sql`update bot_setting set storefront_menu = '{"unexpected":true}'::jsonb where id = 1`,
    );

    const result = await readStorefrontMenuSettings(asAppDb(testDb!.db));
    expect(result.source).toBe("invalid");
    expect(result.config).toEqual(defaultStorefrontMenuConfig());

    await saveStorefrontMenuConfig(asAppDb(testDb!.db), {
      version: 1,
      items: [
        { key: "products", enabled: true },
        { key: "support", enabled: true },
        { key: "categories", enabled: true },
        { key: "languages", enabled: true },
        { key: "inquiries", enabled: true },
      ],
    });

    const repaired = await readStorefrontMenuSettings(asAppDb(testDb!.db));
    expect(repaired.source).toBe("saved");
    expect(repaired.config.items[0].key).toBe("products");
  });
});
