import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  botSetting,
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
import {
  listCatalogCategoriesForStore,
  listCatalogProductsForStore,
  resolveDefaultLanguage,
} from "@/lib/data";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import {
  createMerchantCatalogProduct,
  resolveMerchantCatalogLanguage,
  type MerchantCatalogLanguage,
} from "@/lib/merchant/product-create";
import { resolveMerchantProductName } from "@/lib/merchant/product-display";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "merchant-product-create-password-123";

let testDb: TestDatabase | null = null;
let arabicLanguageId = "";
let merchantLanguage: MerchantCatalogLanguage;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_product_create");

  const [arabic] = await testDb.db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning({ id: language.id });
  await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });

  arabicLanguageId = arabic.id;
  merchantLanguage = (await resolveMerchantCatalogLanguage(asAppDb(testDb.db)))!;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from bot_setting`);
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from product_action_translation`);
  await testDb.db.execute(sql`delete from product_action`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category_translation`);
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
      email: `product-create-admin-${crypto.randomUUID()}@example.test`,
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

async function seedCategory(storeId: string, name: string, deleted = false) {
  const [row] = await db()
    .insert(category)
    .values({
      storeId,
      slug: `fixture-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive: true,
      deletedAt: deleted ? new Date() : null,
    })
    .returning({ id: category.id });

  await db().insert(categoryTranslation).values({
    categoryId: row.id,
    languageId: arabicLanguageId,
    name,
  });

  return row.id;
}

async function counts() {
  const [row] = await db().execute<{
    categories: number;
    category_translations: number;
    products: number;
    product_translations: number;
  }>(sql`
    select
      (select count(*)::int from category) as categories,
      (select count(*)::int from category_translation) as category_translations,
      (select count(*)::int from product) as products,
      (select count(*)::int from product_translation) as product_translations
  `);

  return row;
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

describe.skipIf(!shouldRun)("merchant first product creation", () => {
  it("creates the first category and first product together for an empty store", async () => {
    const a = await seedMerchant(
      "first.product.a@example.test",
      "First Product Store A",
      "first-product-a",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));

    expect(access).not.toBeNull();
    expect(merchantLanguage.code).toBe("en");

    const before = await counts();
    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج النور الأول",
        price: "19.9",
        categoryId: "",
        newCategoryName: "منتجات العناية",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      categoryCreated: true,
    });

    if (!result.ok) throw new Error("expected creation to succeed");

    const [saved] = await db()
      .select({
        productStoreId: product.storeId,
        productName: productTranslation.name,
        price: product.price,
        productActive: product.isActive,
        categoryId: product.categoryId,
        categoryStoreId: category.storeId,
        categoryActive: category.isActive,
        categoryDeleted: category.deletedAt,
        categoryName: categoryTranslation.name,
      })
      .from(product)
      .innerJoin(category, eq(category.id, product.categoryId))
      .innerJoin(
        productTranslation,
        eq(productTranslation.productId, product.id),
      )
      .innerJoin(
        categoryTranslation,
        eq(categoryTranslation.categoryId, category.id),
      )
      .where(eq(product.id, result.productId));

    expect(saved).toMatchObject({
      productStoreId: a.storeId,
      productName: "منتج النور الأول",
      price: "19.90",
      productActive: false,
      categoryId: result.categoryId,
      categoryStoreId: a.storeId,
      categoryActive: false,
      categoryDeleted: null,
      categoryName: "منتجات العناية",
    });
    expect(await counts()).toEqual({
      categories: before.categories + 1,
      category_translations: before.category_translations + 1,
      products: before.products + 1,
      product_translations: before.product_translations + 1,
    });
  });

  it("uses an existing own-store category that has no products without creating another category", async () => {
    const a = await seedMerchant(
      "existing.category.a@example.test",
      "Existing Category Store A",
      "existing-category-a",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const categoryId = await seedCategory(a.storeId, "قسم فارغ");
    const before = await counts();

    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج داخل قسم فارغ",
        price: "0",
        categoryId,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      categoryId,
      categoryCreated: false,
    });
    if (!result.ok) throw new Error("expected creation to succeed");

    const [saved] = await db()
      .select({
        storeId: product.storeId,
        categoryId: product.categoryId,
        price: product.price,
        isActive: product.isActive,
      })
      .from(product)
      .where(eq(product.id, result.productId));

    expect(saved).toEqual({
      storeId: a.storeId,
      categoryId,
      price: "0.00",
      isActive: false,
    });
    expect(await counts()).toEqual({
      ...before,
      products: before.products + 1,
      product_translations: before.product_translations + 1,
    });

    const options = await listCatalogCategoriesForStore(
      appDb(),
      access!.scope,
    );
    expect(options.map((entry) => entry.id)).toContain(categoryId);
    expect(options.find((entry) => entry.id === categoryId)?.translations.ar?.name).toBe(
      "قسم فارغ",
    );
  });

  it("creates identical display names in two stores with distinct slugs and root order", async () => {
    const a = await seedMerchant(
      "same.name.a@example.test",
      "Same Name Store A",
      "same-name-a",
    );
    const b = await seedMerchant(
      "same.name.b@example.test",
      "Same Name Store B",
      "same-name-b",
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const accessB = await resolveMerchantAccess(db(), claims(b.userId));

    const [resultA, resultB] = await Promise.all([
      createMerchantCatalogProduct(db(), accessA!, merchantLanguage, {
        name: "منتج مشترك",
        price: "10.00",
        categoryId: "",
        newCategoryName: "قسم مشترك",
      }),
      createMerchantCatalogProduct(db(), accessB!, merchantLanguage, {
        name: "منتج مشترك",
        price: "20.00",
        categoryId: "",
        newCategoryName: "قسم مشترك",
      }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) throw new Error("expected both to succeed");

    const rows = await db()
      .select({
        productId: product.id,
        productStoreId: product.storeId,
        productSlug: product.slug,
        categoryId: category.id,
        categoryStoreId: category.storeId,
        categorySlug: category.slug,
        rootOrder: category.sortOrder,
        productName: productTranslation.name,
        categoryName: categoryTranslation.name,
      })
      .from(product)
      .innerJoin(category, eq(category.id, product.categoryId))
      .innerJoin(productTranslation, eq(productTranslation.productId, product.id))
      .innerJoin(
        categoryTranslation,
        eq(categoryTranslation.categoryId, category.id),
      )
      .orderBy(product.storeId);

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.productSlug)).size).toBe(2);
    expect(new Set(rows.map((row) => row.categorySlug)).size).toBe(2);
    expect(new Set(rows.map((row) => row.rootOrder)).size).toBe(2);
    expect(rows.map((row) => row.productName)).toEqual([
      "منتج مشترك",
      "منتج مشترك",
    ]);
    expect(rows.map((row) => row.categoryName)).toEqual([
      "قسم مشترك",
      "قسم مشترك",
    ]);
    expect(
      rows.every((row) => row.productStoreId === row.categoryStoreId),
    ).toBe(true);
  });

  it("keeps concurrent same-name creation complete and owned by the right store", async () => {
    const a = await seedMerchant(
      "concurrent.a@example.test",
      "Concurrent Store A",
      "concurrent-a",
    );
    const b = await seedMerchant(
      "concurrent.b@example.test",
      "Concurrent Store B",
      "concurrent-b",
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const accessB = await resolveMerchantAccess(db(), claims(b.userId));

    const attempts = Array.from({ length: 4 }, (_, index) => {
      const store = index % 2 === 0 ? "a" : "b";
      return createMerchantCatalogProduct(
        db(),
        store === "a" ? accessA! : accessB!,
        merchantLanguage,
        {
          name: "منتج متزامن",
          price: `${index + 1}.00`,
          categoryId: "",
          newCategoryName: "قسم متزامن",
        },
      );
    });

    const results = await Promise.all(attempts);
    expect(results.every((result) => result.ok)).toBe(true);

    const rows = await db()
      .select({
        productStoreId: product.storeId,
        categoryStoreId: category.storeId,
        productSlug: product.slug,
        categorySlug: category.slug,
        rootOrder: category.sortOrder,
        price: product.price,
      })
      .from(product)
      .innerJoin(category, eq(category.id, product.categoryId));

    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.productSlug)).size).toBe(4);
    expect(new Set(rows.map((row) => row.categorySlug)).size).toBe(4);
    expect(new Set(rows.map((row) => row.rootOrder)).size).toBe(4);
    expect(rows.every((row) => row.productStoreId === row.categoryStoreId)).toBe(
      true,
    );
    expect(rows.filter((row) => row.productStoreId === a.storeId)).toHaveLength(2);
    expect(rows.filter((row) => row.productStoreId === b.storeId)).toHaveLength(2);
  });

  it("rejects a foreign, missing or soft-deleted category without writing", async () => {
    const a = await seedMerchant(
      "category.safe.a@example.test",
      "Category Safe Store A",
      "category-safe-a",
    );
    const b = await seedMerchant(
      "category.safe.b@example.test",
      "Category Safe Store B",
      "category-safe-b",
    );
    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const foreignCategoryId = await seedCategory(b.storeId, "قسم المتجر ب");
    const deletedCategoryId = await seedCategory(
      a.storeId,
      "قسم محذوف",
      true,
    );
    const before = await counts();
    const foreignBefore = await db()
      .select({ slug: category.slug, name: categoryTranslation.name })
      .from(category)
      .innerJoin(
        categoryTranslation,
        eq(categoryTranslation.categoryId, category.id),
      )
      .where(eq(category.id, foreignCategoryId));

    for (const categoryId of [
      foreignCategoryId,
      crypto.randomUUID(),
      deletedCategoryId,
    ]) {
      const result = await createMerchantCatalogProduct(
        db(),
        accessA!,
        merchantLanguage,
        {
          name: "منتج مرفوض",
          price: "5.00",
          categoryId,
        },
      );

      expect(result).toEqual({ ok: false, error: "CATEGORY_NOT_FOUND" });
    }

    expect(await counts()).toEqual(before);
    expect(
      await db()
        .select({ slug: category.slug, name: categoryTranslation.name })
        .from(category)
        .innerJoin(
          categoryTranslation,
          eq(categoryTranslation.categoryId, category.id),
        )
        .where(eq(category.id, foreignCategoryId)),
    ).toEqual(foreignBefore);
  });

  it("fails at the write boundary when membership is revoked after access was resolved", async () => {
    const a = await seedMerchant(
      "bound.revoked@example.test",
      "Bound Revoked Store",
      "bound-revoked",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await counts();

    await withSeparateConnection(async (separate) => {
      await separate
        .update(storeMembership)
        .set({ status: "revoked" })
        .where(eq(storeMembership.userId, a.userId));
    });

    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج بعد الإلغاء",
        price: "11.00",
        categoryId: "",
        newCategoryName: "قسم بعد الإلغاء",
      },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await counts()).toEqual(before);
  });

  it("fails at the write boundary when session_version rotates after access was resolved", async () => {
    const a = await seedMerchant(
      "bound.version@example.test",
      "Bound Version Store",
      "bound-version",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId, 0));
    const categoryId = await seedCategory(a.storeId, "قسم النسخة");
    const before = await counts();

    await withSeparateConnection(async (separate) => {
      await separate
        .update(appUser)
        .set({ sessionVersion: 1 })
        .where(eq(appUser.id, a.userId));
    });

    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج بعد تدوير الجلسة",
        price: "12.00",
        categoryId,
      },
    );

    expect(result.ok).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it("fails at the write boundary when the store is suspended after access was resolved", async () => {
    const a = await seedMerchant(
      "bound.suspended@example.test",
      "Bound Suspended Store",
      "bound-suspended",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const categoryId = await seedCategory(a.storeId, "قسم الإيقاف");
    const before = await counts();

    await withSeparateConnection(async (separate) => {
      await separate
        .update(store)
        .set({ status: "suspended" })
        .where(eq(store.id, a.storeId));
    });

    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج بعد الإيقاف",
        price: "13.00",
        categoryId,
      },
    );

    expect(result.ok).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it("rolls back the inline category and product when a later insert fails", async () => {
    const a = await seedMerchant(
      "rollback.a@example.test",
      "Rollback Store A",
      "rollback-a",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await counts();

    await db().execute(sql`
      create or replace function reject_product_translation_insert()
      returns trigger language plpgsql as $$
      begin
        raise exception 'product translation insert blocked';
      end;
      $$
    `);
    await db().execute(sql`
      create trigger reject_product_translation_insert_trigger
      before insert on product_translation
      for each row execute function reject_product_translation_insert()
    `);

    try {
      const result = await createMerchantCatalogProduct(
        db(),
        access!,
        merchantLanguage,
        {
          name: "منتج سيفشل",
          price: "14.00",
          categoryId: "",
          newCategoryName: "قسم سيفشل",
        },
      );

      expect(result).toEqual({ ok: false, error: "UNAVAILABLE" });
      expect(await counts()).toEqual(before);
    } finally {
      await db().execute(
        sql`drop trigger if exists reject_product_translation_insert_trigger on product_translation`,
      );
      await db().execute(
        sql`drop function if exists reject_product_translation_insert()`,
      );
    }
  });

  it("rejects invalid input before writing anything", async () => {
    const a = await seedMerchant(
      "invalid.a@example.test",
      "Invalid Store A",
      "invalid-a",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const categoryId = await seedCategory(a.storeId, "قسم صالح");
    const before = await counts();

    for (const input of [
      { name: "", price: "1.00", categoryId },
      { name: "منتج", price: "1.234", categoryId },
      { name: "منتج", price: "1.00", categoryId: "" },
      { name: "منتج", price: "1.00", categoryId: "", newCategoryName: "" },
    ]) {
      const result = await createMerchantCatalogProduct(
        db(),
        access!,
        merchantLanguage,
        input,
      );

      expect(result).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    }

    expect(await counts()).toEqual(before);
  });

  it("ignores the legacy bot default and displays saved non-Arabic translations", async () => {
    const a = await seedMerchant(
      "language.regression.a@example.test",
      "Language Regression Store A",
      "language-regression-a",
    );
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const [arabic] = await db()
      .select({ id: language.id })
      .from(language)
      .where(eq(language.code, "ar"));
    const [english] = await db()
      .select({ id: language.id })
      .from(language)
      .where(eq(language.code, "en"));
    const insertedFrench = await db()
      .insert(language)
      .values({
        code: "fr",
        label: "Français",
        textDirection: "ltr",
        isEnabled: true,
      })
      .onConflictDoNothing({ target: language.code })
      .returning({ id: language.id });
    const [french] =
      insertedFrench.length > 0
        ? insertedFrench
        : await db()
            .select({ id: language.id })
            .from(language)
            .where(eq(language.code, "fr"));

    await db().insert(botSetting).values({
      id: 1,
      defaultLanguageId: arabic.id,
      currency: "SAR",
      displayName: "Legacy Bot",
    });

    expect((await resolveDefaultLanguage(appDb()))?.code).toBe("ar");

    const languageBefore = await resolveMerchantCatalogLanguage(appDb());
    expect(languageBefore?.code).toBe("en");

    const created = await createMerchantCatalogProduct(
      db(),
      access!,
      languageBefore!,
      {
        name: "منتج محفوظ بالعربية",
        price: "21.00",
        categoryId: "",
        newCategoryName: "قسم محفوظ",
      },
    );

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected creation to succeed");

    const savedTranslation = await db()
      .select({ code: language.code, name: productTranslation.name })
      .from(productTranslation)
      .innerJoin(language, eq(language.id, productTranslation.languageId))
      .where(eq(productTranslation.productId, created.productId));

    expect(savedTranslation).toEqual([
      { code: "en", name: "منتج محفوظ بالعربية" },
    ]);

    const productsBefore = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    const createdRecord = productsBefore.find(
      (entry) => entry.id === created.productId,
    );

    expect(
      resolveMerchantProductName(
        createdRecord!.translations,
        createdRecord!.slug,
      ),
    ).toBe("منتج محفوظ بالعربية");

    await db()
      .update(botSetting)
      .set({ defaultLanguageId: french.id })
      .where(eq(botSetting.id, 1));

    expect((await resolveDefaultLanguage(appDb()))?.code).toBe("fr");
    expect((await resolveMerchantCatalogLanguage(appDb()))?.code).toBe("en");

    const frenchProductId = crypto.randomUUID();
    await db().insert(product).values({
      id: frenchProductId,
      storeId: a.storeId,
      categoryId: created.categoryId,
      slug: `french-only-${crypto.randomUUID()}`,
      price: "5.00",
      isActive: false,
      sortOrder: nextOrder(),
    });
    await db().insert(productTranslation).values({
      productId: frenchProductId,
      languageId: french.id,
      name: "Produit français",
    });

    const productsAfter = await listCatalogProductsForStore(
      appDb(),
      access!.scope,
    );
    const frenchRecord = productsAfter.find(
      (entry) => entry.id === frenchProductId,
    );

    expect(
      resolveMerchantProductName(frenchRecord!.translations, frenchRecord!.slug),
    ).toBe("Produit français");
    expect(english.id).toBe(languageBefore!.id);
  });

  it("returns no language when every global language is disabled", async () => {
    await db().update(language).set({ isEnabled: false });

    try {
      expect(await resolveMerchantCatalogLanguage(appDb())).toBeNull();
    } finally {
      await db().update(language).set({ isEnabled: true });
    }
  });

  it("refuses a read-only resolved access even when called directly", async () => {
    const a = await seedMerchant(
      "readonly.a@example.test",
      "Read-only Store A",
      "readonly-a",
    );
    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));
    const access = await resolveMerchantAccess(db(), claims(a.userId));
    const before = await counts();

    expect(access).toMatchObject({ readOnly: true });

    const result = await createMerchantCatalogProduct(
      db(),
      access!,
      merchantLanguage,
      {
        name: "منتج ممنوع",
        price: "15.00",
        categoryId: "",
        newCategoryName: "قسم ممنوع",
      },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await counts()).toEqual(before);
  });
});
