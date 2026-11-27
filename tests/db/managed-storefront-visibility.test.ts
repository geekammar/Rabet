import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  category,
  categoryTranslation,
  language,
  product,
  productInventory,
  productTranslation,
  store,
} from "@/db/schema";
import {
  listManagedProducts,
  readManagedProduct,
} from "@/lib/catalog/managed-storefront";
import type { StoreScope } from "@/lib/data/store-scope";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let englishLanguageId = "";
let storeAId = "";
let storeBId = "";
let scopeA: StoreScope;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("managed_storefront");

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
  await testDb.db.execute(sql`delete from product_inventory`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category_translation`);
  await testDb.db.execute(sql`delete from category`);
  await testDb.db.execute(sql`delete from store`);
  await testDb.db.execute(sql`delete from language where id <> ${englishLanguageId}`);

  const [storeA] = await testDb.db
    .insert(store)
    .values({
      name: "Reader Store A",
      slug: `reader-a-${crypto.randomUUID()}`,
      status: "active",
    })
    .returning({ id: store.id });
  const [storeB] = await testDb.db
    .insert(store)
    .values({
      name: "Reader Store B",
      slug: `reader-b-${crypto.randomUUID()}`,
      status: "active",
    })
    .returning({ id: store.id });

  storeAId = storeA.id;
  storeBId = storeB.id;
  scopeA = await readStoreScopeForFixture(testDb.db, storeAId);
});

function db() {
  return testDb!.db;
}

async function seedCategory(
  storeId: string,
  options: { isActive?: boolean } = {},
) {
  const [row] = await db()
    .insert(category)
    .values({
      storeId,
      slug: `reader-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive: options.isActive ?? true,
    })
    .returning({ id: category.id });

  await db().insert(categoryTranslation).values({
    categoryId: row.id,
    languageId: englishLanguageId,
    name: "Reader category",
  });

  return row.id;
}

async function seedProduct(
  storeId: string,
  categoryId: string,
  input: {
    name: string;
    price?: string;
    isActive?: boolean;
    imageUrl?: string | null;
    inventory?: { onHand: number; reserved: number } | null;
  },
) {
  const [row] = await db()
    .insert(product)
    .values({
      storeId,
      categoryId,
      slug: `reader-product-${crypto.randomUUID()}`,
      price: input.price ?? "10.00",
      isActive: input.isActive ?? false,
      imageUrl: input.imageUrl ?? null,
      sortOrder: nextOrder(),
    })
    .returning({ id: product.id });

  await db().insert(productTranslation).values({
    productId: row.id,
    languageId: englishLanguageId,
    name: input.name,
    description: "Reader description",
  });

  if (input.inventory !== null) {
    await db().insert(productInventory).values({
      productId: row.id,
      storeId,
      onHand: input.inventory?.onHand ?? 0,
      reserved: input.inventory?.reserved ?? 0,
    });
  }

  return row.id;
}

describe.skipIf(!shouldRun)("managed storefront reader visibility", () => {
  it("hides an inactive draft from buyers while the merchant preview reads it", async () => {
    const categoryId = await seedCategory(storeAId);
    const productId = await seedProduct(storeAId, categoryId, {
      name: "Draft lamp",
      inventory: { onHand: 5, reserved: 0 },
    });

    const page = await listManagedProducts(asAppDb(db()), scopeA, {
      page: 1,
      pageSize: 20,
    });
    expect(page.items).toEqual([]);
    expect(
      await readManagedProduct(asAppDb(db()), scopeA, productId),
    ).toBeNull();

    const preview = await readManagedProduct(
      asAppDb(db()),
      scopeA,
      productId,
      undefined,
      { mode: "merchant-preview" },
    );

    expect(preview).toMatchObject({
      id: productId,
      name: "Draft lamp",
      description: "Reader description",
      imageUrl: null,
      availability: { available: 5, inStock: true },
    });
  });

  it("keeps an existing no-image product readable with missing inventory as zero", async () => {
    const categoryId = await seedCategory(storeAId);
    const productId = await seedProduct(storeAId, categoryId, {
      name: "No image product",
      isActive: true,
      inventory: null,
    });

    const page = await listManagedProducts(asAppDb(db()), scopeA, {
      page: 1,
      pageSize: 20,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: productId,
      imageUrl: null,
      availability: { available: 0, inStock: false },
    });

    const single = await readManagedProduct(
      asAppDb(db()),
      scopeA,
      productId,
    );
    expect(single).toMatchObject({
      id: productId,
      imageUrl: null,
      availability: { available: 0, inStock: false },
    });
  });

  it("returns a saved image reference and keeps an out-of-stock product visible", async () => {
    const categoryId = await seedCategory(storeAId);
    const productId = await seedProduct(storeAId, categoryId, {
      name: "Last unit",
      isActive: true,
      imageUrl: "https://cdn.example.test/last-unit.jpg",
      inventory: { onHand: 1, reserved: 1 },
    });

    const page = await listManagedProducts(asAppDb(db()), scopeA, {
      page: 1,
      pageSize: 20,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: productId,
      imageUrl: "https://cdn.example.test/last-unit.jpg",
      availability: { available: 0, inStock: false },
    });
  });

  it("never crosses stores even in merchant-preview mode", async () => {
    const categoryB = await seedCategory(storeBId);
    const productB = await seedProduct(storeBId, categoryB, {
      name: "Other store product",
      isActive: false,
      inventory: { onHand: 3, reserved: 0 },
    });

    expect(
      await readManagedProduct(
        asAppDb(db()),
        scopeA,
        productB,
        undefined,
        { mode: "merchant-preview" },
      ),
    ).toBeNull();
  });

  it("marks a product with inactive category ancestry invisible to buyers", async () => {
    const categoryId = await seedCategory(storeAId, { isActive: false });
    await seedProduct(storeAId, categoryId, {
      name: "Hidden category product",
      isActive: true,
      inventory: { onHand: 4, reserved: 0 },
    });

    const page = await listManagedProducts(asAppDb(db()), scopeA, {
      page: 1,
      pageSize: 20,
    });
    expect(page.items).toEqual([]);
  });
});
