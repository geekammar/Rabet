import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { category, language, product, productAction, productActionTranslation } from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  createCatalogCategory,
  createCatalogProduct,
  createProductAction,
  editProductAction,
  ensureLanguage,
  initializeSettings,
  listProductActions,
  readProductAction,
} from "@/lib/data";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let defaultLangId: string;
let arabicLangId: string;
let testCategoryId: string;

function uniqueSlug(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

async function createProductFixture(prefix = "prod"): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const prod = await createCatalogProduct(appDb, {
    categoryId: testCategoryId,
    slug: uniqueSlug(prefix),
    price: "10.00",
    translations: [{ languageId: defaultLangId, name: `Test ${prefix}` }],
  });
  return prod.productId;
}

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("actions_persistence");
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
    displayName: "Actions Test Store",
    currency: "USD",
    defaultLanguageCode: "en",
  });

  // Create a parent category
  const catRes = await createCatalogCategory(appDb, {
    parentId: null,
    slug: "software",
    translations: [{ languageId: defaultLangId, name: "Software" }],
  });
  testCategoryId = catRes.categoryId;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("product actions persistence & integrity", () => {
  it("creates a root submenu, nested submenu, and terminal children atomically", async () => {
    const testProductId = await createProductFixture("submenus");
    const appDb = asAppDb(testDb!.db);

    // 1. Root submenu: "Choose Options"
    const rootRes = await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: null,
      actionType: "OPEN_SUBMENU",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Choose Options",
          menuText: "Please choose from the options below:",
        },
      ],
    });

    expect(rootRes.actionId).toBeDefined();
    const rootAction = await readProductAction(appDb, rootRes.actionId);
    expect(rootAction).not.toBeNull();
    expect(rootAction?.actionType).toBe("OPEN_SUBMENU");
    expect(rootAction?.parentActionId).toBeNull();
    expect(rootAction?.sortOrder).toBe(0);
    expect(rootAction?.translations.en?.label).toBe("Choose Options");
    expect(rootAction?.translations.en?.menuText).toBe("Please choose from the options below:");

    // 2. Nested submenu: "Deployment Tier"
    const nestedRes = await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: rootRes.actionId,
      actionType: "OPEN_SUBMENU",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Deployment Tier",
          menuText: "Select your cluster size:",
        },
      ],
    });

    expect(nestedRes.actionId).toBeDefined();
    const nestedAction = await readProductAction(appDb, nestedRes.actionId);
    expect(nestedAction?.parentActionId).toBe(rootRes.actionId);
    expect(nestedAction?.sortOrder).toBe(0);

    // 3. Child 1: SHOW_DETAILS ("View Specs")
    const detailsRes = await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: nestedRes.actionId,
      actionType: "SHOW_DETAILS",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "View Specs",
        },
      ],
    });

    const detailsAction = await readProductAction(appDb, detailsRes.actionId);
    expect(detailsAction?.actionType).toBe("SHOW_DETAILS");
    expect(detailsAction?.parentActionId).toBe(nestedRes.actionId);
    expect(detailsAction?.sortOrder).toBe(0);

    // 4. Child 2: START_INQUIRY ("Order Now")
    const inquiryRes = await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: nestedRes.actionId,
      actionType: "START_INQUIRY",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Ask about this product",
        },
      ],
    });

    const inquiryAction = await readProductAction(appDb, inquiryRes.actionId);
    expect(inquiryAction?.actionType).toBe("START_INQUIRY");
    expect(inquiryAction?.parentActionId).toBe(nestedRes.actionId);
    expect(inquiryAction?.sortOrder).toBe(1); // deterministic sequential sibling ordering
  });

  it("rolls back base action creation if translation persistence fails", async () => {
    const testProductId = await createProductFixture("rollback-create");
    const appDb = asAppDb(testDb!.db);

    const countBefore = (await appDb.select().from(productAction)).length;

    // Provide invalid language ID that causes FK violation
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        actionType: "SHOW_DETAILS",
        translations: [
          {
            languageId: "00000000-0000-0000-0000-000000000099",
            languageCode: "en",
            label: "Rollback Test",
          },
        ],
      }),
    ).rejects.toThrow();

    const countAfter = (await appDb.select().from(productAction)).length;
    expect(countAfter).toBe(countBefore);
  });

  it("enforces same-product parent rule and rejects terminal action parents", async () => {
    const testProductId = await createProductFixture("same-product-rule");
    const appDb = asAppDb(testDb!.db);

    // Create a second product
    const otherProd = await createCatalogProduct(appDb, {
      categoryId: (await appDb.select().from(category))[0].id,
      slug: "other-prod",
      price: "10.00",
      translations: [{ languageId: defaultLangId, name: "Other Prod" }],
    });

    // Create a menu in other product
    const otherMenu = await createProductAction(appDb, {
      productId: otherProd.productId,
      actionType: "OPEN_SUBMENU",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Other Menu" }],
    });

    // Attempt to nest an action of testProductId under otherMenu (different product)
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        parentActionId: otherMenu.actionId,
        actionType: "START_INQUIRY",
        translations: [{ languageId: defaultLangId, languageCode: "en", label: "Cross-Product" }],
      }),
    ).rejects.toThrow(/different product/i);

    // Create a terminal action in testProductId
    const terminal = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "SHOW_DETAILS",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Terminal Button" }],
    });

    // Attempt to create a child under terminal action
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        parentActionId: terminal.actionId,
        actionType: "START_INQUIRY",
        translations: [{ languageId: defaultLangId, languageCode: "en", label: "Invalid Child" }],
      }),
    ).rejects.toThrow(/Only OPEN_SUBMENU buttons can have children/i);
  });

  it("rejects changing an OPEN_SUBMENU to a terminal type while child buttons exist", async () => {
    const testProductId = await createProductFixture("reject-type-change");
    const appDb = asAppDb(testDb!.db);

    const parentMenu = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Parent Submenu" }],
    });

    await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: parentMenu.actionId,
      actionType: "SHOW_DETAILS",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Child Leaf" }],
    });

    // Attempt to edit parentMenu's type to START_INQUIRY
    await expect(
      editProductAction(appDb, {
        actionId: parentMenu.actionId,
        productId: testProductId,
        actionType: "START_INQUIRY",
        isActive: true,
      }),
    ).rejects.toThrow(/child button\(s\), so its type cannot change away from OPEN_SUBMENU/i);

    // Database state remains OPEN_SUBMENU
    const reloaded = await readProductAction(appDb, parentMenu.actionId);
    expect(reloaded?.actionType).toBe("OPEN_SUBMENU");
  });

  it("preserves disabled Arabic language status when saving Arabic translation", async () => {
    const testProductId = await createProductFixture("arabic-disabled");
    const appDb = asAppDb(testDb!.db);

    // Confirm Arabic is currently disabled
    const [arabicBefore] = await appDb
      .select()
      .from(language)
      .where(eq(language.id, arabicLangId));
    expect(arabicBefore.isEnabled).toBe(false);

    // Create action with both English and Arabic translations
    const actionRes = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      isActive: true,
      translations: [
        {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Support",
          menuText: "Select option",
        },
        {
          languageId: arabicLangId,
          languageCode: "ar",
          label: "الدعم الفني",
          menuText: "اختر خياراً",
        },
      ],
    });

    // Check saved translations
    const saved = await readProductAction(appDb, actionRes.actionId);
    expect(saved?.translations.en?.label).toBe("Support");
    expect(saved?.translations.ar?.label).toBe("الدعم الفني");

    // Edit Arabic translation
    await editProductAction(appDb, {
      actionId: actionRes.actionId,
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      isActive: true,
      translation: {
        languageId: arabicLangId,
        languageCode: "ar",
        label: "مركز المساعدة",
        menuText: "تفضل بالاختيار",
      },
    });

    const updated = await readProductAction(appDb, actionRes.actionId);
    expect(updated?.translations.ar?.label).toBe("مركز المساعدة");
    // English translation was preserved
    expect(updated?.translations.en?.label).toBe("Support");

    // Verify Arabic language remains disabled globally in language table
    const [arabicAfter] = await appDb
      .select()
      .from(language)
      .where(eq(language.id, arabicLangId));
    expect(arabicAfter.isEnabled).toBe(false);
  });

  it("enforces active child limit (MAX_ACTIVE_CHILDREN = 20)", async () => {
    const testProductId = await createProductFixture("child-limit-20");
    const appDb = asAppDb(testDb!.db);

    const limitParent = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Limit Test Menu" }],
    });

    // Create 20 active children
    for (let i = 0; i < 20; i++) {
      await createProductAction(appDb, {
        productId: testProductId,
        parentActionId: limitParent.actionId,
        actionType: "START_INQUIRY",
        isActive: true,
        translations: [{ languageId: defaultLangId, languageCode: "en", label: `Option ${i + 1}` }],
      });
    }

    // Creating a 21st active child must fail
    await expect(
      createProductAction(appDb, {
        productId: testProductId,
        parentActionId: limitParent.actionId,
        actionType: "START_INQUIRY",
        isActive: true,
        translations: [{ languageId: defaultLangId, languageCode: "en", label: "Option 21" }],
      }),
    ).rejects.toThrow(/Active child limit reached/i);

    // Creating an inactive 21st child succeeds
    const inactive21 = await createProductAction(appDb, {
      productId: testProductId,
      parentActionId: limitParent.actionId,
      actionType: "START_INQUIRY",
      isActive: false,
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Option 21 (Inactive)" }],
    });
    expect(inactive21.actionId).toBeDefined();

    // Activating the 21st child via edit fails
    await expect(
      editProductAction(appDb, {
        actionId: inactive21.actionId,
        productId: testProductId,
        actionType: "START_INQUIRY",
        isActive: true,
      }),
    ).rejects.toThrow(/Active button limit reached/i);
  });

  it("rolls back atomically on EDIT if translation update fails, leaving base fields and existing translations unchanged", async () => {
    const testProductId = await createProductFixture("edit-rollback");
    const appDb = asAppDb(testDb!.db);

    const created = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      isActive: true,
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Original Label", menuText: "Original Menu" }],
    });

    // Attempt atomic update with a bogus language ID (fails foreign key) while altering isActive and actionType
    const nonexistentLangId = "00000000-0000-0000-0000-000000000099";

    await expect(
      editProductAction(appDb, {
        actionId: created.actionId,
        productId: testProductId,
        actionType: "SHOW_DETAILS",
        isActive: false,
        translation: {
          languageId: nonexistentLangId,
          languageCode: "en",
          label: "Corrupted Label",
        },
      }),
    ).rejects.toThrow();

    // Verify database state: base action and translation remain in their original state
    const afterFailedEdit = await readProductAction(appDb, created.actionId);
    expect(afterFailedEdit?.actionType).toBe("OPEN_SUBMENU");
    expect(afterFailedEdit?.isActive).toBe(true);
    expect(afterFailedEdit?.translations.en?.label).toBe("Original Label");
    expect(afterFailedEdit?.translations.en?.menuText).toBe("Original Menu");
  });

  it("enforces active child limit safely under concurrent activations at the boundary (19 active siblings)", async () => {
    const testProductId = await createProductFixture("concurrent-boundary");
    const appDb = asAppDb(testDb!.db);

    const concurrentParent = await createProductAction(appDb, {
      productId: testProductId,
      actionType: "OPEN_SUBMENU",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Concurrent Boundary Menu" }],
    });

    // Seed 19 active buttons
    for (let i = 0; i < 19; i++) {
      await createProductAction(appDb, {
        productId: testProductId,
        parentActionId: concurrentParent.actionId,
        actionType: "SHOW_DETAILS",
        isActive: true,
        translations: [{ languageId: defaultLangId, languageCode: "en", label: `Active ${i + 1}` }],
      });
    }

    // Seed 5 inactive buttons
    const inactiveActions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await createProductAction(appDb, {
        productId: testProductId,
        parentActionId: concurrentParent.actionId,
        actionType: "SHOW_DETAILS",
        isActive: false,
        translations: [{ languageId: defaultLangId, languageCode: "en", label: `Inactive Candidate ${i + 1}` }],
      });
      inactiveActions.push(res.actionId);
    }

    // Launch 5 concurrent activations simultaneously
    const results = await Promise.allSettled(
      inactiveActions.map((actionId) =>
        editProductAction(appDb, {
          actionId,
          productId: testProductId,
          actionType: "SHOW_DETAILS",
          isActive: true,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 1 must succeed (reaching 20) and 4 must be safely rejected
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);

    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason.message).toMatch(/Active button limit reached/i);
      }
    }

    // Verify in database: total active children under this parent is EXACTLY 20, never 21+
    const activeChildrenInDb = await appDb
      .select()
      .from(productAction)
      .where(eq(productAction.parentActionId, concurrentParent.actionId));

    const totalActive = activeChildrenInDb.filter((a) => a.isActive).length;
    expect(totalActive).toBe(20);
  });

  it("rejects load, create, and edit for non-existent or soft-deleted products", async () => {
    const appDb = asAppDb(testDb!.db);

    // Create a product to soft delete
    const [cat] = await appDb.select().from(category).limit(1);
    const prodToDel = await createCatalogProduct(appDb, {
      categoryId: cat.id,
      slug: "to-be-deleted-for-actions",
      price: "10.00",
      translations: [{ languageId: defaultLangId, name: "Deleted Prod" }],
    });

    const actionUnderProd = await createProductAction(appDb, {
      productId: prodToDel.productId,
      actionType: "START_INQUIRY",
      translations: [{ languageId: defaultLangId, languageCode: "en", label: "Initial Action" }],
    });

    // Soft delete the product
    await appDb
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, prodToDel.productId));

    // 1. listProductActions must reject
    await expect(listProductActions(appDb, prodToDel.productId)).rejects.toThrow(
      /does not exist or has been deleted/i,
    );

    // 2. createProductAction must reject
    await expect(
      createProductAction(appDb, {
        productId: prodToDel.productId,
        actionType: "SHOW_DETAILS",
        translations: [{ languageId: defaultLangId, languageCode: "en", label: "New Action" }],
      }),
    ).rejects.toThrow(/does not exist or has been deleted/i);

    // 3. editProductAction must reject
    await expect(
      editProductAction(appDb, {
        actionId: actionUnderProd.actionId,
        productId: prodToDel.productId,
        actionType: "SHOW_DETAILS",
        isActive: false,
      }),
    ).rejects.toThrow(/does not exist or has been deleted/i);
  });

  it("preserves unsupported/deferred action records and rejects edits against them", async () => {
    const testProductId = await createProductFixture("deferred-records");
    const appDb = asAppDb(testDb!.db);

    const deferredActionId = globalThis.crypto.randomUUID();
    const deferredTransId = globalThis.crypto.randomUUID();

    // Directly insert a deferred OPEN_URL action into database
    await appDb.insert(productAction).values({
      id: deferredActionId,
      productId: testProductId,
      parentActionId: null,
      actionType: "OPEN_URL",
      url: "https://example.com/info",
      sortOrder: 999,
      isActive: true,
    });

    await appDb.insert(productActionTranslation).values({
      id: deferredTransId,
      actionId: deferredActionId,
      languageId: defaultLangId,
      label: "Visit Our Website",
      menuText: null,
    });

    // 1. listProductActions loads it faithfully without conversion
    const list = await listProductActions(appDb, testProductId);
    const deferredInList = list.find((a) => a.id === deferredActionId);
    expect(deferredInList).toBeDefined();
    expect(deferredInList?.actionType).toBe("OPEN_URL");
    expect(deferredInList?.url).toBe("https://example.com/info");
    expect(deferredInList?.translations.en?.label).toBe("Visit Our Website");

    // 2. editProductAction rejects any edit attempts against it
    await expect(
      editProductAction(appDb, {
        actionId: deferredActionId,
        productId: testProductId,
        actionType: "SHOW_DETAILS",
        isActive: true,
        translation: {
          languageId: defaultLangId,
          languageCode: "en",
          label: "Converted Label",
        },
      }),
    ).rejects.toThrow(/unsupported type "OPEN_URL"/i);

    // 3. Verify in database: type, url, and translation are preserved completely untouched
    const afterEditAttempt = await readProductAction(appDb, deferredActionId);
    expect(afterEditAttempt?.actionType).toBe("OPEN_URL");
    expect(afterEditAttempt?.url).toBe("https://example.com/info");
    expect(afterEditAttempt?.translations.en?.label).toBe("Visit Our Website");
  });
});
