import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { category, language, product } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  createCatalogCategory,
  createCatalogProduct,
  editCatalogCategory,
  editCatalogProduct,
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

    expect(childRes.categoryId).toBeDefined();

    const childCat = await readCatalogCategory(appDb, childRes.categoryId);
    expect(childCat).not.toBeNull();
    expect(childCat?.slug).toBe("smartphones");
    expect(childCat?.parentId).toBe(rootRes.categoryId);
    expect(childCat?.isActive).toBe(false);
    expect(childCat?.translations.en?.name).toBe("Smartphones");

    // Verify list categories reflects parent-child relationships
    const allCats = await listCatalogCategories(appDb);
    const foundRoot = allCats.find((c) => c.id === rootRes.categoryId);
    const foundChild = allCats.find((c) => c.id === childRes.categoryId);
    expect(foundRoot).toBeDefined();
    expect(foundChild).toBeDefined();
    expect(foundChild?.parentId).toBe(foundRoot?.id);
  });

  it("updates category base fields and allows saving Arabic while Arabic remains disabled in database", async () => {
    const appDb = asAppDb(testDb!.db);

    // Verify Arabic language record is initially disabled
    const [arBefore] = await testDb!.db
      .select({ isEnabled: language.isEnabled })
      .from(language)
      .where(eq(language.id, arabicLangId));
    expect(arBefore?.isEnabled).toBe(false);

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

    // Verify Arabic language record in database was NOT enabled by saving Arabic content
    const [arAfter] = await testDb!.db
      .select({ isEnabled: language.isEnabled })
      .from(language)
      .where(eq(language.id, arabicLangId));
    expect(arAfter?.isEnabled).toBe(false);
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

  it("atomically rolls back category edit if translation fails, preserving base fields and existing translations", async () => {
    const appDb = asAppDb(testDb!.db);

    const created = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "original-cat-slug",
      translations: [
        {
          languageId: defaultLangId,
          name: "Original Cat",
          description: "Original Desc",
        },
      ],
    });

    const before = await readCatalogCategory(appDb, created.categoryId);
    expect(before?.slug).toBe("original-cat-slug");
    expect(before?.isActive).toBe(false);

    // Attempt edit with new slug, isActive = true, and invalid translation languageId
    await expect(
      editCatalogCategory(appDb, {
        categoryId: created.categoryId,
        slug: "attempted-new-cat-slug",
        isActive: true,
        translation: {
          languageId: globalThis.crypto.randomUUID(), // non-existent language
          name: "Failed Translation",
        },
      }),
    ).rejects.toThrow();

    // Verify base fields and translations are untouched
    const after = await readCatalogCategory(appDb, created.categoryId);
    expect(after?.slug).toBe("original-cat-slug");
    expect(after?.isActive).toBe(false);
    expect(after?.translations.en?.name).toBe("Original Cat");
    expect(after?.translations.en?.description).toBe("Original Desc");
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

  it("assigns next sort order correctly past soft-deleted tombstone categories to avoid index collisions", async () => {
    const appDb = asAppDb(testDb!.db);

    await createCatalogCategory(appDb, {
      parentId: null,
      slug: "tombstone-test-a",
      translations: [{ languageId: defaultLangId, name: "Cat A" }],
    });

    const catB = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "tombstone-test-b",
      translations: [{ languageId: defaultLangId, name: "Cat B" }],
    });

    const recordB = await readCatalogCategory(appDb, catB.categoryId);
    expect(recordB).not.toBeNull();

    // Soft-delete category B
    await testDb!.db
      .update(category)
      .set({ deletedAt: new Date() })
      .where(eq(category.id, catB.categoryId));

    // Create category C; nextOrder must inspect all rows (including B) so sortOrder > B.sortOrder
    const catC = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "tombstone-test-c",
      translations: [{ languageId: defaultLangId, name: "Cat C" }],
    });

    const recordC = await readCatalogCategory(appDb, catC.categoryId);
    expect(recordC).not.toBeNull();
    expect(recordC!.sortOrder).toBeGreaterThan(recordB!.sortOrder);
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

  it("atomically rolls back product edit if translation fails, preserving base fields and existing translations", async () => {
    const appDb = asAppDb(testDb!.db);

    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "edit-rollback-cat",
      translations: [{ languageId: defaultLangId, name: "Edit Rollback Cat" }],
    });

    const prod = await createCatalogProduct(appDb, {
      categoryId: cat.categoryId,
      slug: "original-prod-slug",
      price: "19.99",
      translations: [
        {
          languageId: defaultLangId,
          name: "Original Prod Name",
          description: "Original Prod Desc",
        },
      ],
    });

    const before = await readCatalogProduct(appDb, prod.productId);
    expect(before?.slug).toBe("original-prod-slug");
    expect(before?.price).toBe("19.99");
    expect(before?.isActive).toBe(false);

    // Attempt edit with changed slug, price, isActive, and invalid translation languageId
    await expect(
      editCatalogProduct(appDb, {
        productId: prod.productId,
        slug: "attempted-new-prod-slug",
        price: "89.99",
        isActive: true,
        translation: {
          languageId: globalThis.crypto.randomUUID(), // invalid language
          name: "Failed Prod Translation",
        },
      }),
    ).rejects.toThrow();

    // Verify base fields and translations are completely unchanged
    const after = await readCatalogProduct(appDb, prod.productId);
    expect(after?.slug).toBe("original-prod-slug");
    expect(after?.price).toBe("19.99");
    expect(after?.isActive).toBe(false);
    expect(after?.translations.en?.name).toBe("Original Prod Name");
    expect(after?.translations.en?.description).toBe("Original Prod Desc");
  });

  it("lists categories and products in deterministic sort order", async () => {
    const appDb = asAppDb(testDb!.db);

    const orderedCat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "ordered-parent-cat",
      translations: [{ languageId: defaultLangId, name: "Ordered Parent" }],
    });

    // Create 3 products with distinct sort order under this category
    const p1 = await createCatalogProduct(appDb, {
      categoryId: orderedCat.categoryId,
      slug: "alpha-product",
      price: "10.00",
      translations: [{ languageId: defaultLangId, name: "Alpha Product" }],
    });

    const p2 = await createCatalogProduct(appDb, {
      categoryId: orderedCat.categoryId,
      slug: "beta-product",
      price: "20.00",
      translations: [{ languageId: defaultLangId, name: "Beta Product" }],
    });

    const p3 = await createCatalogProduct(appDb, {
      categoryId: orderedCat.categoryId,
      slug: "gamma-product",
      price: "30.00",
      translations: [{ languageId: defaultLangId, name: "Gamma Product" }],
    });

    const prods = await listCatalogProducts(appDb, orderedCat.categoryId);
    expect(prods.map((p) => p.id)).toEqual([p1.productId, p2.productId, p3.productId]);
    expect(prods[0].sortOrder).toBeLessThan(prods[1].sortOrder);
    expect(prods[1].sortOrder).toBeLessThan(prods[2].sortOrder);
  });

  it("verifies category and product creation and subsequent editing under English default", async () => {
    const appDb = asAppDb(testDb!.db);

    // Create category with English default
    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "en-default-cat",
      translations: [{ languageId: defaultLangId, name: "EN Default Category" }],
    });

    const catAfterCreate = await readCatalogCategory(appDb, cat.categoryId);
    expect(catAfterCreate?.translations.en?.name).toBe("EN Default Category");
    expect(catAfterCreate?.translations.ar).toBeUndefined();

    // Subsequent edit: add Arabic translation
    await saveCatalogCategoryTranslation(appDb, {
      categoryId: cat.categoryId,
      languageId: arabicLangId,
      name: "فئة بالإنجليزية أصلا",
      description: "وصف عربي",
    });

    const catAfterEdit = await readCatalogCategory(appDb, cat.categoryId);
    expect(catAfterEdit?.translations.en?.name).toBe("EN Default Category");
    expect(catAfterEdit?.translations.ar?.name).toBe("فئة بالإنجليزية أصلا");
    expect(catAfterEdit?.translations.ar?.description).toBe("وصف عربي");

    // Create product with English default
    const prod = await createCatalogProduct(appDb, {
      categoryId: cat.categoryId,
      slug: "en-default-prod",
      price: "15.00",
      translations: [
        {
          languageId: defaultLangId,
          name: "EN Default Product",
          description: "Desc",
          details: "Details",
        },
      ],
    });

    const prodAfterCreate = await readCatalogProduct(appDb, prod.productId);
    expect(prodAfterCreate?.translations.en?.name).toBe("EN Default Product");
    expect(prodAfterCreate?.translations.ar).toBeUndefined();

    // Subsequent edit: add Arabic translation
    await saveCatalogProductTranslation(appDb, {
      productId: prod.productId,
      languageId: arabicLangId,
      name: "منتج بالإنجليزية أصلا",
      description: "وصف عربي",
      details: "تفاصيل عربية",
    });

    const prodAfterEdit = await readCatalogProduct(appDb, prod.productId);
    expect(prodAfterEdit?.translations.en?.name).toBe("EN Default Product");
    expect(prodAfterEdit?.translations.ar?.name).toBe("منتج بالإنجليزية أصلا");
    expect(prodAfterEdit?.translations.ar?.description).toBe("وصف عربي");
  });

  it("verifies category and product creation and subsequent editing under Arabic default", async () => {
    const testDbAr = await createTestDatabase("catalog_persistence_ar_default");
    try {
      const arAppDb = asAppDb(testDbAr.db);

      const arLang = await ensureLanguage(arAppDb, {
        code: "ar",
        label: "العربية",
        textDirection: "rtl",
        isEnabled: true,
      });

      const enLang = await ensureLanguage(arAppDb, {
        code: "en",
        label: "English",
        textDirection: "ltr",
        isEnabled: true,
      });

      await initializeSettings(arAppDb, {
        displayName: "متجر عربي",
        currency: "SAR",
        defaultLanguageCode: "ar",
      });

      // 1. Create Category with Arabic as default language
      const cat = await createCatalogCategory(arAppDb, {
        parentId: null,
        slug: "ar-root-cat",
        translations: [
          {
            languageId: arLang.id,
            name: "فئة عربية أصلية",
            description: "وصف الفئة العربية",
          },
        ],
      });

      const catAfterCreate = await readCatalogCategory(arAppDb, cat.categoryId);
      expect(catAfterCreate?.translations.ar?.name).toBe("فئة عربية أصلية");
      expect(catAfterCreate?.translations.ar?.description).toBe("وصف الفئة العربية");
      expect(catAfterCreate?.translations.en).toBeUndefined();
      expect(Object.keys(catAfterCreate?.translations ?? {})).toEqual(["ar"]);

      // Subsequent edit: add English translation to category
      await saveCatalogCategoryTranslation(arAppDb, {
        categoryId: cat.categoryId,
        languageId: enLang.id,
        name: "Original Arabic Category in English",
        description: "English description",
      });

      const catAfterEdit = await readCatalogCategory(arAppDb, cat.categoryId);
      expect(catAfterEdit?.translations.ar?.name).toBe("فئة عربية أصلية");
      expect(catAfterEdit?.translations.en?.name).toBe("Original Arabic Category in English");

      // 2. Create Product with Arabic as default language
      const prod = await createCatalogProduct(arAppDb, {
        categoryId: cat.categoryId,
        slug: "ar-default-prod",
        price: "75.00",
        translations: [
          {
            languageId: arLang.id,
            name: "منتج عربي أصلي",
            description: "وصف موجز للمنتج",
            details: "تفاصيل كاملة للمنتج",
          },
        ],
      });

      const prodAfterCreate = await readCatalogProduct(arAppDb, prod.productId);
      expect(prodAfterCreate?.translations.ar?.name).toBe("منتج عربي أصلي");
      expect(prodAfterCreate?.translations.ar?.description).toBe("وصف موجز للمنتج");
      expect(prodAfterCreate?.translations.en).toBeUndefined();
      expect(Object.keys(prodAfterCreate?.translations ?? {})).toEqual(["ar"]);

      // Subsequent edit: add English translation to product
      await saveCatalogProductTranslation(arAppDb, {
        productId: prod.productId,
        languageId: enLang.id,
        name: "Original Arabic Product in English",
        description: "English short desc",
        details: "English full details",
      });

      const prodAfterEdit = await readCatalogProduct(arAppDb, prod.productId);
      expect(prodAfterEdit?.translations.ar?.name).toBe("منتج عربي أصلي");
      expect(prodAfterEdit?.translations.en?.name).toBe("Original Arabic Product in English");
      expect(prodAfterEdit?.translations.en?.description).toBe("English short desc");
    } finally {
      await testDbAr.close();
    }
  });
});
