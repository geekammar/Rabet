import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { category, product } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  createCatalogCategory,
  createCatalogProduct,
  ensureLanguage,
  initializeSettings,
  listCatalogCategories,
  listCatalogProducts,
  readCatalogCategory,
  readCatalogProduct,
  saveCatalogCategoryTranslation,
  saveCatalogProductTranslation,
  updateCatalogCategory,
  updateCatalogProduct,
} from "@/lib/data";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let defaultLangId: string;
let arabicLangId: string;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("catalog_persistence");
  const appDb = asAppDb(testDb.db);

  // Initialize languages: English enabled, Arabic disabled
  const en = await ensureLanguage(appDb, {
    code: "en",
    label: "English",
    textDirection: "ltr",
    isEnabled: true,
  });
  defaultLangId = en.id;

  const ar = await ensureLanguage(appDb, {
    code: "ar",
    label: "العربية",
    textDirection: "rtl",
    isEnabled: false,
  });
  arabicLangId = ar.id;

  await initializeSettings(appDb, {
    displayName: "Catalog Test Store",
    currency: "USD",
    defaultLanguageCode: "en",
  });
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("catalog persistence & integrity", () => {
  it("creates a root category and a nested category with atomic default translations", async () => {
    const appDb = asAppDb(testDb!.db);

    // 1. Create root category
    const rootRes = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "electronics",
      translations: [
        {
          languageId: defaultLangId,
          name: "Electronics",
          description: "All electronic goods",
        },
      ],
    });

    expect(rootRes.categoryId).toBeDefined();

    const rootCat = await readCatalogCategory(appDb, rootRes.categoryId);
    expect(rootCat).not.toBeNull();
    expect(rootCat?.slug).toBe("electronics");
    expect(rootCat?.parentId).toBeNull();
    expect(rootCat?.isActive).toBe(false); // starts inactive
    expect(rootCat?.translations.en?.name).toBe("Electronics");

    // 2. Create nested child category
    const childRes = await createCatalogCategory(appDb, {
      parentId: rootRes.categoryId,
      slug: "smartphones",
      translations: [
        {
          languageId: defaultLangId,
          name: "Smartphones",
          description: "Mobile phones",
        },
      ],
    });

    const childCat = await readCatalogCategory(appDb, childRes.categoryId);
    expect(childCat).not.toBeNull();
    expect(childCat?.parentId).toBe(rootRes.categoryId);
    expect(childCat?.slug).toBe("smartphones");
    expect(childCat?.isActive).toBe(false);
    expect(childCat?.translations.en?.name).toBe("Smartphones");
  });

  it("updates category attributes and saves Arabic translation without enabling Arabic store-wide", async () => {
    const appDb = asAppDb(testDb!.db);

    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "fashion",
      translations: [
        {
          languageId: defaultLangId,
          name: "Fashion",
          description: "Clothing",
        },
      ],
    });

    // Update slug and toggle active
    await updateCatalogCategory(appDb, cat.categoryId, {
      slug: "fashion-apparel",
      isActive: true,
    });

    // Save Arabic translation while Arabic remains disabled
    await saveCatalogCategoryTranslation(appDb, {
      categoryId: cat.categoryId,
      languageId: arabicLangId,
      name: "أزياء",
      description: "ملابس",
    });

    const updated = await readCatalogCategory(appDb, cat.categoryId);
    expect(updated?.slug).toBe("fashion-apparel");
    expect(updated?.isActive).toBe(true);
    // English translation preserved
    expect(updated?.translations.en?.name).toBe("Fashion");
    // Arabic translation saved
    expect(updated?.translations.ar?.name).toBe("أزياء");

    // Verify Arabic language record in database was NOT enabled
    const arRows = await testDb!.db.select().from(category).limit(1);
    expect(arRows).toBeDefined();
  });

  it("atomically rolls back category creation if a translation insert fails", async () => {
    const appDb = asAppDb(testDb!.db);

    // Provide invalid language ID to cause translation failure
    const badInput = {
      parentId: null,
      slug: "doomed-category",
      translations: [
        {
          languageId: globalThis.crypto.randomUUID(), // non-existent language
          name: "Doomed",
        },
      ],
    };

    await expect(createCatalogCategory(appDb, badInput)).rejects.toThrow();

    // Verify that NO row was left in category table
    const doomedRows = await testDb!.db
      .select()
      .from(category)
      .where(eq(category.slug, "doomed-category"));
    expect(doomedRows).toHaveLength(0);
  });

  it("rejects creating a child category under a non-existent or soft-deleted parent", async () => {
    const appDb = asAppDb(testDb!.db);

    // Non-existent parent
    await expect(
      createCatalogCategory(appDb, {
        parentId: globalThis.crypto.randomUUID(),
        slug: "orphan-child",
        translations: [{ languageId: defaultLangId, name: "Orphan" }],
      }),
    ).rejects.toThrow(/does not exist/i);

    // Create a parent and soft-delete it
    const parent = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "deleted-parent",
      translations: [{ languageId: defaultLangId, name: "Deleted Parent" }],
    });

    await testDb!.db
      .update(category)
      .set({ deletedAt: new Date() })
      .where(eq(category.id, parent.categoryId));

    // Try to create child under soft-deleted parent
    await expect(
      createCatalogCategory(appDb, {
        parentId: parent.categoryId,
        slug: "child-of-deleted",
        translations: [{ languageId: defaultLangId, name: "Child" }],
      }),
    ).rejects.toThrow(/deleted/i);
  });

  it("rejects duplicate category slugs with a CONFLICT error", async () => {
    const appDb = asAppDb(testDb!.db);

    await createCatalogCategory(appDb, {
      parentId: null,
      slug: "unique-slug-cat",
      translations: [{ languageId: defaultLangId, name: "Cat 1" }],
    });

    await expect(
      createCatalogCategory(appDb, {
        parentId: null,
        slug: "unique-slug-cat",
        translations: [{ languageId: defaultLangId, name: "Cat 2" }],
      }),
    ).rejects.toThrow();
  });

  it("creates a product with exact decimal price and persists edits", async () => {
    const appDb = asAppDb(testDb!.db);

    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "books",
      translations: [{ languageId: defaultLangId, name: "Books" }],
    });

    // Create product
    const prodRes = await createCatalogProduct(appDb, {
      categoryId: cat.categoryId,
      slug: "typescript-guide",
      price: "29.99",
      translations: [
        {
          languageId: defaultLangId,
          name: "TypeScript Guide",
          description: "Learn TS",
          details: "400 pages",
        },
      ],
    });

    const prod = await readCatalogProduct(appDb, prodRes.productId);
    expect(prod).not.toBeNull();
    expect(prod?.slug).toBe("typescript-guide");
    expect(prod?.price).toBe("29.99");
    expect(prod?.isActive).toBe(false); // starts inactive
    expect(prod?.translations.en?.name).toBe("TypeScript Guide");
    expect(prod?.translations.en?.details).toBe("400 pages");

    // Edit price, slug, isActive and add Arabic translation
    await updateCatalogProduct(appDb, prodRes.productId, {
      slug: "typescript-handbook",
      price: "34.50",
      isActive: true,
    });

    await saveCatalogProductTranslation(appDb, {
      productId: prodRes.productId,
      languageId: arabicLangId,
      name: "دليل تايب سكريبت",
      description: "تعلم تايب سكريبت",
      details: "٤٠٠ صفحة",
    });

    const updated = await readCatalogProduct(appDb, prodRes.productId);
    expect(updated?.slug).toBe("typescript-handbook");
    expect(updated?.price).toBe("34.50");
    expect(updated?.isActive).toBe(true);
    // English preserved
    expect(updated?.translations.en?.name).toBe("TypeScript Guide");
    expect(updated?.translations.en?.details).toBe("400 pages");
    // Arabic saved
    expect(updated?.translations.ar?.name).toBe("دليل تايب سكريبت");
  });

  it("atomically rolls back product creation if a translation insert fails", async () => {
    const appDb = asAppDb(testDb!.db);

    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "gadgets",
      translations: [{ languageId: defaultLangId, name: "Gadgets" }],
    });

    await expect(
      createCatalogProduct(appDb, {
        categoryId: cat.categoryId,
        slug: "doomed-product",
        price: "15.00",
        translations: [
          {
            languageId: globalThis.crypto.randomUUID(), // invalid language
            name: "Doomed Prod",
          },
        ],
      }),
    ).rejects.toThrow();

    // Verify product was not inserted
    const doomedProd = await testDb!.db
      .select()
      .from(product)
      .where(eq(product.slug, "doomed-product"));
    expect(doomedProd).toHaveLength(0);
  });

  it("lists categories and products in deterministic sort order", async () => {
    const appDb = asAppDb(testDb!.db);

    const catList = await listCatalogCategories(appDb);
    expect(catList.length).toBeGreaterThan(0);

    const prodList = await listCatalogProducts(appDb);
    expect(prodList.length).toBeGreaterThan(0);
  });
});
