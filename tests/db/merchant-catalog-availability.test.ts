import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
  store,
  storeMembership,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  createTransactionClient,
  type TransactionDatabase,
} from "@/db/transaction-client";
import { listEligibleStorefrontProducts } from "@/lib/catalog/storefront";
import { listCatalogProductsForStore } from "@/lib/data";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { updateMerchantCatalogProductAvailability } from "@/lib/merchant/catalog";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "merchant-catalog-availability-password-123";

let testDb: TestDatabase | null = null;
let arabicLanguageId = "";
let englishLanguageId = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_catalog_availability");

  const [arabic] = await testDb.db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning({ id: language.id });
  const [english] = await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning({ id: language.id });

  arabicLanguageId = arabic.id;
  englishLanguageId = english.id;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

function db() {
  return testDb!.db;
}

function appDb() {
  return asAppDb(db());
}

function claims(userId: string, sessionVersion = 0) {
  return { userId, sessionVersion };
}

async function seedMerchant(
  email: string,
  storeName: string,
  storeKey: string,
) {
  const [admin] = await db()
    .insert(appUser)
    .values({
      email: `availability-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();

  const issued = await issueMerchantInvitation(db(), {
    actorUserId: admin.id,
    storeName,
    storeSlug: `${storeKey}-${crypto.randomUUID()}`,
    invitedEmail: email,
  });

  const accepted = await acceptMerchantInvitation(db(), {
    token: issued.token,
    password: PASSWORD,
  });

  return {
    userId: accepted.userId,
    storeId: accepted.storeId,
  };
}

async function seedCategory(
  storeId: string,
  storeKey: string,
  options: { isActive?: boolean; deleted?: boolean } = {},
) {
  const [row] = await db()
    .insert(category)
    .values({
      storeId,
      slug: `${storeKey}-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive: options.isActive ?? true,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ id: category.id });

  await db().insert(categoryTranslation).values({
    categoryId: row.id,
    languageId: arabicLanguageId,
    name: `قسم ${storeKey}`,
  });

  return row.id;
}

async function seedProduct(
  storeId: string,
  categoryId: string,
  storeKey: string,
  options: {
    price?: string;
    isActive?: boolean;
    deleted?: boolean;
  } = {},
) {
  const [row] = await db()
    .insert(product)
    .values({
      storeId,
      categoryId,
      slug: `${storeKey}-product-${crypto.randomUUID()}`,
      price: options.price ?? "10.00",
      isActive: options.isActive ?? false,
      deletedAt: options.deleted ? new Date() : null,
      sortOrder: nextOrder(),
    })
    .returning({ id: product.id });

  await db().insert(productTranslation).values({
    productId: row.id,
    languageId: englishLanguageId,
    name: `${storeKey} product`,
  });

  return row.id;
}

async function readProductState(productId: string) {
  const [row] = await db()
    .select()
    .from(product)
    .where(eq(product.id, productId));

  const translations = await db()
    .select()
    .from(productTranslation)
    .where(eq(productTranslation.productId, productId))
    .orderBy(productTranslation.id);

  return { row, translations };
}

async function readRevision(productId: string) {
  const [row] = await db()
    .select({
      revision: sql<string>`to_char(${product.updatedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(product)
    .where(eq(product.id, productId));
  return row.revision;
}

async function withSeparateConnection<T>(
  run: (separate: TransactionDatabase) => Promise<T>,
): Promise<T> {
  const client = createTransactionClient(testDb!.url);
  try {
    return await run(client.db);
  } finally {
    await client.close();
  }
}

function expectOnlyAvailabilityChanged(
  before: Awaited<ReturnType<typeof readProductState>>,
  after: Awaited<ReturnType<typeof readProductState>>,
  expectedIsActive: boolean,
) {
  const beforeRest = { ...before.row };
  const afterRest = { ...after.row };

  expect(afterRest.isActive).toBe(expectedIsActive);
  beforeRest.updatedAt = afterRest.updatedAt;
  beforeRest.isActive = afterRest.isActive;
  expect(afterRest).toEqual(beforeRest);
  expect(afterRest.price).toBe(before.row.price);
  expect(afterRest.categoryId).toBe(before.row.categoryId);
  expect(afterRest.storeId).toBe(before.row.storeId);
  expect(afterRest.updatedAt.getTime()).toBeGreaterThanOrEqual(
    before.row.updatedAt.getTime(),
  );
  expect(after.translations).toEqual(before.translations);
}

describe.skipIf(!shouldRun)("merchant catalog availability mutation", () => {
  it("enables and disables an eligible own product during onboarding and in an active store", async () => {
    const a = await seedMerchant(
      "availability.onboarding@example.test",
      "Availability Onboarding Store",
      "availability-onboarding",
    );
    const categoryId = await seedCategory(a.storeId, "availability-onboarding");
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-onboarding",
      { price: "19.90" },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));

    expect(access).toMatchObject({
      readOnly: false,
      store: { status: "onboarding" },
    });

    const beforeEnable = await readProductState(productId);
    const enabled = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      },
    );

    expect(enabled).toEqual({
      ok: true,
      productId,
      isActive: true,
      revision: await readRevision(productId),
    });
    expectOnlyAvailabilityChanged(
      beforeEnable,
      await readProductState(productId),
      true,
    );

    const beforeDisable = await readProductState(productId);
    const disabled = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: false,
        revision: await readRevision(productId),
      },
    );

    expect(disabled).toEqual({
      ok: true,
      productId,
      isActive: false,
      revision: await readRevision(productId),
    });
    expectOnlyAvailabilityChanged(
      beforeDisable,
      await readProductState(productId),
      false,
    );

    await db()
      .update(store)
      .set({ status: "active" })
      .where(eq(store.id, a.storeId));

    const activeAccess = await resolveMerchantAccess(db(), claims(a.userId));
    expect(activeAccess).toMatchObject({
      readOnly: false,
      store: { status: "active" },
    });

    const beforeActiveEnable = await readProductState(productId);
    const enabledInActiveStore =
      await updateMerchantCatalogProductAvailability(appDb(), activeAccess!, {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      });

    expect(enabledInActiveStore).toMatchObject({
      ok: true,
      productId,
      isActive: true,
    });
    expectOnlyAvailabilityChanged(
      beforeActiveEnable,
      await readProductState(productId),
      true,
    );
  });

  it("enables a product under an inactive own-store category without activating the category or changing customer visibility", async () => {
    const a = await seedMerchant(
      "availability.inactive.category@example.test",
      "Inactive Category Store",
      "availability-inactive-category",
    );
    const categoryId = await seedCategory(
      a.storeId,
      "availability-inactive-category",
      { isActive: false },
    );
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-inactive-category",
      { price: "27.50" },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readProductState(productId);
    const [categoryBefore] = await db()
      .select()
      .from(category)
      .where(eq(category.id, categoryId));

    const scopedBefore = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    expect(scopedBefore.find((entry) => entry.id === productId)).toMatchObject({
      isActive: false,
      categoryIsActive: false,
    });

    const enabled = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      },
    );

    expect(enabled).toMatchObject({ ok: true, productId, isActive: true });
    expectOnlyAvailabilityChanged(
      before,
      await readProductState(productId),
      true,
    );

    const [categoryAfter] = await db()
      .select()
      .from(category)
      .where(eq(category.id, categoryId));
    expect(categoryAfter.isActive).toBe(false);
    expect(categoryAfter.isActive).toBe(categoryBefore.isActive);
    expect(categoryAfter.deletedAt).toBe(categoryBefore.deletedAt);
    expect(categoryAfter.updatedAt).toEqual(categoryBefore.updatedAt);

    const [storeAfter] = await db()
      .select()
      .from(store)
      .where(eq(store.id, a.storeId));
    expect(storeAfter.status).toBe("onboarding");

    const scopedAfter = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    expect(scopedAfter.find((entry) => entry.id === productId)).toMatchObject({
      isActive: true,
      categoryIsActive: false,
    });

    const storefront = await listEligibleStorefrontProducts(appDb(), {
      languageId: englishLanguageId,
      defaultLanguageId: englishLanguageId,
      page: 1,
      pageSize: 20,
    });
    expect(storefront.items.some((entry) => entry.id === productId)).toBe(
      false,
    );
  });

  it("returns the same safe not-found result for missing, foreign, soft-deleted, cross-linked and deleted-category rows without writing", async () => {
    const a = await seedMerchant(
      "availability.safe.a@example.test",
      "Availability Safe Store A",
      "availability-safe-a",
    );
    const b = await seedMerchant(
      "availability.safe.b@example.test",
      "Availability Safe Store B",
      "availability-safe-b",
    );
    const categoryAId = await seedCategory(a.storeId, "availability-safe-a");
    const categoryBId = await seedCategory(b.storeId, "availability-safe-b");
    const deletedCategoryAId = await seedCategory(
      a.storeId,
      "availability-safe-a-deleted",
      { deleted: true },
    );
    const productAId = await seedProduct(
      a.storeId,
      categoryAId,
      "availability-safe-a",
    );
    const productBId = await seedProduct(
      b.storeId,
      categoryBId,
      "availability-safe-b",
      { isActive: true },
    );
    const deletedProductId = await seedProduct(
      a.storeId,
      categoryAId,
      "availability-safe-a-deleted-product",
      { deleted: true },
    );
    const crossLinkedProductId = await seedProduct(
      a.storeId,
      categoryBId,
      "availability-safe-a-cross-linked",
      { isActive: true },
    );
    const deletedCategoryProductId = await seedProduct(
      a.storeId,
      deletedCategoryAId,
      "availability-safe-a-deleted-category",
      { isActive: true },
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const accessB = await resolveMerchantAccess(db(), claims(b.userId));

    expect(accessA).not.toBeNull();
    expect(accessB).not.toBeNull();

    const statesBefore = {
      productA: await readProductState(productAId),
      productB: await readProductState(productBId),
      deletedProduct: await readProductState(deletedProductId),
      crossLinkedProduct: await readProductState(crossLinkedProductId),
      deletedCategoryProduct: await readProductState(
        deletedCategoryProductId,
      ),
    };

    const targets = [
      { productId: crypto.randomUUID(), revision: await readRevision(productAId) },
      { productId: productBId, revision: await readRevision(productBId) },
      { productId: deletedProductId, revision: await readRevision(deletedProductId) },
      {
        productId: crossLinkedProductId,
        revision: await readRevision(crossLinkedProductId),
      },
      {
        productId: deletedCategoryProductId,
        revision: await readRevision(deletedCategoryProductId),
      },
    ];

    for (const target of targets) {
      const result = await updateMerchantCatalogProductAvailability(
        appDb(),
        accessA!,
        {
          productId: target.productId,
          isActive: false,
          revision: target.revision,
        },
      );

      expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
      expect(JSON.stringify(result)).not.toContain("availability-safe-b");
      expect(JSON.stringify(result)).not.toContain("10.00");
    }

    expect(await readProductState(productAId)).toEqual(
      statesBefore.productA,
    );
    expect(await readProductState(productBId)).toEqual(
      statesBefore.productB,
    );
    expect(await readProductState(deletedProductId)).toEqual(
      statesBefore.deletedProduct,
    );
    expect(await readProductState(crossLinkedProductId)).toEqual(
      statesBefore.crossLinkedProduct,
    );
    expect(await readProductState(deletedCategoryProductId)).toEqual(
      statesBefore.deletedCategoryProduct,
    );
    expect((await readProductState(productBId)).row.isActive).toBe(true);
  });

  it("rejects malformed inputs before writing anything", async () => {
    const a = await seedMerchant(
      "availability.invalid@example.test",
      "Availability Invalid Store",
      "availability-invalid",
    );
    const categoryId = await seedCategory(a.storeId, "availability-invalid");
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-invalid",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readProductState(productId);
    const revision = await readRevision(productId);

    for (const invalidProductId of [
      "not-a-uuid",
      "",
      null,
      undefined,
      crypto.randomUUID().toUpperCase(),
    ]) {
      const result = await updateMerchantCatalogProductAvailability(
        appDb(),
        access!,
        {
          productId: invalidProductId,
          isActive: true,
          revision,
        },
      );

      expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    }

    for (const invalidBoolean of [
      undefined,
      null,
      "yes",
      "toggle",
      1,
      0,
      {},
      [],
    ]) {
      const result = await updateMerchantCatalogProductAvailability(
        appDb(),
        access!,
        {
          productId,
          isActive: invalidBoolean,
          revision,
        },
      );

      expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
    }

    for (const invalidRevision of [
      undefined,
      null,
      "",
      "2026-11-19T22:42:44.123Z",
      "2026-11-19T22:42:44.123456+00:00",
      123456,
    ]) {
      const result = await updateMerchantCatalogProductAvailability(
        appDb(),
        access!,
        {
          productId,
          isActive: true,
          revision: invalidRevision,
        },
      );

      expect(result).toEqual({ ok: false, error: "INVALID_REVISION" });
    }

    expect(await readProductState(productId)).toEqual(before);
  });

  it("does not write when membership revocation, session-version rotation, a second membership or store suspension is committed after access was resolved", async () => {
    const a = await seedMerchant(
      "availability.bound@example.test",
      "Availability Bound Store",
      "availability-bound",
    );
    const b = await seedMerchant(
      "availability.bound.b@example.test",
      "Availability Bound Store B",
      "availability-bound-b",
    );
    const categoryId = await seedCategory(a.storeId, "availability-bound");
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-bound",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readProductState(productId);

    expect(access).toMatchObject({ readOnly: false, sessionVersion: 0 });

    await withSeparateConnection(async (separate) => {
      await separate
        .update(storeMembership)
        .set({ status: "revoked" })
        .where(eq(storeMembership.userId, a.userId));
    });

    expect(
      await updateMerchantCatalogProductAvailability(appDb(), access!, {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      }),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readProductState(productId)).toEqual(before);

    await withSeparateConnection(async (separate) => {
      await separate
        .update(storeMembership)
        .set({ status: "active" })
        .where(eq(storeMembership.userId, a.userId));
      await separate
        .update(appUser)
        .set({ sessionVersion: 1 })
        .where(eq(appUser.id, a.userId));
    });

    expect(
      await updateMerchantCatalogProductAvailability(appDb(), access!, {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      }),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readProductState(productId)).toEqual(before);

    await withSeparateConnection(async (separate) => {
      await separate
        .update(appUser)
        .set({ sessionVersion: 0 })
        .where(eq(appUser.id, a.userId));
      await separate.insert(storeMembership).values({
        storeId: b.storeId,
        userId: a.userId,
        role: "owner",
        status: "active",
      });
    });

    expect(
      await updateMerchantCatalogProductAvailability(appDb(), access!, {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      }),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readProductState(productId)).toEqual(before);

    await withSeparateConnection(async (separate) => {
      await separate
        .delete(storeMembership)
        .where(
          sql`${storeMembership.userId} = ${a.userId} and ${storeMembership.storeId} = ${b.storeId}`,
        );
      await separate
        .update(store)
        .set({ status: "suspended" })
        .where(eq(store.id, a.storeId));
    });

    expect(
      await updateMerchantCatalogProductAvailability(appDb(), access!, {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      }),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readProductState(productId)).toEqual(before);

    await withSeparateConnection(async (separate) => {
      await separate
        .update(store)
        .set({ status: "onboarding" })
        .where(eq(store.id, a.storeId));
    });

    const enabled = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      },
    );
    expect(enabled).toMatchObject({ ok: true, isActive: true });
  });

  it("cannot overwrite a newer price or availability write with a stale revision", async () => {
    const a = await seedMerchant(
      "availability.stale@example.test",
      "Availability Stale Store",
      "availability-stale",
    );
    const categoryId = await seedCategory(a.storeId, "availability-stale");
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-stale",
      { price: "10.00" },
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const startingRevision = await readRevision(productId);

    await withSeparateConnection(async (separate) => {
      await separate
        .update(product)
        .set({ price: "88.80" })
        .where(eq(product.id, productId));
    });

    const priceWinningRevision = await readRevision(productId);
    expect(priceWinningRevision).not.toBe(startingRevision);

    const staleAfterPrice = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: startingRevision,
      },
    );

    expect(staleAfterPrice).toEqual({
      ok: false,
      error: "CONFLICT",
      current: { isActive: false, revision: priceWinningRevision },
    });

    const afterPriceConflict = await readProductState(productId);
    expect(afterPriceConflict.row.price).toBe("88.80");
    expect(afterPriceConflict.row.isActive).toBe(false);
    expect(await readRevision(productId)).toBe(priceWinningRevision);

    const enabled = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: priceWinningRevision,
      },
    );
    expect(enabled).toMatchObject({ ok: true, isActive: true });
    expect((await readProductState(productId)).row.price).toBe("88.80");

    const beforeAvailabilityWin = await readRevision(productId);
    await withSeparateConnection(async (separate) => {
      await separate
        .update(product)
        .set({ isActive: false })
        .where(eq(product.id, productId));
    });
    const availabilityWinningRevision = await readRevision(productId);
    expect(availabilityWinningRevision).not.toBe(beforeAvailabilityWin);

    const staleAfterAvailability =
      await updateMerchantCatalogProductAvailability(appDb(), access!, {
        productId,
        isActive: true,
        revision: beforeAvailabilityWin,
      });

    expect(staleAfterAvailability).toEqual({
      ok: false,
      error: "CONFLICT",
      current: { isActive: false, revision: availabilityWinningRevision },
    });

    const afterAvailabilityConflict = await readProductState(productId);
    expect(afterAvailabilityConflict.row.isActive).toBe(false);
    expect(afterAvailabilityConflict.row.price).toBe("88.80");
    expect(await readRevision(productId)).toBe(availabilityWinningRevision);

    const retried = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: availabilityWinningRevision,
      },
    );
    expect(retried).toMatchObject({ ok: true, isActive: true });
  });

  it("denies a suspended store resolved at mutation time and leaves every row unchanged", async () => {
    const a = await seedMerchant(
      "availability.suspended@example.test",
      "Availability Suspended Store",
      "availability-suspended",
    );
    const categoryId = await seedCategory(a.storeId, "availability-suspended");
    const productId = await seedProduct(
      a.storeId,
      categoryId,
      "availability-suspended",
    );
    const before = await readProductState(productId);

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));

    const access = await resolveMerchantAccess(db(), claims(a.userId));
    expect(access).toMatchObject({ readOnly: true });

    const result = await updateMerchantCatalogProductAvailability(
      appDb(),
      access!,
      {
        productId,
        isActive: true,
        revision: await readRevision(productId),
      },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await readProductState(productId)).toEqual(before);
  });
});
