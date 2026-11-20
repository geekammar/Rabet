import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "@/db/schema";
import {
  category,
  language,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  store,
} from "@/db/schema";
import {
  listCatalogProducts,
  listCatalogProductsForStore,
  updateCatalogProductAvailabilityForStore,
  updateCatalogProductPriceForStore,
} from "@/lib/data";
import type { StoreScope } from "@/lib/data/store-scope";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

/**
 * Phase 1 tenant-scoped catalog acceptance suite.
 *
 * Two real stores in one disposable PostgreSQL database. A and B own distinct
 * categories, products and translations; A also owns a product whose category
 * points at B (allowed by the current single-column FK), a soft-deleted
 * product, an unowned product (`store_id = NULL`) and a product under an
 * unowned category. The scoped read and guarded availability update must never
 * expose or change any of those cross-store/unowned rows.
 */

const shouldRun = hasTestCluster();

type ObservedQuery = {
  query: string;
  parameters: readonly unknown[];
};

/**
 * A second `postgres-js` client over the test database with its `debug`
 * callback enabled. It is used only to observe which statements the scoped
 * operations emit, so the suite can prove the category gate runs before the
 * product query and the translation query is keyed by authorized ids.
 */
function createObservedDb(url: string) {
  const queries: ObservedQuery[] = [];
  const client = postgres(url, {
    max: 1,
    debug: (_connection: number, query: string, parameters: unknown[]) => {
      queries.push({ query, parameters: [...parameters] });
    },
  });

  return {
    db: asAppDb(drizzle({ client, schema })),
    queries,
    async close() {
      await client.end();
    },
  };
}

type Fixture = {
  englishId: string;
  arabicId: string;
  storeAId: string;
  storeBId: string;
  categoryAId: string;
  categoryBId: string;
  unownedCategoryId: string;
  deletedCategoryAId: string;
  productAOneId: string;
  productATwoId: string;
  productAWriteId: string;
  productANoTranslationId: string;
  productBId: string;
  crossLinkedProductId: string;
  deletedProductId: string;
  nullOwnedProductId: string;
  unownedCategoryProductId: string;
  productUnderDeletedCategoryId: string;
};

let testDb: TestDatabase | null = null;
let observer: ReturnType<typeof createObservedDb> | null = null;
let fixture: Fixture;
let scopeA: StoreScope;
let scopeB: StoreScope;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("catalog_store_scope");
  observer = createObservedDb(testDb.url);

  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning({ id: language.id });

  const [arabic] = await db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning({ id: language.id });

  const [storeA] = await db
    .insert(store)
    .values({ name: "Store A", slug: "store-a", status: "active" })
    .returning({ id: store.id });

  const [storeB] = await db
    .insert(store)
    .values({ name: "Store B", slug: "store-b", status: "active" })
    .returning({ id: store.id });

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "store-a-category",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning({ id: category.id });

  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "store-b-category",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning({ id: category.id });

  const [unownedCategory] = await db
    .insert(category)
    .values({
      storeId: null,
      slug: "unowned-category",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning({ id: category.id });

  const [deletedCategoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "store-a-deleted-category",
      sortOrder: nextOrder(),
      isActive: true,
      deletedAt: new Date(),
    })
    .returning({ id: category.id });

  const [productAOne] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "store-a-product-one",
      price: "11.00",
      isActive: true,
      sortOrder: 10,
    })
    .returning({ id: product.id });

  const [productATwo] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "store-a-product-two",
      price: "12.50",
      isActive: false,
      sortOrder: 20,
    })
    .returning({ id: product.id });

  const [productAWrite] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "store-a-write-product",
      price: "55.00",
      isActive: false,
      sortOrder: 30,
    })
    .returning({ id: product.id });

  const [productANoTranslation] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "store-a-no-translation",
      price: "57.00",
      isActive: true,
      sortOrder: 35,
    })
    .returning({ id: product.id });

  const [productB] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "store-b-product",
      price: "22.00",
      isActive: true,
      sortOrder: 10,
    })
    .returning({ id: product.id });

  // The current schema's product FK references category(id) only, so this
  // cross-store relationship is legal at the database level. The scoped
  // operations, not the old FK, must exclude it.
  const [crossLinkedProduct] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryB.id,
      slug: "store-a-cross-linked",
      price: "33.00",
      isActive: true,
      sortOrder: 40,
    })
    .returning({ id: product.id });

  const [deletedProduct] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "store-a-deleted",
      price: "44.00",
      isActive: true,
      deletedAt: new Date(),
      sortOrder: 50,
    })
    .returning({ id: product.id });

  const [nullOwnedProduct] = await db
    .insert(product)
    .values({
      storeId: null,
      categoryId: categoryA.id,
      slug: "store-null-owned",
      price: "66.00",
      isActive: false,
      sortOrder: 60,
    })
    .returning({ id: product.id });

  const [unownedCategoryProduct] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: unownedCategory.id,
      slug: "store-a-under-unowned-category",
      price: "77.00",
      isActive: true,
      sortOrder: 70,
    })
    .returning({ id: product.id });

  // An otherwise eligible A product under an A-owned category that is only
  // soft-deleted. The category row and product FK are fully valid; the scoped
  // operations must treat it exactly like an ineligible category.
  const [productUnderDeletedCategory] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: deletedCategoryA.id,
      slug: "store-a-under-deleted-category",
      price: "88.00",
      isActive: true,
      sortOrder: 80,
    })
    .returning({ id: product.id });

  await db.insert(productTranslation).values([
    {
      productId: productAOne.id,
      languageId: english.id,
      name: "Store A Product One",
      description: "A one",
      details: "A one details",
    },
    {
      productId: productAOne.id,
      languageId: arabic.id,
      name: "منتج المتجر أ الأول",
      description: "وصف أ واحد",
      details: "تفاصيل أ واحد",
    },
    {
      productId: productATwo.id,
      languageId: english.id,
      name: "Store A Product Two",
      description: "A two",
      details: "A two details",
    },
    {
      productId: productAWrite.id,
      languageId: english.id,
      name: "Store A Write Product",
      description: "A write",
      details: "A write details",
    },
    {
      productId: productB.id,
      languageId: english.id,
      name: "Store B Product",
      description: "B only",
      details: "B only details",
    },
    {
      productId: crossLinkedProduct.id,
      languageId: english.id,
      name: "Store A Cross-Link Product",
      description: "Cross link",
      details: "Cross link details",
    },
    {
      productId: deletedProduct.id,
      languageId: english.id,
      name: "Store A Deleted Product",
      description: "Deleted",
      details: "Deleted details",
    },
    {
      productId: nullOwnedProduct.id,
      languageId: english.id,
      name: "Unowned Product",
      description: "Unowned",
      details: "Unowned details",
    },
    {
      productId: unownedCategoryProduct.id,
      languageId: english.id,
      name: "A Under Unowned Category",
      description: "Unowned category",
      details: "Unowned category details",
    },
    {
      productId: productUnderDeletedCategory.id,
      languageId: english.id,
      name: "A Under Deleted Category",
      description: "Deleted category",
      details: "Deleted category details",
    },
  ]);

  const [writeAction] = await db
    .insert(productAction)
    .values({
      productId: productAWrite.id,
      actionType: "START_INQUIRY",
      sortOrder: 0,
      isActive: true,
    })
    .returning({ id: productAction.id });

  const [bAction] = await db
    .insert(productAction)
    .values({
      productId: productB.id,
      actionType: "START_INQUIRY",
      sortOrder: 0,
      isActive: true,
    })
    .returning({ id: productAction.id });

  const [crossAction] = await db
    .insert(productAction)
    .values({
      productId: crossLinkedProduct.id,
      actionType: "START_INQUIRY",
      sortOrder: 0,
      isActive: true,
    })
    .returning({ id: productAction.id });

  await db.insert(productActionTranslation).values([
    {
      actionId: writeAction.id,
      languageId: english.id,
      label: "Ask about A write product",
    },
    {
      actionId: bAction.id,
      languageId: english.id,
      label: "Ask about B product",
    },
    {
      actionId: crossAction.id,
      languageId: english.id,
      label: "Ask about cross-link product",
    },
  ]);

  scopeA = await readStoreScopeForFixture(db, storeA.id);
  scopeB = await readStoreScopeForFixture(db, storeB.id);

  fixture = {
    englishId: english.id,
    arabicId: arabic.id,
    storeAId: storeA.id,
    storeBId: storeB.id,
    categoryAId: categoryA.id,
    categoryBId: categoryB.id,
    unownedCategoryId: unownedCategory.id,
    deletedCategoryAId: deletedCategoryA.id,
    productAOneId: productAOne.id,
    productATwoId: productATwo.id,
    productAWriteId: productAWrite.id,
    productANoTranslationId: productANoTranslation.id,
    productBId: productB.id,
    crossLinkedProductId: crossLinkedProduct.id,
    deletedProductId: deletedProduct.id,
    nullOwnedProductId: nullOwnedProduct.id,
    unownedCategoryProductId: unownedCategoryProduct.id,
    productUnderDeletedCategoryId: productUnderDeletedCategory.id,
  };
});

afterAll(async () => {
  await observer?.close();
  observer = null;
  await testDb?.close();
  testDb = null;
});

async function readProductState(productId: string) {
  const [row] = await testDb!.db
    .select()
    .from(product)
    .where(eq(product.id, productId));

  const actions = await testDb!.db
    .select()
    .from(productAction)
    .where(eq(productAction.productId, productId))
    .orderBy(productAction.id);

  const translations = await testDb!.db
    .select()
    .from(productTranslation)
    .where(eq(productTranslation.productId, productId))
    .orderBy(productTranslation.id);

  return { row, actions, translations };
}

function catalogDataQueries(queries: readonly ObservedQuery[]) {
  return queries.filter(
    (entry) =>
      /from "product"/.test(entry.query) &&
      /left join "product_translation"/.test(entry.query),
  );
}

function categoryGateQueries(queries: readonly ObservedQuery[]) {
  return queries.filter((entry) => /from "category"/.test(entry.query));
}

function updateQueries(queries: readonly ObservedQuery[]) {
  return queries.filter((entry) => /^update "product"/.test(entry.query));
}

describe.skipIf(!shouldRun)("store-scoped catalog", () => {
  it("returns each eligible product once with all translations from one catalog statement", async () => {
    observer!.queries.length = 0;

    const aProducts = await listCatalogProductsForStore(observer!.db, scopeA);
    const aQueries = [...observer!.queries];

    const aProductIds = aProducts.map((p) => p.id);
    expect(aProductIds).toEqual([
      fixture.productAOneId,
      fixture.productATwoId,
      fixture.productAWriteId,
      fixture.productANoTranslationId,
    ]);
    expect(new Set(aProductIds).size).toBe(aProductIds.length);
    expect(aProducts[0].translations.en?.name).toBe("Store A Product One");
    expect(aProducts[0].translations.ar?.name).toBe("منتج المتجر أ الأول");
    expect(aProducts[1].translations.en?.name).toBe("Store A Product Two");
    expect(aProducts[2].translations.en?.name).toBe("Store A Write Product");
    expect(aProducts[3].translations).toEqual({});

    const aJson = JSON.stringify(aProducts);
    expect(aJson).not.toContain("Store B Product");
    expect(aJson).not.toContain("Store A Cross-Link Product");
    expect(aJson).not.toContain("Store A Deleted Product");
    expect(aJson).not.toContain("Unowned Product");
    expect(aJson).not.toContain("A Under Unowned Category");
    expect(aJson).not.toContain("A Under Deleted Category");

    const catalogQueries = catalogDataQueries(aQueries);
    expect(catalogQueries).toHaveLength(1);
    expect(
      aQueries.filter((entry) => /from "product"/.test(entry.query)),
    ).toHaveLength(1);
    const catalogQuery = catalogQueries[0];
    expect(catalogQuery.query).toContain('from "product"');
    expect(catalogQuery.query).toContain('inner join "category"');
    expect(catalogQuery.query).toContain('left join "product_translation"');
    expect(catalogQuery.query).toContain('left join "language"');
    expect(catalogQuery.query).toMatch(/"product"\."store_id"\s*=\s*\$\d+/);
    expect(catalogQuery.query).toMatch(/"category"\."store_id"\s*=\s*\$\d+/);
    expect(catalogQuery.query).toContain('"product"."deleted_at" is null');
    expect(catalogQuery.query).toContain('"category"."deleted_at" is null');
    expect(catalogQuery.query).not.toContain(
      '"product_translation"."product_id" in (',
    );

    const bProducts = await listCatalogProductsForStore(observer!.db, scopeB);

    expect(bProducts.map((p) => p.id)).toEqual([fixture.productBId]);
    expect(bProducts[0].translations.en?.name).toBe("Store B Product");
    expect(JSON.stringify(bProducts)).not.toContain("Store A Product");
  });

  it("accepts a live same-store category filter and rejects foreign, missing or soft-deleted categories before catalog data", async () => {
    observer!.queries.length = 0;
    const filtered = await listCatalogProductsForStore(
      observer!.db,
      scopeA,
      fixture.categoryAId,
    );
    const filteredQueries = [...observer!.queries];

    expect(filtered.map((p) => p.id)).toEqual([
      fixture.productAOneId,
      fixture.productATwoId,
      fixture.productAWriteId,
      fixture.productANoTranslationId,
    ]);
    const filteredCategoryQueries = categoryGateQueries(filteredQueries);
    expect(filteredCategoryQueries).toHaveLength(1);
    expect(filteredCategoryQueries[0].query).toContain('from "category"');
    expect(filteredCategoryQueries[0].query).toContain(
      '"category"."deleted_at" is null',
    );
    const filteredCatalogQueries = catalogDataQueries(filteredQueries);
    expect(filteredCatalogQueries).toHaveLength(1);
    expect(filteredCatalogQueries[0].query).toContain(
      '"product"."category_id"',
    );
    expect(filteredCatalogQueries[0].query).toContain(
      'left join "product_translation"',
    );

    const deniedCategoryIds = [
      fixture.categoryBId,
      globalThis.crypto.randomUUID(),
      fixture.deletedCategoryAId,
    ];

    // The same generic outcome: an empty record list, never an unfiltered read.
    const deniedQueries: ObservedQuery[][] = [];

    for (const deniedCategoryId of deniedCategoryIds) {
      observer!.queries.length = 0;
      const result = await listCatalogProductsForStore(
        observer!.db,
        scopeA,
        deniedCategoryId,
      );
      const queries = [...observer!.queries];

      expect(result).toEqual([]);
      expect(catalogDataQueries(queries)).toHaveLength(0);
      expect(
        queries.filter((entry) => /from "product"/.test(entry.query)),
      ).toHaveLength(0);
      const categoryQueries = categoryGateQueries(queries);
      expect(categoryQueries).toHaveLength(1);
      expect(categoryQueries[0].query).toMatch(
        /"category"\."store_id"\s*=\s*\$\d+/,
      );
      expect(categoryQueries[0].query).toContain(
        '"category"."deleted_at" is null',
      );
      expect(categoryQueries[0].parameters).toContain(deniedCategoryId);
      expect(categoryQueries[0].parameters).toContain(scopeA.storeId);

      deniedQueries.push(categoryQueries);
    }

    for (const queries of deniedQueries.slice(1)) {
      expect(queries[0].query).toBe(deniedQueries[0][0].query);
    }
  });

  it("excludes the legacy cross-link, deleted, NULL-owned, unowned-category and deleted-category rows while the legacy read is unchanged", async () => {
    const scoped = await listCatalogProductsForStore(observer!.db, scopeA);
    const scopedIds = scoped.map((p) => p.id);

    expect(scopedIds).toEqual([
      fixture.productAOneId,
      fixture.productATwoId,
      fixture.productAWriteId,
      fixture.productANoTranslationId,
    ]);
    expect(scopedIds).not.toContain(fixture.crossLinkedProductId);
    expect(scopedIds).not.toContain(fixture.deletedProductId);
    expect(scopedIds).not.toContain(fixture.nullOwnedProductId);
    expect(scopedIds).not.toContain(fixture.unownedCategoryProductId);
    expect(scopedIds).not.toContain(fixture.productUnderDeletedCategoryId);
    expect(JSON.stringify(scoped)).not.toContain(
      "Store A Cross-Link Product",
    );
    expect(JSON.stringify(scoped)).not.toContain("Unowned Product");
    expect(JSON.stringify(scoped)).not.toContain(
      "A Under Deleted Category",
    );

    const legacy = await listCatalogProducts(asAppDb(testDb!.db));
    const legacyIds = legacy.map((p) => p.id);

    for (const visible of [
      fixture.productAOneId,
      fixture.productATwoId,
      fixture.productAWriteId,
      fixture.productANoTranslationId,
      fixture.productBId,
      fixture.crossLinkedProductId,
      fixture.nullOwnedProductId,
      fixture.unownedCategoryProductId,
      fixture.productUnderDeletedCategoryId,
    ]) {
      expect(legacyIds).toContain(visible);
    }
    expect(legacyIds).not.toContain(fixture.deletedProductId);

    const legacyCrossLink = legacy.find(
      (p) => p.id === fixture.crossLinkedProductId,
    );
    expect(legacyCrossLink?.translations.en?.name).toBe(
      "Store A Cross-Link Product",
    );
    expect(
      legacy.find((p) => p.id === fixture.productBId)?.translations.en?.name,
    ).toBe("Store B Product");

    const legacyByCategoryB = await listCatalogProducts(
      asAppDb(testDb!.db),
      fixture.categoryBId,
    );
    expect(legacyByCategoryB.map((p) => p.id)).toEqual(
      expect.arrayContaining([fixture.productBId, fixture.crossLinkedProductId]),
    );
  });

  it("updates only availability for an owned product, leaving price, translations and actions alone", async () => {
    const before = await readProductState(fixture.productAWriteId);
    expect(before.row.isActive).toBe(false);

    observer!.queries.length = 0;
    const updated = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.productAWriteId,
      true,
    );

    expect(updated).toBe(true);

    const after = await readProductState(fixture.productAWriteId);
    expect(after.row.isActive).toBe(true);
    expect(after.row.price).toBe(before.row.price);
    expect(after.row.slug).toBe(before.row.slug);
    expect(after.row.categoryId).toBe(before.row.categoryId);
    expect(after.row.storeId).toBe(fixture.storeAId);
    expect(after.row.createdAt).toEqual(before.row.createdAt);
    expect(after.row.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.row.updatedAt.getTime(),
    );
    expect(after.translations).toEqual(before.translations);
    expect(after.actions).toEqual(before.actions);

    const writeQueries = updateQueries(observer!.queries);
    expect(writeQueries).toHaveLength(1);
    const statement = writeQueries[0];
    expect(statement.query).toMatch(/^update "product"/);
    expect(statement.query).toMatch(/"product"\."store_id"\s*=\s*\$\d+/);
    expect(statement.query).toContain('"product"."deleted_at" is null');
    expect(statement.query).toContain("exists");
    expect(statement.query).toMatch(/"category"\."store_id"\s*=\s*\$\d+/);
    expect(statement.query).toContain('"category"."deleted_at" is null');
    expect(statement.query).toContain("returning");
  });

  it("updates only the price for an owned product and returns the exact stored decimal, including zero", async () => {
    const before = await readProductState(fixture.productAOneId);
    expect(before.row.price).toBe("11.00");
    expect(before.row.isActive).toBe(true);

    observer!.queries.length = 0;
    const updated = await updateCatalogProductPriceForStore(
      observer!.db,
      scopeA,
      fixture.productAOneId,
      "19.9",
    );
    const writeQueries = updateQueries(observer!.queries);
    const authorizationReads = observer!.queries.filter((entry) =>
      /^select/.test(entry.query),
    );

    expect(updated).toBe(true);
    expect(authorizationReads).toHaveLength(0);
    expect(writeQueries).toHaveLength(1);

    const statement = writeQueries[0];
    expect(statement.query).toMatch(/^update "product"/);
    expect(statement.query).toMatch(/"price"\s*=\s*\$\d+/);
    expect(statement.query).not.toContain('"is_active"');
    expect(statement.query).toMatch(/"product"\."store_id"\s*=\s*\$\d+/);
    expect(statement.query).toContain('"product"."deleted_at" is null');
    expect(statement.query).toContain("exists");
    expect(statement.query).toMatch(/"category"\."store_id"\s*=\s*\$\d+/);
    expect(statement.query).toContain('"category"."deleted_at" is null');
    expect(statement.query).toContain("returning");
    expect(statement.parameters).toContain("19.90");

    const after = await readProductState(fixture.productAOneId);
    expect(after.row.price).toBe("19.90");
    expect(after.row.isActive).toBe(before.row.isActive);
    expect(after.row.slug).toBe(before.row.slug);
    expect(after.row.categoryId).toBe(before.row.categoryId);
    expect(after.row.storeId).toBe(fixture.storeAId);
    expect(after.row.createdAt).toEqual(before.row.createdAt);
    expect(after.row.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.row.updatedAt.getTime(),
    );
    expect(after.translations).toEqual(before.translations);
    expect(after.actions).toEqual(before.actions);

    const scoped = await listCatalogProductsForStore(observer!.db, scopeA);
    expect(
      scoped.find((p) => p.id === fixture.productAOneId)?.price,
    ).toBe("19.90");

    observer!.queries.length = 0;
    const zeroUpdated = await updateCatalogProductPriceForStore(
      observer!.db,
      scopeA,
      fixture.productAOneId,
      "0",
    );

    expect(zeroUpdated).toBe(true);
    expect(updateQueries(observer!.queries)).toHaveLength(1);
    expect(
      observer!.queries.filter((entry) => /^select/.test(entry.query)),
    ).toHaveLength(0);

    const zeroState = await readProductState(fixture.productAOneId);
    expect(zeroState.row.price).toBe("0.00");
    expect(zeroState.row.isActive).toBe(before.row.isActive);
    expect(zeroState.translations).toEqual(before.translations);
    expect(zeroState.actions).toEqual(before.actions);

    const zeroScoped = await listCatalogProductsForStore(observer!.db, scopeA);
    expect(
      zeroScoped.find((p) => p.id === fixture.productAOneId)?.price,
    ).toBe("0.00");
  });

  it("gives the same no-match price outcome for B's product and a missing product, leaving B's full fixture state unchanged", async () => {
    const before = await readProductState(fixture.productBId);
    const actionIds = before.actions.map((action) => action.id);
    const actionTranslationsBefore =
      actionIds.length > 0
        ? await testDb!.db
            .select()
            .from(productActionTranslation)
            .where(inArray(productActionTranslation.actionId, actionIds))
            .orderBy(productActionTranslation.id)
        : [];
    const [categoryBefore] = await testDb!.db
      .select()
      .from(category)
      .where(eq(category.id, fixture.categoryBId));

    observer!.queries.length = 0;
    const foreignResult = await updateCatalogProductPriceForStore(
      observer!.db,
      scopeA,
      fixture.productBId,
      "1.00",
    );
    const foreignQueries = [...observer!.queries];

    observer!.queries.length = 0;
    const missingResult = await updateCatalogProductPriceForStore(
      observer!.db,
      scopeA,
      globalThis.crypto.randomUUID(),
      "1.00",
    );
    const missingQueries = [...observer!.queries];

    expect(foreignResult).toBe(false);
    expect(missingResult).toBe(false);

    const foreignUpdates = updateQueries(foreignQueries);
    const missingUpdates = updateQueries(missingQueries);
    expect(foreignUpdates).toHaveLength(1);
    expect(missingUpdates).toHaveLength(1);
    expect(foreignUpdates[0].query).toBe(missingUpdates[0].query);
    expect(foreignUpdates[0].query).toMatch(/^update "product"/);
    expect(foreignUpdates[0].query).toContain("returning");
    expect(
      foreignQueries.filter((entry) => /^select/.test(entry.query)),
    ).toHaveLength(0);
    expect(
      missingQueries.filter((entry) => /^select/.test(entry.query)),
    ).toHaveLength(0);

    const after = await readProductState(fixture.productBId);
    expect(after).toEqual(before);
    expect(after.row.price).toBe("22.00");
    expect(after.row.isActive).toBe(true);

    const actionTranslationsAfter =
      actionIds.length > 0
        ? await testDb!.db
            .select()
            .from(productActionTranslation)
            .where(inArray(productActionTranslation.actionId, actionIds))
            .orderBy(productActionTranslation.id)
        : [];
    expect(actionTranslationsAfter).toEqual(actionTranslationsBefore);
    expect(
      await testDb!.db
        .select()
        .from(category)
        .where(eq(category.id, fixture.categoryBId)),
    ).toEqual([categoryBefore]);
  });

  it("refuses price updates for deleted, NULL-owned, cross-linked, unowned-category and soft-deleted-category products", async () => {
    const deniedProductIds = [
      fixture.deletedProductId,
      fixture.nullOwnedProductId,
      fixture.crossLinkedProductId,
      fixture.unownedCategoryProductId,
      fixture.productUnderDeletedCategoryId,
    ];

    for (const productId of deniedProductIds) {
      const before = await readProductState(productId);

      observer!.queries.length = 0;
      const updated = await updateCatalogProductPriceForStore(
        observer!.db,
        scopeA,
        productId,
        "9.99",
      );
      const writes = updateQueries(observer!.queries);

      expect(updated).toBe(false);
      expect(writes).toHaveLength(1);
      expect(writes[0].query).toMatch(/^update "product"/);
      expect(writes[0].query).toContain("exists");
      expect(writes[0].query).toContain('"category"."deleted_at" is null');
      expect(
        observer!.queries.filter((entry) => /^select/.test(entry.query)),
      ).toHaveLength(0);
      expect(await readProductState(productId)).toEqual(before);
    }
  });

  it("rejects invalid prices before any SQL write", async () => {
    const before = await readProductState(fixture.productATwoId);
    const invalidPrices: unknown[] = [
      42,
      "-1.00",
      "1e2",
      "10.123",
      "12345678901234567.00",
    ];

    for (const invalidPrice of invalidPrices) {
      observer!.queries.length = 0;

      await expect(
        updateCatalogProductPriceForStore(
          observer!.db,
          scopeA,
          fixture.productATwoId,
          invalidPrice,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });

      expect(observer!.queries).toHaveLength(0);
    }

    expect(await readProductState(fixture.productATwoId)).toEqual(before);
    expect(before.row.price).toBe("12.50");
  });

  it("gives the same no-match outcome for B's product and a missing product, leaving B byte-for-byte unchanged", async () => {
    const before = await readProductState(fixture.productBId);

    observer!.queries.length = 0;
    const foreignResult = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.productBId,
      false,
    );
    const foreignQueries = updateQueries(observer!.queries);

    observer!.queries.length = 0;
    const missingResult = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      globalThis.crypto.randomUUID(),
      false,
    );
    const missingQueries = updateQueries(observer!.queries);

    expect(foreignResult).toBe(false);
    expect(missingResult).toBe(false);

    const after = await readProductState(fixture.productBId);
    expect(after).toEqual(before);
    expect(after.row.isActive).toBe(true);

    expect(foreignQueries).toHaveLength(1);
    expect(missingQueries).toHaveLength(1);
    expect(foreignQueries[0].query).toBe(missingQueries[0].query);
    expect(foreignQueries[0].query).toMatch(/^update "product"/);
    expect(foreignQueries[0].query).toContain("returning");
  });

  it("rejects a product whose category belongs to another store inside the same guarded write", async () => {
    const crossBefore = await readProductState(fixture.crossLinkedProductId);

    observer!.queries.length = 0;
    const crossResult = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.crossLinkedProductId,
      false,
    );

    expect(crossResult).toBe(false);
    const crossQueries = updateQueries(observer!.queries);
    expect(crossQueries).toHaveLength(1);
    expect(crossQueries[0].query).toContain("exists");

    const crossAfter = await readProductState(fixture.crossLinkedProductId);
    expect(crossAfter).toEqual(crossBefore);
    expect(crossAfter.row.isActive).toBe(true);

    const unownedBefore = await readProductState(
      fixture.unownedCategoryProductId,
    );
    const unownedResult = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.unownedCategoryProductId,
      false,
    );

    expect(unownedResult).toBe(false);
    expect(await readProductState(fixture.unownedCategoryProductId)).toEqual(
      unownedBefore,
    );
    expect(unownedBefore.row.categoryId).toBe(fixture.unownedCategoryId);
  });

  it("excludes and refuses to update an eligible product under a soft-deleted same-store category", async () => {
    const before = await readProductState(
      fixture.productUnderDeletedCategoryId,
    );

    expect(before.row.deletedAt).toBeNull();
    expect(before.row.storeId).toBe(fixture.storeAId);
    expect(before.row.categoryId).toBe(fixture.deletedCategoryAId);
    expect(before.translations[0]?.name).toBe("A Under Deleted Category");

    const scoped = await listCatalogProductsForStore(observer!.db, scopeA);
    expect(scoped.map((p) => p.id)).not.toContain(
      fixture.productUnderDeletedCategoryId,
    );
    expect(JSON.stringify(scoped)).not.toContain(
      "A Under Deleted Category",
    );

    observer!.queries.length = 0;
    const filtered = await listCatalogProductsForStore(
      observer!.db,
      scopeA,
      fixture.deletedCategoryAId,
    );
    const filteredQueries = [...observer!.queries];

    expect(filtered).toEqual([]);
    expect(catalogDataQueries(filteredQueries)).toHaveLength(0);
    const filteredCategoryQueries = categoryGateQueries(filteredQueries);
    expect(filteredCategoryQueries).toHaveLength(1);
    expect(filteredCategoryQueries[0].query).toContain('from "category"');
    expect(filteredCategoryQueries[0].query).toContain(
      '"category"."deleted_at" is null',
    );

    observer!.queries.length = 0;
    const updated = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.productUnderDeletedCategoryId,
      false,
    );

    expect(updated).toBe(false);
    const updateStatements = updateQueries(observer!.queries);
    expect(updateStatements).toHaveLength(1);
    expect(updateStatements[0].query).toContain(
      '"category"."deleted_at" is null',
    );
    expect(
      await readProductState(fixture.productUnderDeletedCategoryId),
    ).toEqual(before);
    expect(before.row.isActive).toBe(true);

    const legacy = await listCatalogProducts(asAppDb(testDb!.db));
    const legacyProduct = legacy.find(
      (p) => p.id === fixture.productUnderDeletedCategoryId,
    );
    expect(legacyProduct?.translations.en?.name).toBe(
      "A Under Deleted Category",
    );
  });

  it("does not update a soft-deleted product", async () => {
    const before = await readProductState(fixture.deletedProductId);

    const updated = await updateCatalogProductAvailabilityForStore(
      observer!.db,
      scopeA,
      fixture.deletedProductId,
      false,
    );

    expect(updated).toBe(false);
    expect(await readProductState(fixture.deletedProductId)).toEqual(before);
    expect(before.row.isActive).toBe(true);
  });

  it("denies raw, lookalike, null, undefined and array scopes before any catalog SQL", async () => {
    const bBefore = await readProductState(fixture.productBId);
    const hostileScopes: unknown[] = [
      null,
      undefined,
      fixture.storeAId,
      { storeId: fixture.storeAId },
      [fixture.storeAId],
    ];

    for (const hostile of hostileScopes) {
      observer!.queries.length = 0;

      await expect(
        listCatalogProductsForStore(
          observer!.db,
          hostile as StoreScope,
        ),
      ).rejects.toMatchObject({ code: "TENANT_CONTEXT_INVALID" });
      expect(observer!.queries).toHaveLength(0);

      await expect(
        updateCatalogProductAvailabilityForStore(
          observer!.db,
          hostile as StoreScope,
          fixture.productBId,
          false,
        ),
      ).rejects.toMatchObject({ code: "TENANT_CONTEXT_INVALID" });
      expect(observer!.queries).toHaveLength(0);

      await expect(
        updateCatalogProductPriceForStore(
          observer!.db,
          hostile as StoreScope,
          fixture.productBId,
          "1.00",
        ),
      ).rejects.toMatchObject({ code: "TENANT_CONTEXT_INVALID" });
      expect(observer!.queries).toHaveLength(0);
    }

    expect(await readProductState(fixture.productBId)).toEqual(bBefore);
    expect(bBefore.row.isActive).toBe(true);
  });

  it("cannot issue a scope for a nonexistent or empty store id", async () => {
    const storeCount = async () => {
      const rows = await testDb!.db
        .select({ id: store.id })
        .from(store)
        .orderBy(store.id);
      return rows.map((row) => row.id);
    };

    const before = await storeCount();

    await expect(
      readStoreScopeForFixture(testDb!.db, globalThis.crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      readStoreScopeForFixture(testDb!.db, ""),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(await storeCount()).toEqual(before);
  });
});

describe("scoped-operation production surface", () => {
  it("wires only the reviewed merchant list and price paths", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../../src");
    const catalogModule = path.join("lib", "data", "catalog.ts");
    const storeScopeModule = path.join("lib", "data", "store-scope.ts");
    const merchantResolver = path.join("lib", "auth", "merchant-session.ts");
    const merchantCatalog = path.join("lib", "merchant", "catalog.ts");
    const productsPage = path.join("app", "app", "products", "page.tsx");

    const allowed = new Set([
      catalogModule,
      storeScopeModule,
      merchantResolver,
      merchantCatalog,
      productsPage,
    ]);

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : [path.join(dir, entry.name)],
      );

    const listOffenders: string[] = [];
    const priceOffenders: string[] = [];
    const merchantPriceOffenders: string[] = [];
    const merchantPriceReadOffenders: string[] = [];
    const availabilityOffenders: string[] = [];
    const scopeIssuerOffenders: string[] = [];

    for (const file of walk(srcRoot)) {
      const relative = path.relative(srcRoot, file);
      if (allowed.has(relative)) continue;

      const source = readFileSync(file, "utf8");

      if (source.includes("listCatalogProductsForStore")) {
        listOffenders.push(relative);
      }
      if (source.includes("updateCatalogProductPriceForStore")) {
        priceOffenders.push(relative);
      }
      if (source.includes("updateCatalogProductPriceForMerchant")) {
        merchantPriceOffenders.push(relative);
      }
      if (source.includes("readCatalogProductPriceForMerchant")) {
        merchantPriceReadOffenders.push(relative);
      }
      if (source.includes("updateCatalogProductAvailabilityForStore")) {
        availabilityOffenders.push(relative);
      }
      if (source.includes("createStoreScopeForExistingStore")) {
        scopeIssuerOffenders.push(relative);
      }
    }

    // The list is reachable only from the protected merchant page; the price
    // mutation only through the merchant mutation module. Availability remains
    // test-only, and the scope issuer is still only the data layer plus the
    // authenticated merchant resolver.
    expect(listOffenders).toEqual([]);
    expect(priceOffenders).toEqual([]);
    expect(merchantPriceOffenders).toEqual([]);
    expect(merchantPriceReadOffenders).toEqual([]);
    expect(availabilityOffenders).toEqual([]);
    expect(scopeIssuerOffenders).toEqual([]);

    const page = readFileSync(path.join(srcRoot, productsPage), "utf8");
    expect(page).toContain("requireMerchantAccess");
    expect(page).toContain("listCatalogProductsForStore");
    expect(page).not.toContain("updateCatalogProductPriceForStore");
    expect(page).not.toContain("updateCatalogProductPriceForMerchant");
    expect(page).not.toContain("readCatalogProductPriceForMerchant");
    expect(page).not.toContain("searchParams");
    expect(page).not.toContain("storeId");

    const merchantModule = readFileSync(
      path.join(srcRoot, merchantCatalog),
      "utf8",
    );
    expect(merchantModule).toContain("updateCatalogProductPriceForMerchant");
    expect(merchantModule).toContain("readCatalogProductPriceForMerchant");
    expect(merchantModule).not.toContain("updateCatalogProductPriceForStore");

    const barrel = readFileSync(
      path.join(srcRoot, "lib", "data", "index.ts"),
      "utf8",
    );
    expect(barrel).not.toContain("./store-scope");
  });
});
