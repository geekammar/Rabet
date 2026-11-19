import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  category,
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
import { listCatalogProductsForStore } from "@/lib/data";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { updateMerchantCatalogProductPrice } from "@/lib/merchant/catalog";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "merchant-catalog-password-123";

let testDb: TestDatabase | null = null;
let arabicLanguageId = "";
let englishLanguageId = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_catalog_price");

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
      email: `catalog-admin-${crypto.randomUUID()}@example.test`,
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

  const [ownedCategory] = await db()
    .insert(category)
    .values({
      storeId: accepted.storeId,
      slug: `${storeKey}-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning({ id: category.id });

  const [ownedProduct] = await db()
    .insert(product)
    .values({
      storeId: accepted.storeId,
      categoryId: ownedCategory.id,
      slug: `${storeKey}-product-${crypto.randomUUID()}`,
      price: "10.00",
      isActive: true,
      sortOrder: 10,
    })
    .returning({ id: product.id });

  const [secondProduct] = await db()
    .insert(product)
    .values({
      storeId: accepted.storeId,
      categoryId: ownedCategory.id,
      slug: `${storeKey}-second-${crypto.randomUUID()}`,
      price: "20.00",
      isActive: true,
      sortOrder: 20,
    })
    .returning({ id: product.id });

  const [deletedProduct] = await db()
    .insert(product)
    .values({
      storeId: accepted.storeId,
      categoryId: ownedCategory.id,
      slug: `${storeKey}-deleted-${crypto.randomUUID()}`,
      price: "30.00",
      isActive: true,
      deletedAt: new Date(),
      sortOrder: 30,
    })
    .returning({ id: product.id });

  await db().insert(productTranslation).values([
    {
      productId: ownedProduct.id,
      languageId: arabicLanguageId,
      name: `منتج ${storeName}`,
    },
    {
      productId: ownedProduct.id,
      languageId: englishLanguageId,
      name: `${storeName} product`,
    },
    {
      productId: secondProduct.id,
      languageId: englishLanguageId,
      name: `${storeName} second product`,
    },
  ]);

  return {
    userId: accepted.userId,
    storeId: accepted.storeId,
    categoryId: ownedCategory.id,
    productId: ownedProduct.id,
    secondProductId: secondProduct.id,
    deletedProductId: deletedProduct.id,
  };
}

async function readPrice(productId: string) {
  const [row] = await db()
    .select({ price: product.price })
    .from(product)
    .where(eq(product.id, productId));
  return row.price;
}

/**
 * Commits fixture changes through an independent postgres-js client, so the
 * write under test sees the change on its next statement snapshot exactly as
 * it would see a concurrent revocation, suspension or session-version bump.
 */
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

describe.skipIf(!shouldRun)("merchant catalog price mutation", () => {
  it("lists only the authenticated merchant's own store products", async () => {
    const a = await seedMerchant(
      "catalog.a@example.test",
      "Catalog Store A",
      "catalog-a",
    );
    const b = await seedMerchant(
      "catalog.b@example.test",
      "Catalog Store B",
      "catalog-b",
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const accessB = await resolveMerchantAccess(db(), claims(b.userId));

    expect(accessA?.store.id).toBe(a.storeId);
    expect(accessB?.store.id).toBe(b.storeId);

    const productsA = await listCatalogProductsForStore(
      appDb(),
      accessA!.scope,
    );
    const productsB = await listCatalogProductsForStore(
      appDb(),
      accessB!.scope,
    );

    expect(productsA.map((entry) => entry.id)).toEqual([
      a.productId,
      a.secondProductId,
    ]);
    expect(productsB.map((entry) => entry.id)).toEqual([
      b.productId,
      b.secondProductId,
    ]);
    expect(productsA.some((entry) => entry.id === b.productId)).toBe(false);
    expect(productsB.some((entry) => entry.id === a.productId)).toBe(false);
    expect(productsA[0].translations.ar?.name).toBe("منتج Catalog Store A");
  });

  it("returns the same safe result for missing, foreign and deleted products without writing", async () => {
    const a = await seedMerchant(
      "catalog.safe.a@example.test",
      "Safe Store A",
      "catalog-safe-a",
    );
    const b = await seedMerchant(
      "catalog.safe.b@example.test",
      "Safe Store B",
      "catalog-safe-b",
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const bPriceBefore = await readPrice(b.productId);
    const deletedPriceBefore = await readPrice(a.deletedProductId);

    const missing = await updateMerchantCatalogProductPrice(
      appDb(),
      accessA!,
      { productId: crypto.randomUUID(), price: "1.00" },
    );
    const foreign = await updateMerchantCatalogProductPrice(
      appDb(),
      accessA!,
      { productId: b.productId, price: "1.00" },
    );
    const ineligible = await updateMerchantCatalogProductPrice(
      appDb(),
      accessA!,
      { productId: a.deletedProductId, price: "1.00" },
    );
    const malformed = await updateMerchantCatalogProductPrice(
      appDb(),
      accessA!,
      { productId: "not-a-uuid", price: "1.00" },
    );

    expect(missing).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(foreign).toEqual(missing);
    expect(ineligible).toEqual(missing);
    expect(malformed).toEqual(missing);

    expect(await readPrice(b.productId)).toBe(bPriceBefore);
    expect(await readPrice(a.deletedProductId)).toBe(deletedPriceBefore);
  });

  it("rejects invalid prices before writing and preserves the stored value", async () => {
    const a = await seedMerchant(
      "catalog.invalid@example.test",
      "Invalid Store",
      "catalog-invalid",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readPrice(a.productId);

    for (const price of ["10.123", "-1.00", "1e2", 42, ""]) {
      const result = await updateMerchantCatalogProductPrice(appDb(), access!, {
        productId: a.productId,
        price,
      });

      expect(result).toEqual({ ok: false, error: "INVALID_PRICE" });
      expect(await readPrice(a.productId)).toBe(before);
    }
  });

  it("saves exact zero and cents values as canonical persisted strings", async () => {
    const a = await seedMerchant(
      "catalog.exact@example.test",
      "Exact Store",
      "catalog-exact",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));

    const zero = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.productId,
      price: "0",
    });
    expect(zero).toEqual({
      ok: true,
      productId: a.productId,
      price: "0.00",
    });
    expect(await readPrice(a.productId)).toBe("0.00");

    const cents = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.secondProductId,
      price: "19.9",
    });
    expect(cents).toEqual({
      ok: true,
      productId: a.secondProductId,
      price: "19.90",
    });
    expect(await readPrice(a.secondProductId)).toBe("19.90");

    const persisted = await listCatalogProductsForStore(appDb(), access!.scope);
    expect(persisted.find((entry) => entry.id === a.productId)?.price).toBe(
      "0.00",
    );
    expect(
      persisted.find((entry) => entry.id === a.secondProductId)?.price,
    ).toBe("19.90");
  });

  it("does not write when membership is revoked on a separate connection after access was resolved", async () => {
    const a = await seedMerchant(
      "catalog.bound.revoked@example.test",
      "Bound Revoked Store",
      "catalog-bound-revoked",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readPrice(a.productId);

    expect(access).toMatchObject({ readOnly: false });

    await withSeparateConnection(async (separate) => {
      await separate
        .update(storeMembership)
        .set({ status: "revoked" })
        .where(eq(storeMembership.userId, a.userId));
    });

    const result = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.productId,
      price: "41.00",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readPrice(a.productId)).toBe(before);
  });

  it("does not write when the store is suspended on a separate connection after access was resolved", async () => {
    const a = await seedMerchant(
      "catalog.bound.suspended@example.test",
      "Bound Suspended Store",
      "catalog-bound-suspended",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await readPrice(a.productId);

    expect(access).toMatchObject({
      readOnly: false,
      store: { status: "onboarding" },
    });

    await withSeparateConnection(async (separate) => {
      await separate
        .update(store)
        .set({ status: "suspended" })
        .where(eq(store.id, a.storeId));
    });

    const result = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.productId,
      price: "42.00",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readPrice(a.productId)).toBe(before);
  });

  it("does not write when session_version is stale at the guarded statement", async () => {
    const a = await seedMerchant(
      "catalog.bound.version@example.test",
      "Bound Version Store",
      "catalog-bound-version",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId, 0));
    const before = await readPrice(a.productId);

    expect(access).toMatchObject({ sessionVersion: 0, readOnly: false });

    await withSeparateConnection(async (separate) => {
      await separate
        .update(appUser)
        .set({ sessionVersion: 1 })
        .where(eq(appUser.id, a.userId));
    });

    const result = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.productId,
      price: "43.00",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readPrice(a.productId)).toBe(before);
  });

  it("denies writes for a suspended store resolved at mutation time", async () => {
    const a = await seedMerchant(
      "catalog.suspended@example.test",
      "Suspended Store",
      "catalog-suspended",
    );
    const before = await readPrice(a.productId);

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));

    const access = await resolveMerchantAccess(db(), claims(a.userId));
    expect(access).toMatchObject({ readOnly: true });

    const result = await updateMerchantCatalogProductPrice(appDb(), access!, {
      productId: a.productId,
      price: "99.00",
    });

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await readPrice(a.productId)).toBe(before);
  });

  it("denies a revoked membership and a stale session version at mutation time", async () => {
    const a = await seedMerchant(
      "catalog.revoked@example.test",
      "Revoked Store",
      "catalog-revoked",
    );

    const membership = await db()
      .select({ id: storeMembership.id })
      .from(storeMembership)
      .where(eq(storeMembership.userId, a.userId));

    await db()
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.id, membership[0].id));

    expect(await resolveMerchantAccess(db(), claims(a.userId))).toBeNull();

    await db()
      .update(storeMembership)
      .set({ status: "active" })
      .where(eq(storeMembership.id, membership[0].id));

    await db()
      .update(appUser)
      .set({ sessionVersion: 1 })
      .where(eq(appUser.id, a.userId));

    expect(await resolveMerchantAccess(db(), claims(a.userId, 0))).toBeNull();
    expect(
      await resolveMerchantAccess(db(), claims(a.userId, 1)),
    ).not.toBeNull();
  });
});
