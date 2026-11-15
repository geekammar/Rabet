import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";

import {
  botSetting,
  category,
  categoryTranslation,
  customer,
  inquiry,
  inquiryMessage,
  language,
  messageTemplate,
  messageTranslation,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  sellerNotificationDelivery,
  telegramUpdate,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  recordVerificationSuccess,
  saveSellerNotificationConfig,
  setSellerNotificationEnabled,
} from "@/lib/data";
import {
  createFakeTelegramTransport,
  type FakeTelegramTransport,
} from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";
import { isProductHierarchyActive } from "@/lib/catalog/eligibility";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let enLangId: string;
let arLangId: string;
let welcomeTemplateId: string;

const TEST_BOT_TOKEN = "123456789:STOREFRONT_TEST_TOKEN";
const TEST_WEBHOOK_SECRET = "storefront-webhook-secret-32-characters";

let sequence = 0;
let updateId = 70_000;
let sortSequence = 1000;

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function nextTelegramId(): number {
  sequence += 1;
  return 600_000_000 + sequence;
}

function nextOrder(): number {
  sortSequence += 1;
  return sortSequence;
}

function createWebhookRequest(body: unknown): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
}

async function sendStart(
  telegramId: number,
  options: { transport?: FakeTelegramTransport; updateIdOverride?: number } = {},
): Promise<{ res: Response; transport: FakeTelegramTransport }> {
  const transport = options.transport ?? createFakeTelegramTransport();
  const id = options.updateIdOverride ?? nextUpdateId();
  const res = await handleTelegramWebhookRequest(
    createWebhookRequest({
      update_id: id,
      message: {
        message_id: 1,
        chat: { id: telegramId, type: "private" },
        from: { id: telegramId, is_bot: false, first_name: "Storefront Customer" },
        text: "/start",
      },
    }),
    {
      db: asAppDb(testDb!.db),
      transport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
      manualPaymentPrototypeEnabled: false,
    },
  );
  return { res, transport };
}

async function sendCallback(params: {
  telegramId: number;
  data: string;
  updateIdOverride?: number;
  transport?: FakeTelegramTransport;
  notificationTransport?: FakeTelegramTransport;
}): Promise<{ res: Response; transport: FakeTelegramTransport }> {
  const transport = params.transport ?? createFakeTelegramTransport();
  const id = params.updateIdOverride ?? nextUpdateId();
  const res = await handleTelegramWebhookRequest(
    createWebhookRequest({
      update_id: id,
      callback_query: {
        id: `cb_${id}`,
        from: {
          id: params.telegramId,
          is_bot: false,
          first_name: "Storefront Customer",
        },
        message: {
          message_id: 10,
          chat: { id: params.telegramId, type: "private" },
        },
        data: params.data,
      },
    }),
    {
      db: asAppDb(testDb!.db),
      transport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
      manualPaymentPrototypeEnabled: false,
      notificationTransport: params.notificationTransport,
    },
  );
  return { res, transport };
}

async function clearBusinessData(): Promise<void> {
  const db = testDb!.db;
  await db.delete(inquiryMessage);
  await db.delete(sellerNotificationDelivery);
  await db.delete(inquiry);
  await db.delete(telegramUpdate);
  await db.delete(customer);
  await db.delete(productActionTranslation);
  await db.delete(productAction);
  await db.delete(productTranslation);
  await db.delete(product);
  await db.delete(categoryTranslation);
  await db.delete(category).where(isNotNull(category.parentId));
  await db.delete(category);
  await db.update(botSetting).set({ storefrontMenu: null }).where(eq(botSetting.id, 1));
}

async function setStorefrontMenu(items: Array<{ key: string; enabled: boolean }>): Promise<void> {
  await testDb!.db
    .update(botSetting)
    .set({ storefrontMenu: { version: 1, items } })
    .where(eq(botSetting.id, 1));
}

async function seedCategory(params: {
  slug: string;
  parentId?: string | null;
  isActive?: boolean;
  deletedAt?: Date | null;
  names?: { en: string; ar: string };
}): Promise<string> {
  const db = testDb!.db;
  const [row] = await db
    .insert(category)
    .values({
      slug: params.slug,
      parentId: params.parentId ?? null,
      sortOrder: nextOrder(),
      isActive: params.isActive ?? true,
      deletedAt: params.deletedAt ?? null,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    {
      categoryId: row.id,
      languageId: enLangId,
      name: params.names?.en ?? `Category ${params.slug}`,
    },
    {
      categoryId: row.id,
      languageId: arLangId,
      name: params.names?.ar ?? `قسم ${params.slug}`,
    },
  ]);

  return row.id;
}

async function seedProduct(params: {
  categoryId: string;
  slug: string;
  isActive?: boolean;
  deletedAt?: Date | null;
  sortOrder?: number;
  names?: { en: string; ar: string };
}): Promise<string> {
  const db = testDb!.db;
  const [row] = await db
    .insert(product)
    .values({
      categoryId: params.categoryId,
      slug: params.slug,
      price: "19.95",
      isActive: params.isActive ?? true,
      deletedAt: params.deletedAt ?? null,
      sortOrder: params.sortOrder ?? nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: row.id,
      languageId: enLangId,
      name: params.names?.en ?? `Product ${params.slug}`,
      description: `Description ${params.slug}`,
    },
    {
      productId: row.id,
      languageId: arLangId,
      name: params.names?.ar ?? `منتج ${params.slug}`,
      description: `وصف ${params.slug}`,
    },
  ]);

  return row.id;
}

async function seedDetailsAction(params: {
  productId: string;
  enLabel: string;
  arLabel: string;
  details: string;
}): Promise<string> {
  const db = testDb!.db;
  const [row] = await db
    .insert(productAction)
    .values({
      productId: params.productId,
      actionType: "SHOW_DETAILS",
      sortOrder: 1,
      isActive: true,
    })
    .returning();

  await db.insert(productActionTranslation).values([
    {
      actionId: row.id,
      languageId: enLangId,
      label: params.enLabel,
    },
    {
      actionId: row.id,
      languageId: arLangId,
      label: params.arLabel,
    },
  ]);

  await db
    .update(productTranslation)
    .set({ details: params.details })
    .where(eq(productTranslation.productId, params.productId));

  return row.id;
}

function latestButtons(transport: FakeTelegramTransport) {
  const latest =
    transport.editedMessages[transport.editedMessages.length - 1] ??
    transport.sentMessages[transport.sentMessages.length - 1];
  return (latest?.replyMarkup?.inline_keyboard ?? []).flat();
}

function flatButtons(transport: FakeTelegramTransport): string[] {
  return latestButtons(transport).map(
    (button) => button.callback_data ?? button.url ?? "",
  );
}

async function enableSyntheticNotifications(): Promise<string> {
  const appDb = asAppDb(testDb!.db);
  const destinationChatId = "700123456";
  await saveSellerNotificationConfig(appDb, {
    destinationChatId,
    language: "en",
  });
  await recordVerificationSuccess(appDb, {
    botId: 9001001,
    botUsername: "storefront_synthetic_bot",
    destinationChatId,
  });
  await setSellerNotificationEnabled(appDb, true);
  return destinationChatId;
}

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("storefront_journey");

  const db = testDb.db;
  const [en] = await db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning();
  enLangId = en.id;

  const [ar] = await db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning();
  arLangId = ar.id;

  await db.insert(botSetting).values({
    id: 1,
    defaultLanguageId: enLangId,
    currency: "USD",
    displayName: "Default Storefront Store",
    askForLanguage: false,
  });

  const [template] = await db
    .insert(messageTemplate)
    .values({
      key: "bot_welcome",
      description: "Storefront welcome",
    })
    .returning();
  welcomeTemplateId = template.id;

  await db.insert(messageTranslation).values([
    {
      templateId: welcomeTemplateId,
      languageId: enLangId,
      body: "Configured welcome to {{store_name}}!",
    },
    {
      templateId: welcomeTemplateId,
      languageId: arLangId,
      body: "مرحباً بكم في {{store_name}}!",
    },
  ]);
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await clearBusinessData();
});

describe.skipIf(!shouldRun)("Default storefront experience", () => {
  it("renders the virtual default home after /start without creating an inquiry", async () => {
    const rootId = await seedCategory({ slug: "start-root" });
    const productId = await seedProduct({ categoryId: rootId, slug: "start-product" });
    const telegramId = nextTelegramId();

    const inquiriesBefore = await testDb!.db.select().from(inquiry);
    const productsBefore = await testDb!.db.select().from(product);
    const categoriesBefore = await testDb!.db.select().from(category);

    const { res, transport } = await sendStart(telegramId);

    expect(res.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0].text).toContain(
      "Configured welcome to Default Storefront Store!",
    );
    expect(flatButtons(transport)).toEqual(
      expect.arrayContaining([
        tokens.products(),
        tokens.storefrontCategories(),
        tokens.support(),
        tokens.languages(),
        tokens.myInquiries(),
      ]),
    );
    expect(latestButtons(transport).some((button) => button.text === "📨 My Active Inquiries")).toBe(
      true,
    );

    expect(await testDb!.db.select().from(inquiry)).toHaveLength(inquiriesBefore.length);
    expect(await testDb!.db.select().from(product)).toHaveLength(productsBefore.length);
    expect(await testDb!.db.select().from(category)).toHaveLength(categoriesBefore.length);
    expect(productId).toBeTruthy();

    const [savedCustomer] = await testDb!.db
      .select()
      .from(customer)
      .where(eq(customer.telegramId, telegramId));
    expect(savedCustomer).toBeDefined();
    expect(savedCustomer.selectedLanguageId).toBeNull();
  });

  it("renders zero products safely and hides the empty category entry point", async () => {
    await seedCategory({ slug: "empty-root" });
    const telegramId = nextTelegramId();

    const { res, transport } = await sendStart(telegramId);
    expect(res.status).toBe(200);
    expect(flatButtons(transport)).not.toContain(tokens.storefrontCategories());

    const browse = await sendCallback({
      telegramId,
      data: tokens.products(),
    });
    expect(browse.res.status).toBe(200);
    expect(browse.transport.editedMessages[0].text).toBe(
      "No products are available right now.",
    );
    expect(flatButtons(browse.transport)).toEqual([tokens.home()]);
    expect(await testDb!.db.select().from(inquiry)).toHaveLength(0);
  });

  it("browses one eligible product directly and preserves its existing action tree", async () => {
    const rootId = await seedCategory({ slug: "one-root" });
    const productId = await seedProduct({
      categoryId: rootId,
      slug: "one-product",
      names: { en: "Only Product", ar: "المنتج الوحيد" },
    });
    const detailsActionId = await seedDetailsAction({
      productId,
      enLabel: "Product details",
      arLabel: "تفاصيل المنتج",
      details: "Existing action details remain available.",
    });
    const telegramId = nextTelegramId();

    await sendStart(telegramId);

    const browse = await sendCallback({ telegramId, data: tokens.products() });
    expect(browse.res.status).toBe(200);
    expect(flatButtons(browse.transport)).toEqual([
      tokens.product(productId),
      tokens.home(),
    ]);

    const card = await sendCallback({
      telegramId,
      data: tokens.product(productId),
    });
    expect(card.transport.editedMessages[0].text).toContain("Only Product");
    expect(card.transport.editedMessages[0].text).toContain("19.95 USD");
    expect(flatButtons(card.transport)).toContain(tokens.action(detailsActionId));

    const details = await sendCallback({
      telegramId,
      data: tokens.action(detailsActionId),
    });
    expect(details.transport.editedMessages[0].text).toContain(
      "Existing action details remain available.",
    );
  });

  it("paginates more than ten products deterministically with safe stale pages", async () => {
    const rootId = await seedCategory({ slug: "paged-root" });
    for (let i = 1; i <= 12; i++) {
      await seedProduct({
        categoryId: rootId,
        slug: `paged-product-${String(i).padStart(2, "0")}`,
        sortOrder: i,
        names: {
          en: `Paged Product ${String(i).padStart(2, "0")}`,
          ar: `منتج صفحة ${String(i).padStart(2, "0")}`,
        },
      });
    }
    const telegramId = nextTelegramId();
    await sendStart(telegramId);

    const pageOne = await sendCallback({ telegramId, data: tokens.products() });
    expect(pageOne.res.status).toBe(200);
    expect(flatButtons(pageOne.transport).filter((value) => value.startsWith("p:"))).toHaveLength(10);
    expect(flatButtons(pageOne.transport)).toContain(tokens.products(2));

    const pageTwo = await sendCallback({ telegramId, data: tokens.products(2) });
    expect(pageTwo.res.status).toBe(200);
    const pageTwoProducts = flatButtons(pageTwo.transport).filter((value) =>
      value.startsWith("p:"),
    );
    expect(pageTwoProducts).toHaveLength(2);
    expect(flatButtons(pageTwo.transport)).toContain(tokens.products());

    const pageOneProducts = flatButtons(pageOne.transport).filter((value) =>
      value.startsWith("p:"),
    );
    const allProducts = [...pageOneProducts, ...pageTwoProducts];
    expect(new Set(allProducts).size).toBe(12);

    const stalePage = await sendCallback({ telegramId, data: tokens.products(99) });
    expect(stalePage.res.status).toBe(200);
    expect(flatButtons(stalePage.transport).filter((value) => value.startsWith("p:"))).toHaveLength(2);
    expect(flatButtons(stalePage.transport)).not.toContain(tokens.products(100));

    const firstProductId = pageOneProducts[0].slice(2);
    await testDb!.db
      .update(product)
      .set({ isActive: false })
      .where(eq(product.id, firstProductId));

    const staleProduct = await sendCallback({
      telegramId,
      data: tokens.product(firstProductId),
    });
    expect(staleProduct.res.status).toBe(200);
    expect(
      staleProduct.transport.editedMessages[staleProduct.transport.editedMessages.length - 1].text,
    ).toContain("This product is no longer available.");
  });

  it("excludes inactive, deleted, and hidden-by-ancestor catalog rows from direct browsing", async () => {
    const activeRoot = await seedCategory({ slug: "visible-root" });
    const visibleProduct = await seedProduct({
      categoryId: activeRoot,
      slug: "visible-product",
      names: { en: "Visible Product", ar: "منتج ظاهر" },
    });
    await seedProduct({ categoryId: activeRoot, slug: "inactive-product", isActive: false });
    await seedProduct({
      categoryId: activeRoot,
      slug: "deleted-product",
      deletedAt: new Date(),
    });

    const inactiveRoot = await seedCategory({ slug: "inactive-root", isActive: false });
    await seedProduct({ categoryId: inactiveRoot, slug: "under-inactive-root" });

    const deletedRoot = await seedCategory({
      slug: "deleted-root",
      deletedAt: new Date(),
    });
    await seedProduct({ categoryId: deletedRoot, slug: "under-deleted-root" });

    const hiddenRoot = await seedCategory({ slug: "hidden-root" });
    const hiddenMiddle = await seedCategory({
      slug: "hidden-middle",
      parentId: hiddenRoot,
      isActive: false,
    });
    const hiddenLeaf = await seedCategory({
      slug: "hidden-leaf",
      parentId: hiddenMiddle,
    });
    await seedProduct({ categoryId: hiddenLeaf, slug: "under-inactive-middle" });

    const telegramId = nextTelegramId();
    await sendStart(telegramId);
    const browse = await sendCallback({ telegramId, data: tokens.products() });
    const productButtons = flatButtons(browse.transport).filter((value) =>
      value.startsWith("p:"),
    );

    expect(productButtons).toEqual([tokens.product(visibleProduct)]);

    for (const button of productButtons) {
      const productId = button.slice(2);
      const guard = await isProductHierarchyActive(asAppDb(testDb!.db), productId);
      expect(guard.valid).toBe(true);
    }
  });

  it("accepts the allowed category-depth boundary in storefront and product-card eligibility", async () => {
    let parentAtBoundary: string | null = null;
    for (let i = 1; i <= 64; i++) {
      parentAtBoundary = await seedCategory({
        slug: `b-depth-boundary-${i}`,
        parentId: parentAtBoundary,
      });
    }
    const boundaryProduct = await seedProduct({
      categoryId: parentAtBoundary!,
      slug: "b-depth-boundary-product",
      names: { en: "Depth Boundary Product", ar: "منتج حد العمق" },
    });

    const telegramId = nextTelegramId();
    await sendStart(telegramId);
    const browse = await sendCallback({ telegramId, data: tokens.products() });
    const productButtons = flatButtons(browse.transport).filter((value) =>
      value.startsWith("p:"),
    );

    expect(productButtons).toEqual([tokens.product(boundaryProduct)]);
    expect(
      (await isProductHierarchyActive(asAppDb(testDb!.db), boundaryProduct)).valid,
    ).toBe(true);
  });

  it("filters empty roots and nested branches from storefront discovery while preserving legacy callbacks", async () => {
    const emptyRoot = await seedCategory({
      slug: "b-empty-root",
      names: { en: "Empty Root", ar: "قسم فارغ" },
    });
    const populatedRoot = await seedCategory({
      slug: "b-populated-root",
      names: { en: "Populated Root", ar: "قسم ممتلئ" },
    });
    const populatedChild = await seedCategory({
      slug: "b-populated-child",
      parentId: populatedRoot,
      names: { en: "Populated Child", ar: "فرع ممتلئ" },
    });
    const emptySibling = await seedCategory({
      slug: "b-empty-sibling",
      parentId: populatedRoot,
      names: { en: "Empty Sibling", ar: "فرع فارغ" },
    });
    const populatedLeaf = await seedCategory({
      slug: "b-populated-leaf",
      parentId: populatedChild,
      names: { en: "Populated Leaf", ar: "ورقة ممتلئة" },
    });
    const leafProduct = await seedProduct({
      categoryId: populatedLeaf,
      slug: "b-leaf-product",
    });

    const inactiveOnlyRoot = await seedCategory({ slug: "b-inactive-only-root" });
    await seedProduct({
      categoryId: inactiveOnlyRoot,
      slug: "b-inactive-only-product",
      isActive: false,
    });
    const deletedOnlyRoot = await seedCategory({ slug: "b-deleted-only-root" });
    await seedProduct({
      categoryId: deletedOnlyRoot,
      slug: "b-deleted-only-product",
      deletedAt: new Date(),
    });
    const hiddenRoot = await seedCategory({ slug: "b-hidden-root" });
    const hiddenMiddle = await seedCategory({
      slug: "b-hidden-middle",
      parentId: hiddenRoot,
      isActive: false,
    });
    const hiddenLeaf = await seedCategory({
      slug: "b-hidden-leaf",
      parentId: hiddenMiddle,
    });
    await seedProduct({ categoryId: hiddenLeaf, slug: "b-hidden-product" });

    const telegramId = nextTelegramId();
    await sendStart(telegramId);

    const storefrontRoots = await sendCallback({
      telegramId,
      data: tokens.storefrontCategories(),
    });
    const rootCallbacks = flatButtons(storefrontRoots.transport).filter((value) =>
      value.startsWith("sc:"),
    );
    expect(rootCallbacks).toEqual([tokens.storefrontCategory(populatedRoot)]);
    expect(rootCallbacks).not.toContain(tokens.storefrontCategory(emptyRoot));
    expect(rootCallbacks).not.toContain(tokens.storefrontCategory(inactiveOnlyRoot));
    expect(rootCallbacks).not.toContain(tokens.storefrontCategory(deletedOnlyRoot));
    expect(rootCallbacks).not.toContain(tokens.storefrontCategory(hiddenRoot));

    const staleEmpty = await sendCallback({
      telegramId,
      data: tokens.storefrontCategory(emptyRoot),
    });
    expect(staleEmpty.res.status).toBe(200);
    expect(staleEmpty.transport.editedMessages[0].text).toContain(
      "This category is no longer available.",
    );

    const rootView = await sendCallback({
      telegramId,
      data: tokens.storefrontCategory(populatedRoot),
    });
    const childCallbacks = flatButtons(rootView.transport).filter((value) =>
      value.startsWith("sc:"),
    );
    expect(childCallbacks).toEqual([tokens.storefrontCategory(populatedChild)]);
    expect(childCallbacks).not.toContain(tokens.storefrontCategory(emptySibling));

    const childView = await sendCallback({
      telegramId,
      data: tokens.storefrontCategory(populatedChild),
    });
    expect(flatButtons(childView.transport)).toEqual([
      tokens.storefrontCategory(populatedLeaf),
      tokens.storefrontCategory(populatedRoot),
      tokens.home(),
    ]);

    const leafView = await sendCallback({
      telegramId,
      data: tokens.storefrontCategory(populatedLeaf),
    });
    expect(flatButtons(leafView.transport)).toContain(tokens.product(leafProduct));

    const legacyRoots = await sendCallback({ telegramId, data: tokens.rootCategory() });
    const legacyCallbacks = flatButtons(legacyRoots.transport);
    expect(legacyCallbacks).toContain(tokens.category(emptyRoot));
    expect(legacyCallbacks).toContain(tokens.category(inactiveOnlyRoot));
    expect(legacyCallbacks).toContain(tokens.category(hiddenRoot));

    const legacyEmptyView = await sendCallback({
      telegramId,
      data: tokens.category(emptyRoot),
    });
    expect(legacyEmptyView.res.status).toBe(200);
    expect(legacyEmptyView.transport.editedMessages[0].text).toContain("Empty Root");

    const legacyEmptySibling = await sendCallback({
      telegramId,
      data: tokens.category(emptySibling),
    });
    expect(legacyEmptySibling.res.status).toBe(200);
    expect(legacyEmptySibling.transport.editedMessages[0].text).toContain(
      "Empty Sibling",
    );
  });

  it("preserves configured ordering and pagination after filtering empty roots", async () => {
    const populatedIds: string[] = [];
    for (let i = 1; i <= 12; i++) {
      await seedCategory({ slug: `b-order-empty-before-${i}` });
      const rootId = await seedCategory({
        slug: `b-order-populated-${i}`,
        names: { en: `Ordered Root ${i}`, ar: `قسم مرتب ${i}` },
      });
      await seedProduct({
        categoryId: rootId,
        slug: `b-order-product-${i}`,
        sortOrder: i,
      });
      populatedIds.push(rootId);
      await seedCategory({ slug: `b-order-empty-after-${i}` });
    }

    const telegramId = nextTelegramId();
    await sendStart(telegramId);

    const pageOne = await sendCallback({
      telegramId,
      data: tokens.storefrontCategories(),
    });
    const pageOneCallbacks = flatButtons(pageOne.transport).filter((value) =>
      value.startsWith("sc:"),
    );
    expect(pageOneCallbacks).toEqual(
      populatedIds.slice(0, 10).map((id) => tokens.storefrontCategory(id)),
    );
    expect(flatButtons(pageOne.transport)).toContain(
      tokens.storefrontCategories(2),
    );

    const pageTwo = await sendCallback({
      telegramId,
      data: tokens.storefrontCategories(2),
    });
    const pageTwoCallbacks = flatButtons(pageTwo.transport).filter((value) =>
      value.startsWith("sc:"),
    );
    expect(pageTwoCallbacks).toEqual(
      populatedIds.slice(10).map((id) => tokens.storefrontCategory(id)),
    );
    expect(flatButtons(pageTwo.transport)).toContain(
      tokens.storefrontCategories(),
    );
    expect(new Set([...pageOneCallbacks, ...pageTwoCallbacks]).size).toBe(12);
  });

  it("creates one explicit support inquiry and reuses it without duplicate notifications", async () => {
    const destinationChatId = await enableSyntheticNotifications();
    const telegramId = nextTelegramId();
    const notificationTransport = createFakeTelegramTransport();

    try {
      await sendStart(telegramId);
      expect(await testDb!.db.select().from(inquiry)).toHaveLength(0);

      const supportUpdateId = nextUpdateId();
      const support = await sendCallback({
        telegramId,
        data: tokens.support(),
        updateIdOverride: supportUpdateId,
        notificationTransport,
      });
      expect(support.res.status).toBe(200);
      expect(support.transport.editedMessages[0].text).toContain(
        "Thank you for contacting Default Storefront Store support.",
      );

      const inquiries = await testDb!.db.select().from(inquiry);
      expect(inquiries).toHaveLength(1);
      expect(inquiries[0].productId).toBeNull();
      expect(inquiries[0].category).toBeNull();

      const deliveries = await testDb!.db
        .select()
        .from(sellerNotificationDelivery)
        .where(eq(sellerNotificationDelivery.inquiryId, inquiries[0].id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].destinationChatId).toBe(destinationChatId);
      expect(deliveries[0].status).toBe("sent");
      expect(notificationTransport.sentMessages).toHaveLength(1);

      const replay = await sendCallback({
        telegramId,
        data: tokens.support(),
        updateIdOverride: supportUpdateId,
        notificationTransport,
      });
      expect(await replay.res.json()).toEqual({ ok: true, status: "already_processed" });
      expect(await testDb!.db.select().from(inquiry)).toHaveLength(1);
      expect(notificationTransport.sentMessages).toHaveLength(1);

      const resume = await sendCallback({
        telegramId,
        data: tokens.support(),
        notificationTransport,
      });
      expect(resume.res.status).toBe(200);
      expect(resume.transport.editedMessages[0].text).toContain(inquiries[0].reference);
      expect(await testDb!.db.select().from(inquiry)).toHaveLength(1);
      expect(
        await testDb!.db
          .select()
          .from(sellerNotificationDelivery)
          .where(eq(sellerNotificationDelivery.inquiryId, inquiries[0].id)),
      ).toHaveLength(1);
      expect(notificationTransport.sentMessages).toHaveLength(1);
    } finally {
      await setSellerNotificationEnabled(asAppDb(testDb!.db), false);
    }
  });

  it("changes language only when multiple languages are enabled and rejects stale language callbacks", async () => {
    const rootId = await seedCategory({ slug: "language-root" });
    await seedProduct({ categoryId: rootId, slug: "language-product" });
    const telegramId = nextTelegramId();

    const start = await sendStart(telegramId);
    expect(flatButtons(start.transport)).toContain(tokens.languages());

    const menu = await sendCallback({ telegramId, data: tokens.languages() });
    expect(flatButtons(menu.transport)).toEqual([
      tokens.lang("en"),
      tokens.lang("ar"),
      tokens.home(),
    ]);

    const unchangedHome = await sendCallback({ telegramId, data: tokens.home() });
    expect(unchangedHome.res.status).toBe(200);
    const [afterHome] = await testDb!.db
      .select()
      .from(customer)
      .where(eq(customer.telegramId, telegramId));
    expect(afterHome.selectedLanguageId).toBeNull();

    await testDb!.db
      .update(language)
      .set({ isEnabled: false })
      .where(eq(language.id, arLangId));

    try {
      const stale = await sendCallback({ telegramId, data: tokens.lang("ar") });
      expect(stale.res.status).toBe(200);
      expect(stale.transport.editedMessages[0].text).toContain(
        "Configured welcome to Default Storefront Store!",
      );
      const [afterStale] = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, telegramId));
      expect(afterStale.selectedLanguageId).toBeNull();

      const singleLanguageStart = await sendStart(nextTelegramId());
      expect(flatButtons(singleLanguageStart.transport)).not.toContain(
        tokens.languages(),
      );
    } finally {
      await testDb!.db
        .update(language)
        .set({ isEnabled: true })
        .where(eq(language.id, arLangId));
    }

    const arabic = await sendCallback({ telegramId, data: tokens.lang("ar") });
    expect(arabic.res.status).toBe(200);
    expect(arabic.transport.editedMessages[0].text).toContain(
      "مرحباً بكم في Default Storefront Store!",
    );
    expect(flatButtons(arabic.transport)).toEqual(
      expect.arrayContaining([
        "prods",
        "scats",
        "support",
        "langs",
        "myinq",
      ]),
    );

    const [afterArabic] = await testDb!.db
      .select()
      .from(customer)
      .where(eq(customer.telegramId, telegramId));
    expect(afterArabic.selectedLanguageId).toBe(arLangId);

    const english = await sendCallback({ telegramId, data: tokens.lang("en") });
    expect(english.res.status).toBe(200);
    expect(english.transport.editedMessages[0].text).toContain(
      "Configured welcome to Default Storefront Store!",
    );
    const [afterEnglish] = await testDb!.db
      .select()
      .from(customer)
      .where(eq(customer.telegramId, telegramId));
    expect(afterEnglish.selectedLanguageId).toBe(enLangId);
  });

  it("shows only the current customer's active inquiries and never writes on view", async () => {
    const telegramIdA = nextTelegramId();
    const telegramIdB = nextTelegramId();

    await sendStart(telegramIdA);
    const support = await sendCallback({ telegramId: telegramIdA, data: tokens.support() });
    expect(support.res.status).toBe(200);
    const [inquiryA] = await testDb!.db.select().from(inquiry);
    expect(inquiryA).toBeDefined();

    await sendStart(telegramIdB);
    const customerStart = await sendStart(telegramIdB);
    expect(customerStart.res.status).toBe(200);

    const inquiriesBefore = await testDb!.db.select().from(inquiry);
    const customerBView = await sendCallback({
      telegramId: telegramIdB,
      data: tokens.myInquiries(),
    });
    expect(customerBView.res.status).toBe(200);
    expect(customerBView.transport.editedMessages[0].text).toBe(
      "You have no active inquiries.",
    );
    expect(customerBView.transport.editedMessages[0].text).not.toContain(
      inquiryA.reference,
    );
    expect(await testDb!.db.select().from(inquiry)).toHaveLength(inquiriesBefore.length);

    const customerAView = await sendCallback({
      telegramId: telegramIdA,
      data: tokens.myInquiries(),
    });
    expect(customerAView.transport.editedMessages[0].text).toContain(inquiryA.reference);
    expect(await testDb!.db.select().from(inquiry)).toHaveLength(inquiriesBefore.length);
  });

  it("honors saved menu order and hides disabled entries without breaking their callbacks", async () => {
    const rootId = await seedCategory({ slug: "configured-root" });
    await seedProduct({ categoryId: rootId, slug: "configured-product" });

    await setStorefrontMenu([
      { key: "support", enabled: true },
      { key: "inquiries", enabled: true },
      { key: "products", enabled: false },
      { key: "categories", enabled: true },
      { key: "languages", enabled: true },
    ]);

    const telegramId = nextTelegramId();
    const start = await sendStart(telegramId);

    expect(start.res.status).toBe(200);
    expect(flatButtons(start.transport)).toEqual([
      tokens.support(),
      tokens.myInquiries(),
      tokens.storefrontCategories(),
      tokens.languages(),
    ]);
    expect(flatButtons(start.transport)).not.toContain(tokens.products());
    expect(await testDb!.db.select().from(inquiry)).toHaveLength(0);

    const hiddenProductsCallback = await sendCallback({
      telegramId,
      data: tokens.products(),
    });
    expect(hiddenProductsCallback.res.status).toBe(200);
    expect(hiddenProductsCallback.transport.editedMessages[0].text).toBe(
      "🛍 Browse Products",
    );
    expect(flatButtons(hiddenProductsCallback.transport)).toContain(
      tokens.product(
        (
          await testDb!.db
            .select({ id: product.id })
            .from(product)
            .where(eq(product.slug, "configured-product"))
        )[0].id,
      ),
    );
  });

  it("applies contextual eligibility after configuration and keeps a safe support fallback", async () => {
    await testDb!.db
      .update(language)
      .set({ isEnabled: false })
      .where(eq(language.id, arLangId));

    try {
      await setStorefrontMenu([
        { key: "categories", enabled: true },
        { key: "languages", enabled: true },
        { key: "products", enabled: false },
        { key: "support", enabled: false },
        { key: "inquiries", enabled: false },
      ]);

      const start = await sendStart(nextTelegramId());

      expect(start.res.status).toBe(200);
      expect(flatButtons(start.transport)).toEqual([tokens.support()]);
      expect(await testDb!.db.select().from(inquiry)).toHaveLength(0);
    } finally {
      await testDb!.db
        .update(language)
        .set({ isEnabled: true })
        .where(eq(language.id, arLangId));
    }
  });

  it("falls back to the default menu when the stored configuration is malformed", async () => {
    const rootId = await seedCategory({ slug: "malformed-root" });
    await seedProduct({ categoryId: rootId, slug: "malformed-product" });

    await testDb!.db
      .update(botSetting)
      .set({ storefrontMenu: { unexpected: true } })
      .where(eq(botSetting.id, 1));

    const start = await sendStart(nextTelegramId());

    expect(start.res.status).toBe(200);
    expect(flatButtons(start.transport)).toEqual([
      tokens.products(),
      tokens.storefrontCategories(),
      tokens.support(),
      tokens.languages(),
      tokens.myInquiries(),
    ]);
    expect(await testDb!.db.select().from(inquiry)).toHaveLength(0);
  });

  it("bounds a long localized welcome into valid Telegram chunks with the menu on the final chunk", async () => {
    const rootId = await seedCategory({ slug: "long-welcome-root" });
    await seedProduct({ categoryId: rootId, slug: "long-welcome-product" });
    const tailSignature = "LONG_WELCOME_TAIL_998877";
    const head = "Welcome to {{store_name}}!\n\n";
    const tail = `\n\nFinal line: ${tailSignature}`;
    const filler = "Long localized welcome text. ";
    const bodyPrefix =
      head +
      filler.repeat(
        Math.floor((4096 - head.length - tail.length) / filler.length),
      );
    const longWelcome = bodyPrefix + "x".repeat(4096 - bodyPrefix.length - tail.length) + tail;
    expect(longWelcome.length).toBe(4096);

    await testDb!.db
      .update(messageTranslation)
      .set({ body: longWelcome })
      .where(
        and(
          eq(messageTranslation.templateId, welcomeTemplateId),
          eq(messageTranslation.languageId, enLangId),
        ),
      );

    try {
      const { res, transport } = await sendStart(nextTelegramId());
      expect(res.status).toBe(200);
      expect(transport.sentMessages.length).toBeGreaterThan(1);

      for (const message of transport.sentMessages) {
        expect(message.text.length).toBeLessThanOrEqual(4096);
      }

      const recombined = transport.sentMessages.map((message) => message.text).join("");
      expect(recombined).toContain(tailSignature);

      for (let i = 0; i < transport.sentMessages.length - 1; i++) {
        expect(transport.sentMessages[i].replyMarkup).toBeUndefined();
      }
      expect(
        transport.sentMessages[transport.sentMessages.length - 1].replyMarkup,
      ).toBeDefined();
    } finally {
      await testDb!.db
        .update(messageTranslation)
        .set({ body: "Configured welcome to {{store_name}}!" })
        .where(
          and(
            eq(messageTranslation.templateId, welcomeTemplateId),
            eq(messageTranslation.languageId, enLangId),
          ),
        );
    }
  });
});
