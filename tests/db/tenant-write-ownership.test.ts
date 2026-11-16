import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import {
  botSetting,
  category,
  customer,
  language,
  messageTemplate,
  paymentMethod,
  product,
  sellerNotificationDelivery,
  sellerNotificationSetting,
  store,
  telegramUpdate,
} from "@/db/schema";
import {
  appendInboundCustomerMessage,
  claimTelegramUpdate,
  createCatalogCategory,
  createCatalogProduct,
  createOrResumeProductInquiry,
  createPaymentMethod,
  createTemplate,
  editCatalogCategory,
  editCatalogProduct,
  editPaymentMethod,
  initializeSettings,
  listCatalogCategories,
  listCatalogProducts,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
  assertOwnershipCompatible,
  isOwnershipCompatible,
  resolveLegacyStoreContext,
  resolveLegacyStoreIdForWrite,
  saveSellerNotificationConfig,
  saveTranslation,
  updateCatalogCategory,
  updateCatalogProduct,
  updateSettings,
  updateTemplate,
  upsertCustomer,
} from "@/lib/data";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const backfillFile = path.resolve(
  import.meta.dirname,
  "../../docs/backfill/legacy-store-backfill.sql",
);
const verificationFile = path.resolve(
  import.meta.dirname,
  "../../docs/backfill/legacy-store-verification.sql",
);

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("tenant_write_ownership");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`
    truncate table
      "seller_notification_delivery",
      "inquiry_message",
      "seller_notification_setting",
      "inquiry",
      "customer",
      "product_action_translation",
      "product_action",
      "product_translation",
      "product",
      "category_translation",
      "category",
      "payment_method_translation",
      "payment_method",
      "message_translation",
      "message_template",
      "telegram_update",
      "bot_setting",
      "language",
      "store_membership",
      "app_user",
      "store"
    restart identity cascade
  `);
});

function appDb() {
  return asAppDb(testDb!.db);
}

async function seedLanguage() {
  const [row] = await testDb!.db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  return row;
}

async function seedLegacyStore() {
  const [row] = await testDb!.db
    .insert(store)
    .values({
      name: "Rabet Legacy Store",
      slug: "legacy-store",
      status: "active",
    })
    .returning();
  return row;
}

async function seedSettings() {
  await seedLanguage();
  return initializeSettings(appDb(), {
    defaultLanguageCode: "en",
    currency: "USD",
    displayName: "Rabet Store",
  });
}

async function rowStoreId(
  table: string,
  idColumn: string,
  id: string | number,
): Promise<string | null> {
  const idValue = typeof id === "number" ? sql`${id}::int` : sql`${id}::uuid`;
  const rows = await testDb!.db.execute<{ store_id: string | null }>(sql`
    select "store_id" from ${sql.identifier(table)}
    where ${sql.identifier(idColumn)} = ${idValue}
  `);
  return rows[0]?.store_id ?? null;
}

async function runBackfill() {
  const sqlText = readFileSync(backfillFile, "utf8");
  await testDb!.db.execute(sql.raw(sqlText));
}

async function verificationAssertions() {
  const sqlText = readFileSync(verificationFile, "utf8");
  return testDb!.db.execute<{ kind: string; ok: boolean | null }>(
    sql.raw(sqlText),
  );
}

describe.skipIf(!shouldRun)("S1.3-A trusted legacy store context", () => {
  it("reports an explicit missing state without creating anything", async () => {
    const context = await resolveLegacyStoreContext(appDb());
    expect(context).toEqual({ status: "missing", storeId: null });
    expect(await resolveLegacyStoreIdForWrite(appDb())).toBeNull();

    const rows = await testDb!.db.execute<{ count: number }>(
      sql`select count(*)::int as count from "store"`,
    );
    expect(rows[0].count).toBe(0);
  });

  it("resolves exactly the approved legacy identity", async () => {
    const legacy = await seedLegacyStore();

    const context = await resolveLegacyStoreContext(appDb());
    expect(context.status).toBe("resolved");
    expect(context.storeId).toBe(legacy.id);
    expect(await resolveLegacyStoreIdForWrite(appDb())).toBe(legacy.id);
  });

  it("fails closed on a wrong name, slug or status", async () => {
    for (const identity of [
      { name: "Wrong Name", slug: "legacy-store", status: "active" },
      { name: "Rabet Legacy Store", slug: "wrong-slug", status: "active" },
      { name: "Rabet Legacy Store", slug: "legacy-store", status: "onboarding" },
    ]) {
      await testDb!.db.execute(sql`truncate table "store" cascade`);
      await testDb!.db.insert(store).values(identity);

      await expect(resolveLegacyStoreContext(appDb())).rejects.toMatchObject({
        code: "TENANT_CONTEXT_INVALID",
      });
      await expect(resolveLegacyStoreIdForWrite(appDb())).rejects.toMatchObject({
        code: "TENANT_CONTEXT_INVALID",
      });
    }
  });

  it("fails closed when another store exists", async () => {
    await seedLegacyStore();
    await testDb!.db.insert(store).values({
      name: "Other Store",
      slug: "other-store",
      status: "active",
    });

    await expect(resolveLegacyStoreContext(appDb())).rejects.toMatchObject({
      code: "TENANT_CONTEXT_INVALID",
    });
  });

  it("rejects two different non-null owners while tolerating historical NULL", () => {
    const first = randomUUID();
    const second = randomUUID();

    expect(isOwnershipCompatible(null, first)).toBe(true);
    expect(isOwnershipCompatible(first, null)).toBe(true);
    expect(isOwnershipCompatible(first, first)).toBe(true);
    expect(isOwnershipCompatible(first, second)).toBe(false);
    expect(() =>
      assertOwnershipCompatible(first, second, "different stores"),
    ).toThrowError(
      expect.objectContaining({ code: "CROSS_STORE_REFERENCE" }),
    );
  });

  it("performs no network request while resolving ownership", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await resolveLegacyStoreContext(appDb());
      await seedLegacyStore();
      await resolveLegacyStoreIdForWrite(appDb());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe.skipIf(!shouldRun)("S1.3-A ownership stamps for the eight roots", () => {
  it("stamps every new store-owned root when the legacy store exists", async () => {
    const legacy = await seedLegacyStore();
    await seedSettings();

    const createdCategory = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "electronics",
      translations: [{ languageId: (await seedLanguageId()), name: "Electronics" }],
    });
    const createdProduct = await createCatalogProduct(appDb(), {
      categoryId: createdCategory.categoryId,
      slug: "phone",
      price: "10.00",
      translations: [{ languageId: (await seedLanguageId()), name: "Phone" }],
    });
    const createdMethod = await createPaymentMethod(appDb(), {
      adminLabel: "Cash",
      translations: [{ languageCode: "en", title: "Cash" }],
    });
    const createdTemplate = await createTemplate(appDb(), {
      key: "welcome",
      description: "Welcome",
    });
    const createdCustomer = await upsertCustomer(appDb(), {
      telegramId: 111222333,
      firstName: "Customer",
    });
    const createdSetting = await saveSellerNotificationConfig(appDb(), {
      destinationChatId: "123456789",
      language: "en",
    });
    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900001,
      updateType: "message",
      payload: { message: { message_id: 1 } },
    });

    expect(claimed.status).toBe("claimed");

    expect(await rowStoreId("bot_setting", "id", 1)).toBe(legacy.id);
    expect(await rowStoreId("category", "id", createdCategory.categoryId)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("product", "id", createdProduct.productId)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("payment_method", "id", createdMethod.methodId)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("message_template", "id", createdTemplate.id)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("customer", "id", createdCustomer.id)).toBe(legacy.id);
    expect(await rowStoreId("seller_notification_setting", "id", 1)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("telegram_update", "id", claimed.row.id)).toBe(
      legacy.id,
    );
    expect(createdSetting.storeId).toBe(legacy.id);
    expect(createdCustomer.storeId).toBe(legacy.id);
  });

  it("keeps nullable compatibility for every root while no store exists", async () => {
    await seedSettings();

    const createdCategory = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "unowned-category",
      translations: [{ languageId: (await seedLanguageId()), name: "Unowned" }],
    });
    const createdProduct = await createCatalogProduct(appDb(), {
      categoryId: createdCategory.categoryId,
      slug: "unowned-product",
      price: "5.00",
      translations: [{ languageId: (await seedLanguageId()), name: "Product" }],
    });
    const createdMethod = await createPaymentMethod(appDb(), {
      adminLabel: "Unowned method",
      translations: [{ languageCode: "en", title: "Unowned method" }],
    });
    const createdTemplate = await createTemplate(appDb(), {
      key: "unowned_template",
    });
    const createdCustomer = await upsertCustomer(appDb(), {
      telegramId: 444555666,
    });
    const createdSetting = await saveSellerNotificationConfig(appDb(), {
      destinationChatId: "123456789",
    });
    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900002,
      updateType: "message",
      payload: { message: { message_id: 2 } },
    });

    expect(await rowStoreId("category", "id", createdCategory.categoryId)).toBeNull();
    expect(await rowStoreId("product", "id", createdProduct.productId)).toBeNull();
    expect(await rowStoreId("payment_method", "id", createdMethod.methodId)).toBeNull();
    expect(await rowStoreId("message_template", "id", createdTemplate.id)).toBeNull();
    expect(createdCustomer.storeId).toBeNull();
    expect(createdSetting.storeId).toBeNull();
    expect(claimed.status).toBe("claimed");
    expect(claimed.row.storeId).toBeNull();
    expect(await rowStoreId("bot_setting", "id", 1)).toBeNull();
  });
});

async function seedLanguageId(): Promise<string> {
  const [row] = await testDb!.db
    .select({ id: language.id })
    .from(language)
    .where(eq(language.code, "en"))
    .limit(1);
  return row.id;
}

describe.skipIf(!shouldRun)("S1.3-A ownership immutability", () => {
  it("preserves ownership across every update path", async () => {
    const legacy = await seedLegacyStore();
    await seedSettings();
    const langId = await seedLanguageId();

    const updatedSettings = await updateSettings(appDb(), {
      displayName: "Renamed Store",
    });
    expect(updatedSettings.storeId).toBe(legacy.id);

    const createdCategory = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "owned-category",
      translations: [{ languageId: langId, name: "Owned" }],
    });
    await editCatalogCategory(appDb(), {
      categoryId: createdCategory.categoryId,
      slug: "owned-category-renamed",
      isActive: false,
    });
    expect(await rowStoreId("category", "id", createdCategory.categoryId)).toBe(
      legacy.id,
    );

    const createdProduct = await createCatalogProduct(appDb(), {
      categoryId: createdCategory.categoryId,
      slug: "owned-product",
      price: "10.00",
      translations: [{ languageId: langId, name: "Product" }],
    });
    await editCatalogProduct(appDb(), {
      productId: createdProduct.productId,
      slug: "owned-product-renamed",
      price: "11.00",
      isActive: false,
    });
    expect(await rowStoreId("product", "id", createdProduct.productId)).toBe(
      legacy.id,
    );

    const createdMethod = await createPaymentMethod(appDb(), {
      adminLabel: "Cash",
      translations: [{ languageCode: "en", title: "Cash" }],
    });
    await editPaymentMethod(appDb(), {
      id: createdMethod.methodId,
      adminLabel: "Cash on delivery",
    });
    expect(await rowStoreId("payment_method", "id", createdMethod.methodId)).toBe(
      legacy.id,
    );

    const createdTemplate = await createTemplate(appDb(), { key: "owned_tpl" });
    await updateTemplate(appDb(), {
      key: "owned_tpl",
      description: "Updated",
    });
    await saveTranslation(appDb(), {
      templateKey: "owned_tpl",
      languageCode: "en",
      body: "Hello",
    });
    expect(await rowStoreId("message_template", "id", createdTemplate.id)).toBe(
      legacy.id,
    );

    const createdCustomer = await upsertCustomer(appDb(), {
      telegramId: 777888999,
      firstName: "First",
    });
    const updatedCustomer = await upsertCustomer(appDb(), {
      telegramId: 777888999,
      firstName: "Second",
    });
    expect(updatedCustomer.storeId).toBe(legacy.id);
    expect(updatedCustomer.id).toBe(createdCustomer.id);

    await saveSellerNotificationConfig(appDb(), {
      destinationChatId: "123456789",
      language: "en",
    });
    await saveSellerNotificationConfig(appDb(), { language: "ar" });
    expect(await rowStoreId("seller_notification_setting", "id", 1)).toBe(
      legacy.id,
    );

    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900003,
      updateType: "message",
      payload: { message: { message_id: 3 } },
    });
    expect(claimed.status).toBe("claimed");
    await markTelegramUpdateFailed(appDb(), {
      updateId: 900003,
      attemptId: claimed.attemptId,
      errorMessage: "transient",
    });
    const reclaimed = await claimTelegramUpdate(appDb(), {
      updateId: 900003,
      updateType: "message",
    });
    expect(reclaimed.status).toBe("claimed");
    expect(reclaimed.row.storeId).toBe(legacy.id);

    await markTelegramUpdateProcessed(appDb(), {
      updateId: 900003,
      attemptId: reclaimed.attemptId,
    });
    const processed = await claimTelegramUpdate(appDb(), {
      updateId: 900003,
      updateType: "message",
    });
    expect(processed.status).toBe("already_processed");
    expect(processed.row.storeId).toBe(legacy.id);
  });

  it("does not backfill historical NULL ownership through runtime updates", async () => {
    await seedLegacyStore();
    const lang = await seedLanguage();
    const db = testDb!.db;

    await db.insert(botSetting).values({
      defaultLanguageId: lang.id,
      currency: "USD",
      displayName: "Historical Settings",
    });
    const [historicalCategory] = await db
      .insert(category)
      .values({ slug: "historical-category", sortOrder: 1 })
      .returning();
    const [historicalProduct] = await db
      .insert(product)
      .values({
        categoryId: historicalCategory.id,
        slug: "historical-product",
        price: "1.00",
        sortOrder: 1,
      })
      .returning();
    const [historicalMethod] = await db
      .insert(paymentMethod)
      .values({ adminLabel: "Historical Cash" })
      .returning();
    const [historicalTemplate] = await db
      .insert(messageTemplate)
      .values({ key: "historical_template" })
      .returning();
    const [historicalCustomer] = await db
      .insert(customer)
      .values({ telegramId: 123123123 })
      .returning();
    await db.insert(sellerNotificationSetting).values({ id: 1 });
    const [historicalUpdate] = await db
      .insert(telegramUpdate)
      .values({ updateId: 900004, updateType: "message" })
      .returning();

    await updateSettings(appDb(), { displayName: "Still Historical" });
    await updateCatalogCategory(appDb(), historicalCategory.id, {
      slug: "historical-category-renamed",
    });
    await updateCatalogProduct(appDb(), historicalProduct.id, { price: "2.00" });
    await editPaymentMethod(appDb(), {
      id: historicalMethod.id,
      adminLabel: "Historical Cash Updated",
    });
    await updateTemplate(appDb(), {
      key: "historical_template",
      description: "Updated",
    });
    await upsertCustomer(appDb(), {
      telegramId: historicalCustomer.telegramId,
      firstName: "Updated",
    });
    await saveSellerNotificationConfig(appDb(), { language: "en" });
    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900004,
      updateType: "message",
    });

    expect(claimed.status).toBe("claimed");
    expect(claimed.row.id).toBe(historicalUpdate.id);
    expect(await rowStoreId("bot_setting", "id", 1)).toBeNull();
    expect(await rowStoreId("category", "id", historicalCategory.id)).toBeNull();
    expect(await rowStoreId("product", "id", historicalProduct.id)).toBeNull();
    expect(await rowStoreId("payment_method", "id", historicalMethod.id)).toBeNull();
    expect(await rowStoreId("message_template", "id", historicalTemplate.id)).toBeNull();
    expect(await rowStoreId("customer", "id", historicalCustomer.id)).toBeNull();
    expect(await rowStoreId("seller_notification_setting", "id", 1)).toBeNull();
    expect(await rowStoreId("telegram_update", "id", historicalUpdate.id)).toBeNull();
  });
});

describe.skipIf(!shouldRun)("S1.3-A catalog and inquiry ownership relationships", () => {
  it("keeps product and category ownership consistent across transitions", async () => {
    const legacy = await seedLegacyStore();
    await seedSettings();
    const langId = await seedLanguageId();

    const root = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "root",
      translations: [{ languageId: langId, name: "Root" }],
    });
    const child = await createCatalogCategory(appDb(), {
      parentId: root.categoryId,
      slug: "child",
      translations: [{ languageId: langId, name: "Child" }],
    });
    const created = await createCatalogProduct(appDb(), {
      categoryId: child.categoryId,
      slug: "product",
      price: "9.00",
      translations: [{ languageId: langId, name: "Product" }],
    });

    expect(await rowStoreId("product", "id", created.productId)).toBe(legacy.id);
    expect(await rowStoreId("category", "id", child.categoryId)).toBe(legacy.id);

    const [historicalCategory] = await testDb!.db
      .insert(category)
      .values({ slug: "historical-root", sortOrder: 10 })
      .returning();
    const underHistorical = await createCatalogProduct(appDb(), {
      categoryId: historicalCategory.id,
      slug: "transitional-product",
      price: "3.00",
      translations: [{ languageId: langId, name: "Transitional" }],
    });
    expect(await rowStoreId("product", "id", underHistorical.productId)).toBe(
      legacy.id,
    );

    await editCatalogProduct(appDb(), {
      productId: underHistorical.productId,
      categoryId: child.categoryId,
      slug: "transitional-product",
      price: "3.00",
      isActive: false,
    });
    expect(await rowStoreId("product", "id", underHistorical.productId)).toBe(
      legacy.id,
    );

    await testDb!.db.insert(store).values({
      name: "Other Store",
      slug: "other-store",
      status: "active",
    });

    await expect(
      createCatalogProduct(appDb(), {
        categoryId: child.categoryId,
        slug: "blocked-product",
        price: "1.00",
        translations: [{ languageId: langId, name: "Blocked" }],
      }),
    ).rejects.toMatchObject({ code: "TENANT_CONTEXT_INVALID" });

    const blocked = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from "product" where "slug" = 'blocked-product'
    `);
    expect(blocked[0].count).toBe(0);
  });

  it("creates inquiries from the customer store and prevents duplicates", async () => {
    const legacy = await seedLegacyStore();
    await seedSettings();
    const langId = await seedLanguageId();
    const categoryRow = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "inquiry-category",
      translations: [{ languageId: langId, name: "Inquiry" }],
    });
    const productRow = await createCatalogProduct(appDb(), {
      categoryId: categoryRow.categoryId,
      slug: "inquiry-product",
      price: "20.00",
      translations: [{ languageId: langId, name: "Inquiry Product" }],
    });
    const customerRow = await upsertCustomer(appDb(), {
      telegramId: 555666777,
      firstName: "Buyer",
    });
    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900005,
      updateType: "callback_query",
      payload: { callback_query: { id: "cb" } },
    });

    expect(claimed.status).toBe("claimed");

    const first = await createOrResumeProductInquiry(appDb(), {
      customerId: customerRow.id,
      productId: productRow.productId,
      productSnapshot: { name: "Inquiry Product", price: "20.00" },
      updateId: 900005,
      attemptId: claimed.attemptId,
      notificationEvent: {
        deliveryId: randomUUID(),
        reference: "SND-OWN001",
        revision: 1,
        destinationChatId: "123456789",
      },
    });

    expect(first.isResume).toBe(false);
    expect(first.inquiry.customerId).toBe(customerRow.id);
    expect(first.inquiry.productId).toBe(productRow.productId);
    expect(first.notificationDeliveryId).toBeTruthy();

    const second = await createOrResumeProductInquiry(appDb(), {
      customerId: customerRow.id,
      productId: productRow.productId,
      productSnapshot: { name: "Inquiry Product", price: "20.00" },
      updateId: 900005,
      attemptId: claimed.attemptId,
      notificationEvent: {
        deliveryId: randomUUID(),
        reference: "SND-OWN002",
        revision: 1,
        destinationChatId: "123456789",
      },
    });

    expect(second.isResume).toBe(true);
    expect(second.inquiry.id).toBe(first.inquiry.id);

    const ownership = await testDb!.db.execute<{
      customer_store: string | null;
      product_store: string | null;
      inquiry_count: number;
      delivery_count: number;
    }>(sql`
      select
        (select "store_id" from "customer" where "id" = ${customerRow.id}::uuid) as customer_store,
        (select "store_id" from "product" where "id" = ${productRow.productId}::uuid) as product_store,
        (select count(*)::int from "inquiry" where "customer_id" = ${customerRow.id}::uuid) as inquiry_count,
        (select count(*)::int from "seller_notification_delivery" where "inquiry_id" = ${first.inquiry.id}::uuid) as delivery_count
    `);
    expect(ownership[0].customer_store).toBe(legacy.id);
    expect(ownership[0].product_store).toBe(legacy.id);
    expect(ownership[0].inquiry_count).toBe(1);
    expect(ownership[0].delivery_count).toBe(1);

    const duplicateMessage = await appendInboundCustomerMessage(appDb(), {
      customerId: customerRow.id,
      inquiryId: first.inquiry.id,
      reference: first.inquiry.reference,
      body: "Hello",
      telegramMessageId: 811,
      updateId: 900005,
      attemptId: claimed.attemptId,
    });
    const repeatedMessage = await appendInboundCustomerMessage(appDb(), {
      customerId: customerRow.id,
      inquiryId: first.inquiry.id,
      reference: first.inquiry.reference,
      body: "Hello",
      telegramMessageId: 811,
      updateId: 900005,
      attemptId: claimed.attemptId,
    });

    expect(duplicateMessage.isDuplicate).toBe(false);
    expect(repeatedMessage.isDuplicate).toBe(true);
    expect(repeatedMessage.message.id).toBe(duplicateMessage.message.id);

    await markTelegramUpdateProcessed(appDb(), {
      updateId: 900005,
      attemptId: claimed.attemptId,
    });
    const reprocessed = await claimTelegramUpdate(appDb(), {
      updateId: 900005,
      updateType: "callback_query",
    });
    expect(reprocessed.status).toBe("already_processed");
    expect(reprocessed.row.storeId).toBe(legacy.id);
  });
});

describe.skipIf(!shouldRun)("S1.3-A backfill and cutover compatibility", () => {
  it("supports mixed historical NULL and newly owned rows, then backfills safely", async () => {
    await seedSettings();
    const historicalCategory = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "historical-category",
      translations: [{ languageId: (await seedLanguageId()), name: "Historical" }],
    });
    const historicalProduct = await createCatalogProduct(appDb(), {
      categoryId: historicalCategory.categoryId,
      slug: "historical-product",
      price: "4.00",
      translations: [{ languageId: (await seedLanguageId()), name: "Historical Product" }],
    });
    await createPaymentMethod(appDb(), {
      adminLabel: "Historical Method",
      translations: [{ languageCode: "en", title: "Historical Method" }],
    });
    await createTemplate(appDb(), { key: "historical_template" });
    const historicalCustomer = await upsertCustomer(appDb(), {
      telegramId: 999000111,
    });
    await saveSellerNotificationConfig(appDb(), {
      destinationChatId: "123456789",
    });
    const historicalClaim = await claimTelegramUpdate(appDb(), {
      updateId: 900006,
      updateType: "message",
      payload: { message: { message_id: 6 } },
    });

    const legacy = await seedLegacyStore();
    const langId = await seedLanguageId();

    const ownedCategory = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "owned-category",
      translations: [{ languageId: langId, name: "Owned" }],
    });
    const ownedProduct = await createCatalogProduct(appDb(), {
      categoryId: ownedCategory.categoryId,
      slug: "owned-product",
      price: "6.00",
      translations: [{ languageId: langId, name: "Owned Product" }],
    });
    const ownedMethod = await createPaymentMethod(appDb(), {
      adminLabel: "Owned Method",
      translations: [{ languageCode: "en", title: "Owned Method" }],
    });
    const ownedTemplate = await createTemplate(appDb(), { key: "owned_template" });
    const ownedCustomer = await upsertCustomer(appDb(), {
      telegramId: 999000222,
    });
    await saveSellerNotificationConfig(appDb(), { language: "ar" });
    const ownedClaim = await claimTelegramUpdate(appDb(), {
      updateId: 900007,
      updateType: "message",
      payload: { message: { message_id: 7 } },
    });

    expect(historicalClaim.row.storeId).toBeNull();
    expect(ownedClaim.row.storeId).toBe(legacy.id);
    expect(await rowStoreId("product", "id", historicalProduct.productId)).toBeNull();
    expect(await rowStoreId("product", "id", ownedProduct.productId)).toBe(
      legacy.id,
    );
    expect(historicalCustomer.storeId).toBeNull();
    expect(ownedCustomer.storeId).toBe(legacy.id);
    expect(await rowStoreId("message_template", "id", ownedTemplate.id)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("payment_method", "id", ownedMethod.methodId)).toBe(
      legacy.id,
    );

    await runBackfill();

    for (const table of [
      "bot_setting",
      "category",
      "product",
      "payment_method",
      "message_template",
      "customer",
      "seller_notification_setting",
      "telegram_update",
    ]) {
      const rows = await testDb!.db.execute<{ unowned: number; other: number }>(sql`
        select
          count(*) filter (where "store_id" is null)::int as unowned,
          count(*) filter (where "store_id" is not null and "store_id" <> ${legacy.id}::uuid)::int as other
        from ${sql.identifier(table)}
      `);
      expect(rows[0].unowned).toBe(0);
      expect(rows[0].other).toBe(0);
    }

    expect(await rowStoreId("product", "id", historicalProduct.productId)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("product", "id", ownedProduct.productId)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("customer", "id", historicalCustomer.id)).toBe(
      legacy.id,
    );
    expect(await rowStoreId("customer", "id", ownedCustomer.id)).toBe(legacy.id);

    const assertions = await verificationAssertions();
    expect(
      assertions
        .filter((row) => row.kind === "assertion")
        .every((row) => row.ok === true),
    ).toBe(true);

    await runBackfill();
    expect(await rowStoreId("product", "id", historicalProduct.productId)).toBe(
      legacy.id,
    );
  });

  it("keeps historical NULL rows visible before and after mixed writes", async () => {
    await seedSettings();
    const historical = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "visible-historical",
      translations: [{ languageId: (await seedLanguageId()), name: "Visible" }],
    });
    await seedLegacyStore();
    const owned = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "visible-owned",
      translations: [{ languageId: await seedLanguageId(), name: "Owned" }],
    });

    const categories = await listCatalogCategories(appDb());
    expect(categories.map((row) => row.id)).toEqual(
      expect.arrayContaining([historical.categoryId, owned.categoryId]),
    );

    const historicalProduct = await testDb!.db
      .insert(product)
      .values({
        categoryId: historical.categoryId,
        slug: "visible-historical-product",
        price: "1.00",
        sortOrder: 1,
      })
      .returning();
    const ownedProduct = await createCatalogProduct(appDb(), {
      categoryId: owned.categoryId,
      slug: "visible-owned-product",
      price: "2.00",
      translations: [{ languageId: await seedLanguageId(), name: "Owned" }],
    });

    const products = await listCatalogProducts(appDb());
    expect(products.map((row) => row.id)).toEqual(
      expect.arrayContaining([historicalProduct[0].id, ownedProduct.productId]),
    );
  });
});

describe.skipIf(!shouldRun)("S1.3-A concurrency and notification safety", () => {
  it("keeps customer identity and ownership stable under concurrent upserts", async () => {
    const legacy = await seedLegacyStore();

    const results = await Promise.all([
      upsertCustomer(appDb(), { telegramId: 121212121, firstName: "A" }),
      upsertCustomer(appDb(), { telegramId: 121212121, firstName: "B" }),
    ]);

    expect(results[0].id).toBe(results[1].id);
    expect(results[0].storeId).toBe(legacy.id);
    expect(results[1].storeId).toBe(legacy.id);

    const rows = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from "customer" where "telegram_id" = 121212121
    `);
    expect(rows[0].count).toBe(1);
  });

  it("allows exactly one concurrent claim and stamps it with the store", async () => {
    const legacy = await seedLegacyStore();

    const results = await Promise.all([
      claimTelegramUpdate(appDb(), {
        updateId: 900008,
        updateType: "message",
        payload: { message: { message_id: 8 } },
      }),
      claimTelegramUpdate(appDb(), {
        updateId: 900008,
        updateType: "message",
        payload: { message: { message_id: 8 } },
      }),
    ]);

    expect(results.filter((row) => row.status === "claimed")).toHaveLength(1);
    expect(results.filter((row) => row.status === "in_flight")).toHaveLength(1);
    const stored = await testDb!.db
      .select({ storeId: telegramUpdate.storeId })
      .from(telegramUpdate)
      .where(eq(telegramUpdate.updateId, 900008));
    expect(stored[0].storeId).toBe(legacy.id);
  });

  it("applies the ownership cutover without touching notification delivery state", async () => {
    await seedSettings();
    const langId = await seedLanguageId();
    const categoryRow = await createCatalogCategory(appDb(), {
      parentId: null,
      slug: "cutover-category",
      translations: [{ languageId: langId, name: "Cutover" }],
    });
    const productRow = await createCatalogProduct(appDb(), {
      categoryId: categoryRow.categoryId,
      slug: "cutover-product",
      price: "7.00",
      translations: [{ languageId: langId, name: "Cutover Product" }],
    });
    const customerRow = await upsertCustomer(appDb(), {
      telegramId: 343434343,
    });
    const claimed = await claimTelegramUpdate(appDb(), {
      updateId: 900009,
      updateType: "callback_query",
      payload: { callback_query: { id: "cb" } },
    });
    const inquiry = await createOrResumeProductInquiry(appDb(), {
      customerId: customerRow.id,
      productId: productRow.productId,
      productSnapshot: { name: "Cutover Product", price: "7.00" },
      updateId: 900009,
      attemptId: claimed.attemptId,
      notificationEvent: {
        deliveryId: randomUUID(),
        reference: "SND-CUT001",
        revision: 1,
        destinationChatId: "123456789",
      },
    });
    expect(inquiry.notificationDeliveryId).toBeTruthy();

    const before = await testDb!.db
      .select()
      .from(sellerNotificationDelivery)
      .where(eq(sellerNotificationDelivery.inquiryId, inquiry.inquiry.id));
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("pending");

    await seedLegacyStore();
    await upsertCustomer(appDb(), {
      telegramId: customerRow.telegramId,
      firstName: "Cutover Updated",
    });

    const after = await testDb!.db
      .select()
      .from(sellerNotificationDelivery)
      .where(eq(sellerNotificationDelivery.inquiryId, inquiry.inquiry.id));
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("pending");
    expect(after[0].sentAt).toBeNull();
    expect(after[0].telegramMessageId).toBeNull();
  });
});
