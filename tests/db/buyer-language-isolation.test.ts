import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  appUser,
  botSetting,
  buyerLanguagePreference,
  language,
  store,
  storeMembership,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  readStoreDefaultLanguage,
  readStoreLanguageChoice,
  resolveBuyerLanguage,
  saveBuyerLanguagePreference,
} from "@/lib/data/store-language";
import { saveMerchantStoreLanguage } from "@/lib/merchant/store-language";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let storeAId = "";
let storeBId = "";
let storeCId = "";
let userAId = "";
let userBId = "";
let englishId = "";

const BUYER_A = 98001;
const BUYER_B = 98002;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("buyer_language_isolation");

  const [storeA] = await testDb.db
    .insert(store)
    .values({ name: "Language Store A", slug: "language-store-a", status: "active" })
    .returning();
  const [storeB] = await testDb.db
    .insert(store)
    .values({ name: "Language Store B", slug: "language-store-b", status: "active" })
    .returning();
  const [storeC] = await testDb.db
    .insert(store)
    .values({ name: "Language Store C", slug: "language-store-c", status: "active" })
    .returning();
  const [userA] = await testDb.db
    .insert(appUser)
    .values({ email: "language-a@example.test" })
    .returning();
  const [userB] = await testDb.db
    .insert(appUser)
    .values({ email: "language-b@example.test" })
    .returning();
  const [userC] = await testDb.db
    .insert(appUser)
    .values({ email: "language-c@example.test" })
    .returning();

  await testDb.db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
    { storeId: storeC.id, userId: userC.id, role: "owner", status: "active" },
  ]);

  storeAId = storeA.id;
  storeBId = storeB.id;
  storeCId = storeC.id;
  userAId = userA.id;
  userBId = userB.id;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`delete from buyer_language_preference`);
  await testDb.db.execute(sql`delete from store_language_setting`);
  await testDb.db.execute(sql`delete from bot_setting`);
  await testDb.db.execute(sql`delete from language`);

  const [english] = await testDb.db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  englishId = english.id;
});

function db() {
  return testDb!.db;
}

async function merchantAccess(
  storeId: string,
  userId: string,
  readOnly = false,
) {
  return {
    userId,
    email: `${userId}@example.test`,
    sessionVersion: 0,
    role: "owner" as const,
    store: {
      id: storeId,
      name: "Language Store",
      slug: `language-${storeId}`,
      status: readOnly ? ("suspended" as const) : ("active" as const),
    },
    scope: await readStoreScopeForFixture(db(), storeId),
    readOnly,
  };
}

async function globalLanguageRows() {
  return db().select().from(language).orderBy(language.code);
}

async function preferenceRows() {
  return db().select().from(buyerLanguagePreference);
}

describe.skipIf(!shouldRun)("store language isolation", () => {
  it("stores ar/en UI language without creating or changing global language rows", async () => {
    const accessA = await merchantAccess(storeAId, userAId);

    const saved = await saveMerchantStoreLanguage(
      db() as unknown as TransactionDatabase,
      accessA,
      { code: "ar" },
    );
    expect(saved.ok).toBe(true);

    const rows = await globalLanguageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("en");
    expect(rows[0].isEnabled).toBe(true);

    const choice = await readStoreLanguageChoice(asAppDb(db()), storeAId);
    expect(choice?.code).toBe("ar");

    const buyerDefault = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeAId,
      telegramUserId: BUYER_A,
      profileLanguageCode: "en",
    });
    expect(buyerDefault.locale).toBe("ar");
    expect(buyerDefault.source).toBe("store_default");

    const buyerSaved = await saveBuyerLanguagePreference(
      asAppDb(db()),
      accessA.scope,
      { telegramUserId: BUYER_A, code: "en" },
    );
    expect(buyerSaved.ok).toBe(true);

    const preferences = await preferenceRows();
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({
      storeId: storeAId,
      telegramUserId: BUYER_A,
      locale: "en",
    });

    const buyerChoice = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeAId,
      telegramUserId: BUYER_A,
      profileLanguageCode: "ar",
    });
    expect(buyerChoice.locale).toBe("en");
    expect(buyerChoice.source).toBe("buyer");

    const otherBuyer = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeAId,
      telegramUserId: BUYER_B,
      profileLanguageCode: "en",
    });
    expect(otherBuyer.locale).toBe("ar");
    expect(otherBuyer.source).toBe("store_default");

    const storeBBuyer = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeBId,
      telegramUserId: BUYER_A,
      profileLanguageCode: "ar",
    });
    expect(storeBBuyer.locale).toBe("ar");
    expect(storeBBuyer.source).toBe("profile");

    expect(await globalLanguageRows()).toHaveLength(1);
  });

  it("accepts ar with a disabled global row without enabling it", async () => {
    await db()
      .insert(language)
      .values({ code: "ar", label: "العربية", textDirection: "rtl", isEnabled: false });

    const accessB = await merchantAccess(storeBId, userBId);
    const saved = await saveMerchantStoreLanguage(
      db() as unknown as TransactionDatabase,
      accessB,
      { code: "ar" },
    );
    expect(saved.ok).toBe(true);

    const rows = await globalLanguageRows();
    const arabic = rows.find((row) => row.code === "ar");
    expect(arabic?.isEnabled).toBe(false);

    const choice = await readStoreLanguageChoice(asAppDb(db()), storeBId);
    expect(choice?.code).toBe("ar");

    const buyerSaved = await saveBuyerLanguagePreference(
      asAppDb(db()),
      accessB.scope,
      { telegramUserId: BUYER_B, code: "ar" },
    );
    expect(buyerSaved.ok).toBe(true);

    const preferences = await preferenceRows();
    expect(preferences[0].locale).toBe("ar");

    const buyerChoice = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeBId,
      telegramUserId: BUYER_B,
      profileLanguageCode: "en",
    });
    expect(buyerChoice.locale).toBe("ar");
    expect(buyerChoice.source).toBe("buyer");

    const rowsAfter = await globalLanguageRows();
    expect(rowsAfter.find((row) => row.code === "ar")?.isEnabled).toBe(false);
  });

  it("does not use an unowned legacy singleton as a managed store default", async () => {
    await db().insert(botSetting).values({
      id: 1,
      storeId: null,
      defaultLanguageId: englishId,
      currency: "SAR",
      displayName: "Legacy",
    });

    expect(
      await readStoreDefaultLanguage(asAppDb(db()), storeBId),
    ).toBeNull();

    const buyer = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeBId,
      telegramUserId: BUYER_A,
      profileLanguageCode: "ar",
    });
    expect(buyer.locale).toBe("ar");
    expect(buyer.source).toBe("profile");
  });

  it("keeps a compatible same-store legacy default as fallback", async () => {
    await db().insert(botSetting).values({
      id: 1,
      storeId: storeCId,
      defaultLanguageId: englishId,
      currency: "SAR",
      displayName: "Same Store",
    });

    const fallback = await readStoreDefaultLanguage(asAppDb(db()), storeCId);
    expect(fallback?.code).toBe("en");

    const buyer = await resolveBuyerLanguage(asAppDb(db()), {
      storeId: storeCId,
      telegramUserId: BUYER_A,
      profileLanguageCode: "ar",
    });
    expect(buyer.locale).toBe("en");
    expect(buyer.source).toBe("store_default");
  });

  it("denies a read-only merchant without writing a setting", async () => {
    const access = await merchantAccess(storeAId, userAId, true);
    const denied = await saveMerchantStoreLanguage(
      db() as unknown as TransactionDatabase,
      access,
      { code: "ar" },
    );

    expect(denied).toEqual({ ok: false, error: "DENIED" });
    expect(
      await readStoreLanguageChoice(asAppDb(db()), storeAId),
    ).toBeNull();
  });
});
