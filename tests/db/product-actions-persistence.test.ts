import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { category, language, productAction } from "@/db/schema";
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
  readProductAction,
} from "@/lib/data";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let defaultLangId: string;
let arabicLangId: string;
let testProductId: string;

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

  // Create a parent category and product
  const catRes = await createCatalogCategory(appDb, {
    parentId: null,
    slug: "software",
    translations: [{ languageId: defaultLangId, name: "Software" }],
  });

  const prodRes = await createCatalogProduct(appDb, {
    categoryId: catRes.categoryId,
    slug: "cloud-pro",
    price: "49.99",
    translations: [{ languageId: defaultLangId, name: "Cloud Pro", details: "Top-tier cloud service." }],
  });
  testProductId = prodRes.productId;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("product actions persistence & integrity", () => {
  it("creates a root submenu, nested submenu, and terminal children atomically", async () => {
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
          label: "Order Now",
        },
      ],
    });

    const inquiryAction = await readProductAction(appDb, inquiryRes.actionId);
    expect(inquiryAction?.actionType).toBe("START_INQUIRY");
    expect(inquiryAction?.parentActionId).toBe(nestedRes.actionId);
    expect(inquiryAction?.sortOrder).toBe(1); // deterministic sequential sibling ordering
  });

  it("rolls back base action creation if translation persistence fails", async () => {
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
});
