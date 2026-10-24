import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  botSetting,
  category,
  categoryTranslation,
  customer,
  inquiry,
  language,
  messageTemplate,
  messageTranslation,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  telegramUpdate,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
} from "@/lib/data/telegram";
import { boundMessageText } from "@/lib/telegram/catalog-journey";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

const TEST_BOT_TOKEN = "123456789:TEST_BOT_TOKEN_FOR_VERIFICATION";
const TEST_WEBHOOK_SECRET = "super-secret-telegram-webhook-token-12345";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("telegram_journey");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

function createWebhookRequest(body: unknown, secretHeader?: string): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (secretHeader !== undefined) {
    headers.set("x-telegram-bot-api-secret-token", secretHeader);
  }

  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(!shouldRun)("Telegram Webhook & First Catalog Journey (Phase 06-A)", () => {
  it("fails closed on missing configuration with zero writes and zero calls", async () => {
    const fakeTransport = createFakeTelegramTransport();
    const req = createWebhookRequest({ update_id: 100 }, TEST_WEBHOOK_SECRET);

    // Missing botToken
    const resNoToken = await handleTelegramWebhookRequest(req, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: "",
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resNoToken.status).toBe(503);
    const jsonNoToken = (await resNoToken.json()) as { error: string };
    expect(jsonNoToken.error).toContain("not configured");
    expect(fakeTransport.sentMessages).toHaveLength(0);

    // Missing webhookSecret
    const resNoSecret = await handleTelegramWebhookRequest(req, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: "",
    });
    expect(resNoSecret.status).toBe(503);
    expect(fakeTransport.sentMessages).toHaveLength(0);

    // Verify zero database updates recorded
    const updates = await testDb!.db.select().from(telegramUpdate);
    expect(updates).toHaveLength(0);
  });

  it("rejects missing or invalid secret token with zero database writes and zero outbound calls", async () => {
    const fakeTransport = createFakeTelegramTransport();

    // 1. Missing secret header
    const reqMissing = createWebhookRequest({ update_id: 101 });
    const resMissing = await handleTelegramWebhookRequest(reqMissing, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resMissing.status).toBe(401);

    // 2. Wrong secret header
    const reqWrong = createWebhookRequest({ update_id: 102 }, "wrong-secret-token");
    const resWrong = await handleTelegramWebhookRequest(reqWrong, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resWrong.status).toBe(401);

    expect(fakeTransport.sentMessages).toHaveLength(0);
    const updates = await testDb!.db.select().from(telegramUpdate);
    expect(updates).toHaveLength(0);
  });

  it("safely handles malformed JSON or invalid update structures", async () => {
    const fakeTransport = createFakeTelegramTransport();

    // Malformed JSON string
    const reqMalformed = createWebhookRequest("{ not a valid json", TEST_WEBHOOK_SECRET);
    const resMalformed = await handleTelegramWebhookRequest(reqMalformed, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resMalformed.status).toBe(400);

    // Missing update_id
    const reqNoId = createWebhookRequest({ message: { text: "hi" } }, TEST_WEBHOOK_SECRET);
    const resNoId = await handleTelegramWebhookRequest(reqNoId, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resNoId.status).toBe(400);

    expect(fakeTransport.sentMessages).toHaveLength(0);
  });

  it("safely ignores unsupported update types and non-private chats without creating business records", async () => {
    const fakeTransport = createFakeTelegramTransport();

    // Channel post
    const reqChannel = createWebhookRequest(
      { update_id: 201, channel_post: { message_id: 1, text: "channel broadcast" } },
      TEST_WEBHOOK_SECRET,
    );
    const resChannel = await handleTelegramWebhookRequest(reqChannel, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resChannel.status).toBe(200);
    expect(await resChannel.json()).toEqual({ ok: true, ignored: true });

    // Group message
    const reqGroup = createWebhookRequest(
      {
        update_id: 202,
        message: {
          message_id: 2,
          chat: { id: -1001234567, type: "supergroup" },
          text: "/start",
        },
      },
      TEST_WEBHOOK_SECRET,
    );
    const resGroup = await handleTelegramWebhookRequest(reqGroup, {
      db: asAppDb(testDb!.db),
      transport: fakeTransport,
      botToken: TEST_BOT_TOKEN,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });
    expect(resGroup.status).toBe(200);
    expect(await resGroup.json()).toEqual({ ok: true, ignored: true });

    expect(fakeTransport.sentMessages).toHaveLength(0);
    const customers = await testDb!.db.select().from(customer);
    expect(customers).toHaveLength(0);
  });

  describe("End-to-End Customer Journey with Seeded Store", () => {
    let enLangId: string;
    let arLangId: string;
    let rootCatId: string;
    let subCatId: string;
    let testProductId: string;
    let rootMenuActionId: string;
    let detailsActionId: string;
    let deferredInquiryActionId: string;

    beforeAll(async () => {
      const db = testDb!.db;

      // 1. Setup languages
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

      // 2. Setup bot_setting singleton
      await db.insert(botSetting).values({
        id: 1,
        defaultLanguageId: enLangId,
        currency: "USD",
        displayName: "Acme Digital Store",
        askForLanguage: true,
      });

      // 3. Setup message template bot_welcome
      const [tpl] = await db
        .insert(messageTemplate)
        .values({
          key: "bot_welcome",
          description: "Greeting for customers",
        })
        .returning();

      await db.insert(messageTranslation).values([
        {
          templateId: tpl.id,
          languageId: enLangId,
          body: "Welcome to {{store_name}}! Browse our digital products below.",
        },
        {
          templateId: tpl.id,
          languageId: arLangId,
          body: "مرحباً بكم في {{store_name}}! تصفح منتجاتنا الرقمية أدناه.",
        },
      ]);

      // 4. Setup catalog categories: Root category & Nested subcategory
      const [cat1] = await db
        .insert(category)
        .values({
          slug: "software",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      rootCatId = cat1.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: rootCatId,
          languageId: enLangId,
          name: "Software & Tools",
          description: "Handcrafted developer tools",
        },
        {
          categoryId: rootCatId,
          languageId: arLangId,
          name: "برمجيات وأدوات",
          description: "أدوات برمجية متميزة",
        },
      ]);

      const [cat2] = await db
        .insert(category)
        .values({
          parentId: rootCatId,
          slug: "software-dev",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      subCatId = cat2.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: subCatId,
          languageId: enLangId,
          name: "Web Templates",
          description: "Responsive Next.js kits",
        },
        {
          categoryId: subCatId,
          languageId: arLangId,
          name: "قوالب الويب",
          description: "قوالب متجاوبة وسريعة",
        },
      ]);

      // 5. Setup product with exact price
      const [prod] = await db
        .insert(product)
        .values({
          categoryId: subCatId,
          slug: "pro-portfolio-template",
          price: "49.99",
          isActive: true,
          sortOrder: 1,
        })
        .returning();
      testProductId = prod.id;

      await db.insert(productTranslation).values([
        {
          productId: testProductId,
          languageId: enLangId,
          name: "Pro Portfolio Template",
          description: "High-converting developer portfolio",
          details: "Includes dark mode, blog engine, contact form, and SEO setup.",
        },
        {
          productId: testProductId,
          languageId: arLangId,
          name: "قالب الملف التعريفي الاحترافي",
          description: "معرض أعمال عالي التحويل للمطورين",
          details: "يتضمن الوضع الليلي، مدونة متكاملة، ونموذج تواصل.",
        },
      ]);

      // 6. Setup recursive product actions
      // Root Menu: OPEN_SUBMENU
      const [actRoot] = await db
        .insert(productAction)
        .values({
          productId: testProductId,
          actionType: "OPEN_SUBMENU",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      rootMenuActionId = actRoot.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: rootMenuActionId,
          languageId: enLangId,
          label: "Product Options",
          menuText: "Choose your customized package options:",
        },
        {
          actionId: rootMenuActionId,
          languageId: arLangId,
          label: "خيارات المنتج",
          menuText: "اختر خيارات الباقة المخصصة:",
        },
      ]);

      // Child 1: SHOW_DETAILS
      const [actDetails] = await db
        .insert(productAction)
        .values({
          productId: testProductId,
          parentActionId: rootMenuActionId,
          actionType: "SHOW_DETAILS",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      detailsActionId = actDetails.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: detailsActionId,
          languageId: enLangId,
          label: "Full Specifications",
        },
        {
          actionId: detailsActionId,
          languageId: arLangId,
          label: "المواصفات الكاملة",
        },
      ]);

      // Child 2: START_INQUIRY (Deferred action)
      const [actInquiry] = await db
        .insert(productAction)
        .values({
          productId: testProductId,
          parentActionId: rootMenuActionId,
          actionType: "START_INQUIRY",
          sortOrder: 2,
          isActive: true,
        })
        .returning();
      deferredInquiryActionId = actInquiry.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: deferredInquiryActionId,
          languageId: enLangId,
          label: "Ask Seller",
        },
        {
          actionId: deferredInquiryActionId,
          languageId: arLangId,
          label: "تواصل مع البائع",
        },
      ]);
    });

    it("executes the full customer journey smoothly", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 987654321;

      // STEP 1: /start with multiple languages and askForLanguage = true
      // -> Expects language selection prompt
      const startReq = createWebhookRequest(
        {
          update_id: 1001,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
              username: "amira_dev",
            },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const startRes = await handleTelegramWebhookRequest(startReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(startRes.status).toBe(200);

      // Verify language selection message was sent
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const langPrompt = fakeTransport.sentMessages[0];
      expect(langPrompt.text).toContain("Please select your language");
      expect(langPrompt.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "English", callback_data: "lang:en" }],
        [{ text: "العربية", callback_data: "lang:ar" }],
      ]);

      // Verify customer record created in database with minimal attributes
      const [savedCustomer] = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, customerTelegramId));
      expect(savedCustomer).toBeDefined();
      expect(savedCustomer.firstName).toBe("Amira");
      expect(savedCustomer.telegramUsername).toBe("amira_dev");
      expect(savedCustomer.selectedLanguageId).toBeNull();

      fakeTransport.clear();

      // STEP 2: Customer selects English: callback lang:en
      const langCallbackReq = createWebhookRequest(
        {
          update_id: 1002,
          callback_query: {
            id: "cb_lang_en",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: "lang:en",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const langRes = await handleTelegramWebhookRequest(langCallbackReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(langRes.status).toBe(200);

      // Verify customer language updated in PostgreSQL
      const [updatedCustomer] = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, customerTelegramId));
      expect(updatedCustomer.selectedLanguageId).toBe(enLangId);

      // Verify root catalog rendered
      expect(fakeTransport.editedMessages).toHaveLength(1);
      const rootCatalogMsg = fakeTransport.editedMessages[0];
      expect(rootCatalogMsg.text).toContain("Welcome to Acme Digital Store!");
      expect(rootCatalogMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Software & Tools", callback_data: `c:${rootCatId}` }],
      ]);

      fakeTransport.clear();

      // STEP 3: Customer taps root category: c:<rootCatId>
      const catReq = createWebhookRequest(
        {
          update_id: 1003,
          callback_query: {
            id: "cb_cat_root",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.category(rootCatId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const catRes = await handleTelegramWebhookRequest(catReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(catRes.status).toBe(200);

      // Displays subcategories and navigation Back/Home
      expect(fakeTransport.editedMessages).toHaveLength(1);
      const subcatMenuMsg = fakeTransport.editedMessages[0];
      expect(subcatMenuMsg.text).toContain("Software & Tools");
      expect(subcatMenuMsg.text).toContain("Handcrafted developer tools");
      expect(subcatMenuMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Web Templates", callback_data: `c:${subCatId}` }],
        [
          { text: "◀ Back", callback_data: "home" },
          { text: "🏠 Home", callback_data: "home" },
        ],
      ]);

      fakeTransport.clear();

      // STEP 4: Customer taps subcategory: c:<subCatId>
      const subcatReq = createWebhookRequest(
        {
          update_id: 1004,
          callback_query: {
            id: "cb_cat_sub",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.category(subCatId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const subcatRes = await handleTelegramWebhookRequest(subcatReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(subcatRes.status).toBe(200);

      expect(fakeTransport.editedMessages).toHaveLength(1);
      const prodListMsg = fakeTransport.editedMessages[0];
      expect(prodListMsg.text).toContain("Web Templates");
      expect(prodListMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Pro Portfolio Template", callback_data: `p:${testProductId}` }],
        [
          { text: "◀ Back", callback_data: `c:${rootCatId}` },
          { text: "🏠 Home", callback_data: "home" },
        ],
      ]);

      fakeTransport.clear();

      // STEP 5: Customer taps product card: p:<testProductId>
      const prodReq = createWebhookRequest(
        {
          update_id: 1005,
          callback_query: {
            id: "cb_prod_card",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.product(testProductId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const prodRes = await handleTelegramWebhookRequest(prodReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(prodRes.status).toBe(200);

      expect(fakeTransport.editedMessages).toHaveLength(1);
      const prodCardMsg = fakeTransport.editedMessages[0];
      expect(prodCardMsg.text).toContain("Pro Portfolio Template");
      expect(prodCardMsg.text).toContain("High-converting developer portfolio");
      // Exact decimal price displayed without conversion
      expect(prodCardMsg.text).toContain("Price: 49.99 USD");
      expect(prodCardMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Product Options", callback_data: `a:${rootMenuActionId}` }],
        [
          { text: "◀ Back", callback_data: `c:${subCatId}` },
          { text: "🏠 Home", callback_data: "home" },
        ],
      ]);

      fakeTransport.clear();

      // STEP 6: Customer taps product action submenu: a:<rootMenuActionId> (OPEN_SUBMENU)
      const actionReq = createWebhookRequest(
        {
          update_id: 1006,
          callback_query: {
            id: "cb_act_submenu",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(rootMenuActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const actionRes = await handleTelegramWebhookRequest(actionReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(actionRes.status).toBe(200);

      expect(fakeTransport.editedMessages).toHaveLength(1);
      const submenuMsg = fakeTransport.editedMessages[0];
      expect(submenuMsg.text).toBe("Choose your customized package options:");
      expect(submenuMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Full Specifications", callback_data: `a:${detailsActionId}` }],
        [{ text: "Ask Seller", callback_data: `a:${deferredInquiryActionId}` }],
        [{ text: "◀ Back", callback_data: `p:${testProductId}` }],
        [{ text: "🏠 Home", callback_data: "home" }],
      ]);

      fakeTransport.clear();

      // STEP 7: Customer taps SHOW_DETAILS action: a:<detailsActionId>
      const detailsReq = createWebhookRequest(
        {
          update_id: 1007,
          callback_query: {
            id: "cb_act_details",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(detailsActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const detailsRes = await handleTelegramWebhookRequest(detailsReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(detailsRes.status).toBe(200);

      expect(fakeTransport.editedMessages).toHaveLength(1);
      const detailsMsg = fakeTransport.editedMessages[0];
      expect(detailsMsg.text).toContain("Pro Portfolio Template");
      expect(detailsMsg.text).toContain(
        "Includes dark mode, blog engine, contact form, and SEO setup.",
      );
      expect(detailsMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "◀ Back", callback_data: `a:${rootMenuActionId}` }],
        [{ text: "📦 Return to Product", callback_data: `p:${testProductId}` }],
        [{ text: "🏠 Home", callback_data: "home" }],
      ]);

      fakeTransport.clear();

      // STEP 8: Customer taps deferred action: a:<deferredInquiryActionId> (START_INQUIRY)
      const deferredReq = createWebhookRequest(
        {
          update_id: 1008,
          callback_query: {
            id: "cb_deferred_inquiry",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(deferredInquiryActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const deferredRes = await handleTelegramWebhookRequest(deferredReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(deferredRes.status).toBe(200);

      // Truthful unavailable response
      expect(fakeTransport.editedMessages).toHaveLength(1);
      const deferredMsg = fakeTransport.editedMessages[0];
      expect(deferredMsg.text).toContain("This action is not yet supported in this version.");

      // Verify answerCallbackQuery was called
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);

      // ZERO inquiries or conversation records created
      const inquiries = await testDb!.db.select().from(inquiry);
      expect(inquiries).toHaveLength(0);

      fakeTransport.clear();

      // STEP 9: Customer taps Home button
      const homeReq = createWebhookRequest(
        {
          update_id: 1009,
          callback_query: {
            id: "cb_home",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Amira",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.home(),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const homeRes = await handleTelegramWebhookRequest(homeReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(homeRes.status).toBe(200);

      expect(fakeTransport.editedMessages).toHaveLength(1);
      const homeMsg = fakeTransport.editedMessages[0];
      expect(homeMsg.text).toContain("Welcome to Acme Digital Store!");
      expect(homeMsg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "Software & Tools", callback_data: `c:${rootCatId}` }],
      ]);
    });
  });

  describe("Arabic-default and RTL localization", () => {
    it("renders Arabic default store with RTL texts and exact Arabic labels", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 777666555;

      // Update store settings to default to Arabic and askForLanguage = false
      const [arLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "ar"))
        .limit(1);

      await db
        .update(botSetting)
        .set({
          defaultLanguageId: arLang.id,
          askForLanguage: false,
        })
        .where(eq(botSetting.id, 1));

      // Customer sends /start
      const req = createWebhookRequest(
        {
          update_id: 2001,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: { id: customerTelegramId, is_bot: false, first_name: "Tariq" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res.status).toBe(200);

      // Directly renders Arabic welcome without prompt (since askForLanguage = false)
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const msg = fakeTransport.sentMessages[0];
      expect(msg.text).toContain("مرحباً بكم في Acme Digital Store!");
      expect(msg.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "برمجيات وأدوات", callback_data: expect.stringMatching(/^c:/) }],
      ]);

      // Revert store settings
      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"))
        .limit(1);
      await db
        .update(botSetting)
        .set({
          defaultLanguageId: enLang.id,
          askForLanguage: true,
        })
        .where(eq(botSetting.id, 1));
    });
  });

  describe("Ancestry and Inactivity Safeguards", () => {
    it("hides and rejects categories and products under an inactive ancestor", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 444333222;

      // Create an inactive parent category with active child and active product
      const [inactiveParent] = await db
        .insert(category)
        .values({
          slug: "inactive-root-cat",
          isActive: false,
          sortOrder: 50,
        })
        .returning();

      const [childCat] = await db
        .insert(category)
        .values({
          parentId: inactiveParent.id,
          slug: "child-of-inactive",
          isActive: true,
          sortOrder: 1,
        })
        .returning();

      const [childProd] = await db
        .insert(product)
        .values({
          categoryId: childCat.id,
          slug: "product-under-inactive-cat",
          price: "10.00",
          isActive: true,
          sortOrder: 1,
        })
        .returning();

      // 1. Tapping child category callback -> rejected with safe unavailable message
      const catReq = createWebhookRequest(
        {
          update_id: 3001,
          callback_query: {
            id: "cb_inactive_cat",
            from: { id: customerTelegramId, is_bot: false, first_name: "User" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.category(childCat.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const catRes = await handleTelegramWebhookRequest(catReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(catRes.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toContain(
        "This category is no longer available.",
      );

      fakeTransport.clear();

      // 2. Tapping product under inactive category -> rejected with safe unavailable message
      const prodReq = createWebhookRequest(
        {
          update_id: 3002,
          callback_query: {
            id: "cb_inactive_prod",
            from: { id: customerTelegramId, is_bot: false, first_name: "User" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.product(childProd.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const prodRes = await handleTelegramWebhookRequest(prodReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(prodRes.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toContain(
        "This product is no longer available.",
      );
    });

    it("rejects action execution if parent action is inactive or not OPEN_SUBMENU", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 444333222;

      // Find our test product
      const [prod] = await db.select().from(product).limit(1);

      // Create an inactive root menu
      const [inactiveMenu] = await db
        .insert(productAction)
        .values({
          productId: prod.id,
          actionType: "OPEN_SUBMENU",
          sortOrder: 90,
          isActive: false,
        })
        .returning();

      // Active child under inactive menu
      const [childAction] = await db
        .insert(productAction)
        .values({
          productId: prod.id,
          parentActionId: inactiveMenu.id,
          actionType: "SHOW_DETAILS",
          sortOrder: 1,
          isActive: true,
        })
        .returning();

      const req = createWebhookRequest(
        {
          update_id: 3003,
          callback_query: {
            id: "cb_inactive_action_parent",
            from: { id: customerTelegramId, is_bot: false, first_name: "User" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(childAction.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toContain(
        "This option is no longer available.",
      );
    });
  });

  describe("Update Deduplication and Delivery Failure Retries", () => {
    it("handles sequential duplicate update_id without repeating writes or sends", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888111222;

      const payload = {
        update_id: 4001,
        message: {
          message_id: 100,
          chat: { id: customerTelegramId, type: "private" },
          from: { id: customerTelegramId, is_bot: false, first_name: "DedupUser" },
          text: "/start",
        },
      };

      // First delivery
      const res1 = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );
      expect(res1.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);

      // Verify telegram_update row is marked processed_at
      const [row1] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 4001));
      expect(row1.processedAt).not.toBeNull();
      expect(row1.processingError).toBeNull();

      fakeTransport.clear();

      // Second delivery with identical update_id
      const res2 = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );
      expect(res2.status).toBe(200);
      const json2 = (await res2.json()) as { status: string };
      expect(json2.status).toBe("already_processed");

      // ZERO outbound sends executed on duplicate!
      expect(fakeTransport.sentMessages).toHaveLength(0);
    });

    it("handles concurrent duplicate deliveries with exactly one processing pass", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888111333;

      const payload = {
        update_id: 4002,
        message: {
          message_id: 101,
          chat: { id: customerTelegramId, type: "private" },
          from: { id: customerTelegramId, is_bot: false, first_name: "ConcurrentUser" },
          text: "/start",
        },
      };

      // Run two parallel requests
      const [resA, resB] = await Promise.all([
        handleTelegramWebhookRequest(createWebhookRequest(payload, TEST_WEBHOOK_SECRET), {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        }),
        handleTelegramWebhookRequest(createWebhookRequest(payload, TEST_WEBHOOK_SECRET), {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        }),
      ]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      // Exactly one message was sent to Telegram across both parallel deliveries
      expect(fakeTransport.sentMessages).toHaveLength(1);

      // Exactly one customer row exists
      const customers = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, customerTelegramId));
      expect(customers).toHaveLength(1);
    });

    it("handles transport failure and bounded retries gracefully", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888111444;

      const payload = {
        update_id: 4003,
        message: {
          message_id: 102,
          chat: { id: customerTelegramId, type: "private" },
          from: { id: customerTelegramId, is_bot: false, first_name: "RetryUser" },
          text: "/start",
        },
      };

      // Simulate network failure
      fakeTransport.failSendWith = "Connection timeout to api.telegram.org";

      const resFail = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );
      expect(resFail.status).toBe(500);

      // Verify telegram_update recorded error and left processedAt null
      const [failedRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 4003));
      expect(failedRow.processedAt).toBeNull();
      expect(failedRow.processingError).toContain("Connection timeout");

      // Now recovery: Telegram retries the update
      fakeTransport.failSendWith = undefined;

      const resRetry = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );
      expect(resRetry.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);

      // Verify telegram_update is now marked processed
      const [successRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 4003));
      expect(successRow.processedAt).not.toBeNull();
      expect(successRow.processingError).toBeNull();
    });
  });

  describe("Pagination and Stale Callback Boundaries", () => {
    it("paginates submenus deterministically when active children exceed page size", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888222333;

      // Find our test product
      const [prod] = await db.select().from(product).limit(1);

      // Create a menu action
      const [menuAction] = await db
        .insert(productAction)
        .values({
          productId: prod.id,
          actionType: "OPEN_SUBMENU",
          sortOrder: 200,
          isActive: true,
        })
        .returning();

      // Insert 12 active child actions (> TELEGRAM_MENU_PAGE_SIZE = 10)
      for (let i = 1; i <= 12; i++) {
        await db.insert(productAction).values({
          productId: prod.id,
          parentActionId: menuAction.id,
          actionType: "SHOW_DETAILS",
          sortOrder: i,
          isActive: true,
        });
      }

      // Tap menu -> should show Page 1 (10 items) + Next button
      const reqPage1 = createWebhookRequest(
        {
          update_id: 5001,
          callback_query: {
            id: "cb_page1",
            from: { id: customerTelegramId, is_bot: false, first_name: "PageUser" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(menuAction.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const resPage1 = await handleTelegramWebhookRequest(reqPage1, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resPage1.status).toBe(200);

      const msg1 = fakeTransport.editedMessages[0];
      const keyboard1 = msg1.replyMarkup?.inline_keyboard ?? [];

      // Check for Next button
      const hasNext = keyboard1.some((row) =>
        row.some((btn) => btn.callback_data === `m:${menuAction.id}:2`),
      );
      expect(hasNext).toBe(true);

      fakeTransport.clear();

      // Tap Next button (Page 2)
      const reqPage2 = createWebhookRequest(
        {
          update_id: 5002,
          callback_query: {
            id: "cb_page2",
            from: { id: customerTelegramId, is_bot: false, first_name: "PageUser" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.submenu(menuAction.id, 2),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const resPage2 = await handleTelegramWebhookRequest(reqPage2, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resPage2.status).toBe(200);

      const msg2 = fakeTransport.editedMessages[0];
      const keyboard2 = msg2.replyMarkup?.inline_keyboard ?? [];

      // Check for Prev button
      const hasPrev = keyboard2.some((row) =>
        row.some((btn) => btn.callback_data === tokens.submenu(menuAction.id, 1)),
      );
      expect(hasPrev).toBe(true);
    });

    it("handles stale callbacks safely when product is deactivated after button was rendered", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888222444;

      // Create a transient product
      const [transientCat] = await db
        .select()
        .from(category)
        .where(eq(category.slug, "software-dev"))
        .limit(1);

      const [transientProd] = await db
        .insert(product)
        .values({
          categoryId: transientCat.id,
          slug: "transient-product",
          price: "15.00",
          isActive: true,
          sortOrder: 55,
        })
        .returning();

      // Deactivate product (simulating admin deactivation after customer received button)
      await db
        .update(product)
        .set({ isActive: false })
        .where(eq(product.id, transientProd.id));

      // Customer taps stale button
      const reqStale = createWebhookRequest(
        {
          update_id: 5003,
          callback_query: {
            id: "cb_stale_prod",
            from: { id: customerTelegramId, is_bot: false, first_name: "StaleUser" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.product(transientProd.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const resStale = await handleTelegramWebhookRequest(reqStale, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resStale.status).toBe(200);

      // Safe unavailable feedback without crashing
      expect(fakeTransport.editedMessages[0].text).toContain(
        "This product is no longer available.",
      );
    });

    it("does not offer a disabled language even if translations exist", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888222555;

      // Temporarily disable Arabic
      await db
        .update(language)
        .set({ isEnabled: false })
        .where(eq(language.code, "ar"));

      // Customer sends /start -> since only English is enabled, no choice prompt is shown
      const req = createWebhookRequest(
        {
          update_id: 5004,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: { id: customerTelegramId, is_bot: false, first_name: "SingleLangUser" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res.status).toBe(200);

      // Welcome message sent directly without language choice prompt
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages[0].text).toContain("Welcome to Acme Digital Store!");

      // Re-enable Arabic
      await db
        .update(language)
        .set({ isEnabled: true })
        .where(eq(language.code, "ar"));
    });
  });

  describe("Atomic Retry Ownership and Lease Recovery", () => {
    it("coordinates concurrent retries after failure: winner holds claim while runner gets in_flight", async () => {
      const db = asAppDb(testDb!.db);
      const updateId = 6001;

      // 1. Initial attempt is claimed and fails
      const claim1 = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "attempt-init",
      });
      expect(claim1.status).toBe("claimed");

      await markTelegramUpdateFailed(db, {
        updateId,
        attemptId: "attempt-init",
        errorMessage: "Network drop",
      });

      // 2. Start two concurrent retries
      const [retryA, retryB] = await Promise.all([
        claimTelegramUpdate(db, {
          updateId,
          updateType: "message",
          attemptId: "attempt-retry-A",
        }),
        claimTelegramUpdate(db, {
          updateId,
          updateType: "message",
          attemptId: "attempt-retry-B",
        }),
      ]);

      // Exactly one must be claimed, and the other must receive in_flight
      const winner = retryA.status === "claimed" ? retryA : retryB;
      const loser = retryA.status === "claimed" ? retryB : retryA;

      expect(winner.status).toBe("claimed");
      expect(loser.status).toBe("in_flight");

      // While winner holds ownership, a third attempt also gets in_flight
      const third = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "attempt-retry-C",
      });
      expect(third.status).toBe("in_flight");

      // Winner completes successfully
      if (winner.status === "claimed") {
        const marked = await markTelegramUpdateProcessed(db, {
          updateId,
          attemptId: winner.attemptId,
        });
        expect(marked).toBe(true);
      }

      // Subsequent attempt is already_processed
      const afterSuccess = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "attempt-retry-D",
      });
      expect(afterSuccess.status).toBe("already_processed");
    });

    it("prevents a stale attempt from overwriting a newer attempt on completion or failure", async () => {
      const db = asAppDb(testDb!.db);
      const updateId = 6002;

      // Attempt 1 claims
      const claim1 = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "attempt-1",
      });
      expect(claim1.status).toBe("claimed");

      // Attempt 1 fails
      await markTelegramUpdateFailed(db, {
        updateId,
        attemptId: "attempt-1",
        errorMessage: "First fail",
      });

      // Attempt 2 claims the retry
      const claim2 = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "attempt-2",
      });
      expect(claim2.status).toBe("claimed");

      // Stale Attempt 1 tries to mark it processed -> rejected (false)
      const staleComplete = await markTelegramUpdateProcessed(db, {
        updateId,
        attemptId: "attempt-1",
      });
      expect(staleComplete).toBe(false);

      // Stale Attempt 1 tries to mark it failed -> rejected (false)
      const staleFail = await markTelegramUpdateFailed(db, {
        updateId,
        attemptId: "attempt-1",
        errorMessage: "Stale failure overwrite attempt",
      });
      expect(staleFail).toBe(false);

      // Row still belongs to Attempt 2 and processedAt is still null
      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBeNull(); // Reset by Attempt 2's claim

      // Attempt 2 marks processed -> succeeds (true)
      const validComplete = await markTelegramUpdateProcessed(db, {
        updateId,
        attemptId: "attempt-2",
      });
      expect(validComplete).toBe(true);

      const [finalRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(finalRow.processedAt).not.toBeNull();
    });

    it("recovers an abandoned in-flight attempt after the lease window expires (> 30s)", async () => {
      const db = asAppDb(testDb!.db);
      const updateId = 6003;

      // Insert an update simulating an in-flight attempt started 45 seconds ago that crashed
      const fortyFiveSecondsAgo = new Date(Date.now() - 45_000);
      await testDb!.db.insert(telegramUpdate).values({
        updateId,
        updateType: "message",
        payload: {
          update: { update_id: updateId },
          attemptId: "crashed-worker-attempt",
          claimedAt: fortyFiveSecondsAgo.toISOString(),
        },
        processedAt: null,
        processingError: null,
      });

      // A new worker claims with leaseMs = 30_000
      const recoveryClaim = await claimTelegramUpdate(db, {
        updateId,
        updateType: "message",
        attemptId: "recovery-worker-attempt",
        leaseMs: 30_000,
      });

      expect(recoveryClaim.status).toBe("claimed");
      if (recoveryClaim.status === "claimed") {
        expect(recoveryClaim.attemptId).toBe("recovery-worker-attempt");
      }
    });
  });

  describe("Complete Error Boundaries and Privacy", () => {
    it("never leaks synthetic secrets, raw SQL, or customer text in HTTP responses", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 666777888;

      const syntheticSecret = "SK_LIVE_SECRET_API_KEY_998877";
      const syntheticSql = "SELECT * FROM admin_credentials WHERE id = 1";
      const customerSecretText = "Confidential customer inquiry message";

      // Transport throws an error embedding synthetic secrets and SQL
      fakeTransport.failSendWith = `Failed ${syntheticSql} with secret ${syntheticSecret}`;

      const req = createWebhookRequest(
        {
          update_id: 7001,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: { id: customerTelegramId, is_bot: false, first_name: "PrivacyUser" },
            text: `/start ${customerSecretText}`,
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      // Public status 500
      expect(res.status).toBe(500);

      const resJson = await res.json();
      const resString = JSON.stringify(resJson);

      // Must be fixed error message
      expect(resJson).toEqual({ error: "Internal server error" });
      expect(resString).not.toContain(syntheticSecret);
      expect(resString).not.toContain(syntheticSql);
      expect(resString).not.toContain(customerSecretText);

      // Verify stored diagnostic in database also did not leak the secret
      const [storedRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 7001));

      expect(storedRow.processingError).not.toBeNull();
      expect(storedRow.processingError).not.toContain(TEST_BOT_TOKEN);
      expect(storedRow.processingError).not.toContain(TEST_WEBHOOK_SECRET);
    });

    it("does not crash if failure bookkeeping database write itself fails", async () => {
      const fakeTransport = createFakeTelegramTransport();
      fakeTransport.failSendWith = "Delivery failed";

      // Create a mock DB where update throws
      const baseAppDb = asAppDb(testDb!.db);
      const mockDb = {
        ...baseAppDb,
        insert: baseAppDb.insert.bind(baseAppDb),
        select: baseAppDb.select.bind(baseAppDb),
        update: () => {
          throw new Error("Simulated database failure during error recording");
        },
      } as unknown as ReturnType<typeof asAppDb>;

      const req = createWebhookRequest(
        {
          update_id: 7002,
          message: {
            message_id: 1,
            chat: { id: 12345, type: "private" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: mockDb,
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      // Still cleanly returns fixed 500 without crashing the process
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
    });
  });

  describe("Runtime Input Validation & Non-Start Text Guidance", () => {
    it("rejects non-integer, negative, or overflow update_id with fixed 400", async () => {
      const fakeTransport = createFakeTelegramTransport();

      for (const badId of [-1, 0, 12.34, "123", null, undefined, Infinity]) {
        const req = createWebhookRequest(
          {
            update_id: badId,
            message: { message_id: 1, chat: { id: 123, type: "private" } },
          },
          TEST_WEBHOOK_SECRET,
        );

        const res = await handleTelegramWebhookRequest(req, {
          db: asAppDb(testDb!.db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Bad request" });
      }
    });

    it("routes text starting with '/startxyz' or plain conversation to guidance, not catalog start", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 555444333;

      const nonStartReq = createWebhookRequest(
        {
          update_id: 8001,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: { id: customerTelegramId, is_bot: false, first_name: "Curious" },
            text: "/starting a conversation",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(nonStartReq, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages[0].text).toBe(
        "To browse our catalog, please send /start",
      );
    });

    it("returns 500 and records failure if sending guidance message fails", async () => {
      const fakeTransport = createFakeTelegramTransport();
      fakeTransport.failSendWith = "Telegram guidance send failed";

      const req = createWebhookRequest(
        {
          update_id: 8002,
          message: {
            message_id: 1,
            chat: { id: 555444333, type: "private" },
            from: { id: 555444333, is_bot: false, first_name: "Curious" },
            text: "Hello, what do you sell?",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });

      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 8002));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toContain("Telegram guidance send failed");
    });
  });

  describe("Root Catalog Pagination, Safeguards, and Text Bounding", () => {
    it("paginates root categories when total count exceeds page size (10)", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 999888777;

      // Seed 12 root categories
      for (let i = 1; i <= 12; i++) {
        await db.insert(category).values({
          slug: `root-cat-page-test-${i}`,
          isActive: true,
          sortOrder: 100 + i,
        });
      }

      // Pre-select language for customer so /start immediately renders root catalog
      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"))
        .limit(1);

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "RootPager",
        selectedLanguageId: enLang.id,
      });

      // Customer sends /start
      const reqStart = createWebhookRequest(
        {
          update_id: 9001,
          message: {
            message_id: 1,
            chat: { id: customerTelegramId, type: "private" },
            from: { id: customerTelegramId, is_bot: false, first_name: "RootPager" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const resStart = await handleTelegramWebhookRequest(reqStart, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resStart.status).toBe(200);

      // Check first page keyboard has 10 category rows + 1 pagination row with Next
      const msg1 = fakeTransport.sentMessages[0];
      const keyboard1 = msg1.replyMarkup?.inline_keyboard ?? [];
      const nextBtn = keyboard1.flat().find((btn) => btn.callback_data === "c:root:2");
      expect(nextBtn).toBeDefined();

      fakeTransport.clear();

      // Tap Next button (c:root:2)
      const reqPage2 = createWebhookRequest(
        {
          update_id: 9002,
          callback_query: {
            id: "cb_root_p2",
            from: { id: customerTelegramId, is_bot: false, first_name: "RootPager" },
            message: { message_id: 1, chat: { id: customerTelegramId, type: "private" } },
            data: "c:root:2",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const resPage2 = await handleTelegramWebhookRequest(reqPage2, {
        db: asAppDb(testDb!.db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resPage2.status).toBe(200);

      const msg2 = fakeTransport.editedMessages[0];
      const keyboard2 = msg2.replyMarkup?.inline_keyboard ?? [];
      const prevBtn = keyboard2.flat().find((btn) => btn.callback_data === "c:root");
      expect(prevBtn).toBeDefined();
    });

    it("bounds message text to 4096 code units without breaking surrogate pairs", () => {
      // Normal short text
      expect(boundMessageText("Hello world")).toBe("Hello world");

      // Text of exact length 4096
      const exact4096 = "A".repeat(4096);
      expect(boundMessageText(exact4096)).toBe(exact4096);

      // Text longer than 4096
      const over4096 = "A".repeat(5000);
      const bounded = boundMessageText(over4096);
      expect(bounded).toHaveLength(4096);

      // Text where char 4095 is a high surrogate of an emoji
      // Emoji 😀 is represented in UTF-16 by surrogate pair: \uD83D \uDE00
      const emoji = "😀";
      expect(emoji).toHaveLength(2);

      const prefix = "A".repeat(4095);
      const withEmoji = prefix + emoji; // length 4097, index 4095 is high surrogate \uD83D
      const safeBounded = boundMessageText(withEmoji);

      // Must be trimmed to 4095 to avoid leaving an unpaired high surrogate!
      expect(safeBounded).toHaveLength(4095);
      expect(safeBounded).toBe(prefix);
    });
  });
});

