import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  botSetting,
  language,
  store,
  storeCommerceSetting,
  storeMembership,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  readMerchantCommerceSetting,
  saveMerchantCommerceSetting,
} from "@/lib/merchant/store-commerce";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let englishLanguageId = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_commerce_settings");

  const [english] = await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning({ id: language.id });
  englishLanguageId = english.id;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from store_commerce_setting`);
  await testDb.db.execute(sql`delete from bot_setting`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

function db() {
  return testDb!.db;
}

async function seedMerchant(storeStatus: "onboarding" | "active" | "suspended" = "active") {
  const [user] = await db()
    .insert(appUser)
    .values({ email: `commerce-${crypto.randomUUID()}@example.test` })
    .returning({ id: appUser.id });
  const [row] = await db()
    .insert(store)
    .values({
      name: "Commerce Store",
      slug: `commerce-store-${crypto.randomUUID()}`,
      status: storeStatus,
    })
    .returning({ id: store.id });

  await db().insert(storeMembership).values({
    storeId: row.id,
    userId: user.id,
    role: "owner",
    status: "active",
  });

  const access = await resolveMerchantAccess(db(), {
    userId: user.id,
    sessionVersion: 0,
  });

  if (!access) throw new Error("expected merchant access");

  return { access, storeId: row.id, userId: user.id };
}

async function seedVodafoneConfigured(storeId: string, deliveryFee = "15.00") {
  await db().insert(storeCommerceSetting).values({
    storeId,
    currency: "EGP",
    deliveryFee,
    deliveryFeeConfigured: true,
    codEnabled: false,
    vodafoneCashEnabled: true,
    vodafoneCashNumber: "01012345678",
    vodafoneCashAccountName: "Commerce Store",
    vodafoneCashInstructionsAr: "حوّل المبلغ ثم أرسل الإيصال.",
  });
}

describe.skipIf(!shouldRun)("merchant commerce settings", () => {
  it("persists explicit free delivery separately from an unset fee", async () => {
    const merchant = await seedMerchant();
    await seedVodafoneConfigured(merchant.storeId, "15.00");

    const free = await saveMerchantCommerceSetting(db(), merchant.access, {
      codEnabled: true,
      deliveryFee: "0.00",
    });

    expect(free).toMatchObject({
      ok: true,
      setting: {
        codEnabled: true,
        deliveryFee: "0.00",
        deliveryFeeConfigured: true,
        currency: "EGP",
      },
    });

    const [saved] = await db()
      .select({
        deliveryFee: storeCommerceSetting.deliveryFee,
        deliveryFeeConfigured: storeCommerceSetting.deliveryFeeConfigured,
        codEnabled: storeCommerceSetting.codEnabled,
        vodafoneCashEnabled: storeCommerceSetting.vodafoneCashEnabled,
        vodafoneCashNumber: storeCommerceSetting.vodafoneCashNumber,
      })
      .from(storeCommerceSetting)
      .where(eq(storeCommerceSetting.storeId, merchant.storeId));

    expect(saved).toEqual({
      deliveryFee: "0.00",
      deliveryFeeConfigured: true,
      codEnabled: true,
      vodafoneCashEnabled: true,
      vodafoneCashNumber: "01012345678",
    });

    const unset = await saveMerchantCommerceSetting(db(), merchant.access, {
      codEnabled: false,
      deliveryFee: "   ",
    });

    expect(unset).toMatchObject({
      ok: true,
      setting: {
        codEnabled: false,
        deliveryFee: "0.00",
        deliveryFeeConfigured: false,
      },
    });
  });

  it("rejects an invalid delivery fee without changing the saved row", async () => {
    const merchant = await seedMerchant();
    await seedVodafoneConfigured(merchant.storeId, "15.00");

    const result = await saveMerchantCommerceSetting(db(), merchant.access, {
      codEnabled: true,
      deliveryFee: "-1.00",
    });

    expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });

    const setting = await readMerchantCommerceSetting(
      asAppDb(db()),
      merchant.access.scope,
    );
    expect(setting).toEqual({
      currency: "EGP",
      codEnabled: false,
      deliveryFee: "15.00",
      deliveryFeeConfigured: true,
    });
  });

  it("creates the commerce row from the legacy currency when none exists", async () => {
    const merchant = await seedMerchant();
    await db().insert(botSetting).values({
      id: 1,
      storeId: merchant.storeId,
      defaultLanguageId: englishLanguageId,
      currency: "SAR",
      displayName: "Commerce Store",
    });

    const result = await saveMerchantCommerceSetting(db(), merchant.access, {
      codEnabled: true,
      deliveryFee: "12.5",
    });

    expect(result).toMatchObject({
      ok: true,
      setting: {
        currency: "SAR",
        codEnabled: true,
        deliveryFee: "12.50",
        deliveryFeeConfigured: true,
      },
    });
  });

  it("denies a suspended store without writing settings", async () => {
    const merchant = await seedMerchant("suspended");
    await seedVodafoneConfigured(merchant.storeId, "15.00");

    const result = await saveMerchantCommerceSetting(db(), merchant.access, {
      codEnabled: true,
      deliveryFee: "0.00",
    });

    expect(result).toEqual({ ok: false, error: "DENIED" });

    const setting = await readMerchantCommerceSetting(
      asAppDb(db()),
      merchant.access.scope,
    );
    expect(setting).toMatchObject({
      deliveryFee: "15.00",
      deliveryFeeConfigured: true,
      codEnabled: false,
    });
  });
});
