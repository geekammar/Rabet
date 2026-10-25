import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";

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
import {
  createFakeTelegramTransport,
  StandardExecutionDeadline,
} from "@/lib/telegram/transport";
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

      // Phase 07: START_INQUIRY confirms the inquiry and creates inquiry record
      expect(deferredRes.status).toBe(200);
      expect(fakeTransport.editedMessages).toHaveLength(1);
      const inqMsg = fakeTransport.editedMessages[0];
      expect(inqMsg.text).toContain("Thank you for your inquiry about Pro Portfolio Template");
      expect(inqMsg.text).toContain("Reference: INQ-");

      // Verify answerCallbackQuery was called
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);

      // Inquiry was created
      const inquiries = await testDb!.db.select().from(inquiry);
      expect(inquiries).toHaveLength(1);
      expect(inquiries[0].productId).toBe(testProductId);
      expect(inquiries[0].status).toBe("open");

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
      fakeTransport.failSendKind = "timeout";

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
      expect(failedRow.processingError).toBe("category=timeout");

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
      expect(storedRow.processingError).toBe("category=api_error");
      expect(storedRow.processingError).not.toContain(TEST_BOT_TOKEN);
      expect(storedRow.processingError).not.toContain(TEST_WEBHOOK_SECRET);
      expect(storedRow.processingError).not.toContain(syntheticSecret);
      expect(storedRow.processingError).not.toContain(syntheticSql);
      expect(storedRow.processingError).not.toContain(customerSecretText);
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
            from: { id: 12345, is_bot: false, first_name: "Test" },
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
            message: {
              message_id: 1,
              from: { id: 123, is_bot: false, first_name: "Test" },
              chat: { id: 123, type: "private" },
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
      expect(row.processingError).toBe("category=api_error");
    });

    it("rejects malformed from.id, non-string text, or contradictory shapes upfront with 400 and zero writes", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const db = asAppDb(testDb!.db);
      const testCustomerId = 818181;

      const invalidPayloads = [
        // Missing from
        {
          update_id: 8101,
          message: {
            message_id: 1,
            chat: { id: testCustomerId, type: "private" },
            text: "/start",
          },
        },
        // Fractional from.id
        {
          update_id: 8102,
          message: {
            message_id: 1,
            from: { id: 818181.67, is_bot: false, first_name: "Test" },
            chat: { id: testCustomerId, type: "private" },
            text: "/start",
          },
        },
        // Negative from.id
        {
          update_id: 8103,
          message: {
            message_id: 1,
            from: { id: -1, is_bot: false, first_name: "Test" },
            chat: { id: testCustomerId, type: "private" },
            text: "/start",
          },
        },
        // Unsafe integer from.id
        {
          update_id: 8104,
          message: {
            message_id: 1,
            from: { id: Number.MAX_SAFE_INTEGER + 10, is_bot: false, first_name: "Test" },
            chat: { id: testCustomerId, type: "private" },
            text: "/start",
          },
        },
        // Non-string text
        {
          update_id: 8105,
          message: {
            message_id: 1,
            from: { id: testCustomerId, is_bot: false, first_name: "Test" },
            chat: { id: testCustomerId, type: "private" },
            text: 99999,
          },
        },
        // Contradictory shapes: both message and callback_query present
        {
          update_id: 8106,
          message: {
            message_id: 1,
            from: { id: testCustomerId, is_bot: false, first_name: "Test" },
            chat: { id: testCustomerId, type: "private" },
            text: "/start",
          },
          callback_query: {
            id: "cb_contradict",
            from: { id: testCustomerId, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: testCustomerId, type: "private" } },
            data: "home",
          },
        },
      ];

      for (const payload of invalidPayloads) {
        const req = createWebhookRequest(payload, TEST_WEBHOOK_SECRET);
        const res = await handleTelegramWebhookRequest(req, {
          db,
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Bad request" });
      }

      // Assert zero database rows created in telegram_update
      const updateRows = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(inArray(telegramUpdate.updateId, [8101, 8102, 8103, 8104, 8105, 8106]));
      expect(updateRows).toHaveLength(0);

      // Assert zero customer records created for customer 818181
      const customerRows = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, testCustomerId));
      expect(customerRows).toHaveLength(0);

      // Assert zero outbound transport calls
      expect(fakeTransport.sentMessages).toHaveLength(0);
      expect(fakeTransport.editedMessages).toHaveLength(0);
      expect(fakeTransport.answeredCallbacks).toHaveLength(0);
    });

    it("rejects malformed callback token grammar upfront with 400 and zero writes", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const db = asAppDb(testDb!.db);

      const invalidCallbackPayloads = [
        {
          update_id: 8201,
          callback_query: {
            id: "cb_inv_1",
            from: { id: 777666, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: 777666, type: "private" } },
            data: "unknown_prefix:foo",
          },
        },
        {
          update_id: 8202,
          callback_query: {
            id: "cb_inv_2",
            from: { id: 777666, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: 777666, type: "private" } },
            data: "c:not-a-valid-uuid",
          },
        },
        {
          update_id: 8203,
          callback_query: {
            id: "cb_inv_3",
            from: { id: 777666, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: 777666, type: "private" } },
            data: "p:not-a-valid-uuid",
          },
        },
        {
          update_id: 8204,
          callback_query: {
            id: "cb_inv_4",
            from: { id: 777666, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: 777666, type: "private" } },
            data: "a:invalid_kind:123",
          },
        },
        {
          update_id: 8205,
          callback_query: {
            id: "cb_inv_5",
            from: { id: 777666, is_bot: false, first_name: "Test" },
            message: { message_id: 1, chat: { id: 777666, type: "private" } },
            data: "c:root:notanumber",
          },
        },
      ];

      for (const payload of invalidCallbackPayloads) {
        const req = createWebhookRequest(payload, TEST_WEBHOOK_SECRET);
        const res = await handleTelegramWebhookRequest(req, {
          db,
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Bad request" });
      }

      // Assert zero database rows created
      const updateRows = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(inArray(telegramUpdate.updateId, [8201, 8202, 8203, 8204, 8205]));
      expect(updateRows).toHaveLength(0);

      const customerRows = await testDb!.db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, 777666));
      expect(customerRows).toHaveLength(0);

      expect(fakeTransport.sentMessages).toHaveLength(0);
      expect(fakeTransport.editedMessages).toHaveLength(0);
      expect(fakeTransport.answeredCallbacks).toHaveLength(0);
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

  describe("Attempt Lifecycle, In-Flight Responses, and Rate Limiting", () => {
    it("returns HTTP 429 Retry-After when update is in-flight, and recovers if owner fails", async () => {
      const updateId = 8301;
      const customerTelegramId = 444555666;
      const fakeTransport = createFakeTelegramTransport();
      const db = asAppDb(testDb!.db);

      const payload = {
        update_id: updateId,
        message: {
          message_id: 10,
          from: { id: customerTelegramId, is_bot: false, first_name: "InFlightTest" },
          chat: { id: customerTelegramId, type: "private" },
          text: "/start",
        },
      };

      // Set up a promise to block the first worker inside its transport call
      let unblockFirstWorker!: (result: {
        ok: false;
        error: string;
        errorKind: "network_error";
      }) => void;
      const firstWorkerGate = new Promise<{
        ok: false;
        error: string;
        errorKind: "network_error";
      }>((resolve) => {
        unblockFirstWorker = resolve;
      });

      // Custom transport for worker 1 that hangs on sendMessage until unblocked
      let worker1Started = false;
      let notifyWorker1Started!: () => void;
      const worker1StartedPromise = new Promise<void>((resolve) => {
        notifyWorker1Started = resolve;
      });

      const blockingTransport = {
        ...fakeTransport,
        async sendMessage() {
          worker1Started = true;
          notifyWorker1Started();
          return await firstWorkerGate;
        },
      };

      // Start Worker 1 (held in-flight)
      const worker1Promise = handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db,
          transport: blockingTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );

      // Wait until worker 1 has claimed the update and entered transport.sendMessage
      await worker1StartedPromise;
      expect(worker1Started).toBe(true);

      // Worker 2 delivers duplicate update while Worker 1 is still in-flight
      const resWorker2 = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db,
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );

      // Worker 2 receives deliberate retryable status HTTP 429 with Retry-After header
      expect(resWorker2.status).toBe(429);
      expect(resWorker2.headers.get("retry-after")).toBe("5");
      expect(await resWorker2.json()).toEqual({ error: "Update is currently in flight" });

      // Now unblock Worker 1 with a failure (e.g. simulated network crash during send)
      unblockFirstWorker({
        ok: false,
        error: "Network crash during send",
        errorKind: "network_error",
      });
      const resWorker1 = await worker1Promise;
      expect(resWorker1.status).toBe(500);

      // Stored record should show attempt failure, not completion
      const [failedRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(failedRow.processedAt).toBeNull();
      expect(failedRow.processingError).toBe("category=network_error");

      // Worker 3 arrives as retry: now succeeds because previous attempt failed
      const resWorker3 = await handleTelegramWebhookRequest(
        createWebhookRequest(payload, TEST_WEBHOOK_SECRET),
        {
          db,
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        },
      );

      expect(resWorker3.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);

      const [completedRow] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(completedRow.processedAt).not.toBeNull();
      expect(completedRow.processingError).toBeNull();
    });

    it("enforces execution budget and rejects outbound calls after budget expiry", async () => {
      const db = asAppDb(testDb!.db);
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 555666777;

      let currentTime = 1000;
      // Budget of 100ms starting at 1000
      const deadline = new StandardExecutionDeadline(100, () => currentTime);

      // Advance clock during execution so budget expires while attempting outbound send
      fakeTransport.sendMessage = async () => {
        currentTime = 1200; // Elapsed 200ms > 100ms budget
        deadline.checkOrThrow();
        return { ok: true, messageId: 1 };
      };

      const req = createWebhookRequest(
        {
          update_id: 8401,
          message: {
            message_id: 20,
            from: { id: customerTelegramId, is_bot: false, first_name: "BudgetTest" },
            chat: { id: customerTelegramId, type: "private" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db,
        transport: fakeTransport,
        deadline,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.json()).toEqual({ error: "Service Unavailable" });

      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 8401));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=budget_exceeded");
    });

    it("treats completion fencing rejection as failure rather than acknowledging success", async () => {
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 666777111;

      // Mock DB where update returns no updated row (simulating another worker took ownership)
      const baseAppDb = asAppDb(testDb!.db);
      const mockDb = {
        ...baseAppDb,
        insert: baseAppDb.insert.bind(baseAppDb),
        select: baseAppDb.select.bind(baseAppDb),
        update: (...args: Parameters<typeof baseAppDb.update>) => {
          const updateBuilder = baseAppDb.update(...args);
          return {
            ...updateBuilder,
            set: (...setArgs: Parameters<typeof updateBuilder.set>) => {
              const setBuilder = updateBuilder.set(...setArgs);
              return {
                ...setBuilder,
                where: () => {
                  // Return empty array to simulate fencing failure
                  return Object.assign(Promise.resolve([]), {
                    returning: async () => [],
                  });
                },
              };
            },
          };
        },
      } as unknown as ReturnType<typeof asAppDb>;

      const req = createWebhookRequest(
        {
          update_id: 8501,
          message: {
            message_id: 30,
            from: { id: customerTelegramId, is_bot: false, first_name: "FencingTest" },
            chat: { id: customerTelegramId, type: "private" },
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

      // Must NOT return 200 { ok: true }
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
    });

    it("handles answerCallbackQuery failure by failing the attempt cleanly", async () => {
      const db = asAppDb(testDb!.db);
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 777111222;

      // Pre-seed customer
      await testDb!.db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "AnswerFailUser",
      });

      fakeTransport.failAnswerWith = "Callback query expired";
      fakeTransport.failAnswerKind = "api_error";

      const req = createWebhookRequest(
        {
          update_id: 8601,
          callback_query: {
            id: "cb_fail_answer_1",
            from: { id: customerTelegramId, is_bot: false, first_name: "AnswerFailUser" },
            message: { message_id: 40, chat: { id: customerTelegramId, type: "private" } },
            data: "home",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db,
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });

      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 8601));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=api_error");
    });

    it("propagates rate-limit retry_after to client response and stores in safe diagnostic", async () => {
      const db = asAppDb(testDb!.db);
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 888222333;

      fakeTransport.failSendWith = "Too Many Requests";
      fakeTransport.failSendKind = "rate_limited";
      fakeTransport.failSendRetryAfter = 9;

      const req = createWebhookRequest(
        {
          update_id: 8701,
          message: {
            message_id: 50,
            from: { id: customerTelegramId, is_bot: false, first_name: "RateLimitUser" },
            chat: { id: customerTelegramId, type: "private" },
            text: "/start",
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db,
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("9");
      expect(await res.json()).toEqual({ error: "Too Many Requests" });

      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 8701));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=rate_limited;status=429;retry_after=9");
    });
  });

  describe("Long Message Content Preservation and Chunking", () => {
    it("delivers long catalog text in sequential chunks <= 4096 with navigation on final chunk", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 999333444;

      let [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      if (!enLang) {
        [enLang] = await db
          .insert(language)
          .values({
            code: "en",
            label: "English",
            textDirection: "ltr",
            isEnabled: true,
          })
          .returning();
      }

      const [setting] = await db.select().from(botSetting).where(eq(botSetting.id, 1));
      if (!setting) {
        await db.insert(botSetting).values({
          id: 1,
          defaultLanguageId: enLang.id,
          currency: "USD",
          displayName: "Test Store",
          askForLanguage: false,
        });
      }

      // Seed a category
      const [cat] = await db
        .insert(category)
        .values({
          slug: "long-desc-category",
          isActive: true,
          sortOrder: 999,
        })
        .returning();

      // Seed a product with details > 6000 characters
      const [prod] = await db
        .insert(product)
        .values({
          categoryId: cat.id,
          slug: "long-sku-001",
          price: "199.99",
          isActive: true,
          sortOrder: 1,
        })
        .returning();

      // Seed product actions for SHOW_DETAILS:
      const [menuAction] = await db
        .insert(productAction)
        .values({
          productId: prod.id,
          parentActionId: null,
          actionType: "OPEN_SUBMENU",
          sortOrder: 1,
          isActive: true,
        })
        .returning();

      await db.insert(productActionTranslation).values({
        actionId: menuAction.id,
        languageId: enLang.id,
        label: "Options",
      });

      const [detailsAction] = await db
        .insert(productAction)
        .values({
          productId: prod.id,
          parentActionId: menuAction.id,
          actionType: "SHOW_DETAILS",
          sortOrder: 1,
          isActive: true,
        })
        .returning();

      await db.insert(productActionTranslation).values({
        actionId: detailsAction.id,
        languageId: enLang.id,
        label: "Specifications",
      });

      const tailSignature = "UNIQUE_TAIL_DISCLOSURE_CODE_778899";
      const longDescription =
        "Paragraph 1: " +
        "Important detailed specifications. ".repeat(80) +
        "\n\nParagraph 2: " +
        "Regulatory disclosures and warranty details. ".repeat(80) +
        `\n\nFinal Section: Product summary and verification signature: ${tailSignature}.`;

      expect(longDescription.length).toBeGreaterThan(5000);

      await db.insert(productTranslation).values({
        productId: prod.id,
        languageId: enLang.id,
        name: "Extended Details Product",
        description: longDescription,
      });

      // Pre-select language for customer
      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "ChunkUser",
        selectedLanguageId: enLang.id,
      });

      // Request SHOW_DETAILS via action token
      const req = createWebhookRequest(
        {
          update_id: 8801,
          callback_query: {
            id: "cb_show_dt_long",
            from: { id: customerTelegramId, is_bot: false, first_name: "ChunkUser" },
            message: { message_id: 100, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(detailsAction.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify delivery: chunk 1 edits existing message, subsequent chunks sent via sendMessage
      expect(fakeTransport.editedMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages.length).toBeGreaterThanOrEqual(1);

      const allDelivered = [
        fakeTransport.editedMessages[0],
        ...fakeTransport.sentMessages,
      ];

      // Every chunk must be <= 4096 code units
      for (const msg of allDelivered) {
        expect(msg.text.length).toBeLessThanOrEqual(4096);
      }

      // Reconstructed text matches full generated text
      const reconstructedText = allDelivered.map((m) => m.text).join("");
      expect(reconstructedText).toContain(tailSignature);
      expect(reconstructedText).toContain("Extended Details Product");
      expect(reconstructedText).toContain("Paragraph 1:");
      expect(reconstructedText).toContain("Paragraph 2:");

      // Only the final delivered message contains the navigation keyboard
      for (let i = 0; i < allDelivered.length - 1; i++) {
        expect(allDelivered[i].replyMarkup).toBeUndefined();
      }
      const finalMsg = allDelivered[allDelivered.length - 1];
      expect(finalMsg.replyMarkup?.inline_keyboard).toBeDefined();
      const backBtn = finalMsg.replyMarkup!.inline_keyboard
        .flat()
        .find((btn) => btn.callback_data === tokens.product(prod.id));
      expect(backBtn).toBeDefined();
    });

    it("halts delivery if an intermediate chunk fails and follows attempt failure policy", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 999333555;

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "long-sku-001"));

      const [detailsAction] = await db
        .select()
        .from(productAction)
        .where(
          and(
            eq(productAction.productId, prod.id),
            eq(productAction.actionType, "SHOW_DETAILS"),
          ),
        );

      // Customer
      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "ChunkFailUser",
        selectedLanguageId: enLang.id,
      });

      // Fail on the second chunk (which uses sendMessage)
      fakeTransport.failSendWith = "Delivery failure on secondary chunk";
      fakeTransport.failSendKind = "network_error";

      const req = createWebhookRequest(
        {
          update_id: 8802,
          callback_query: {
            id: "cb_show_dt_fail",
            from: { id: customerTelegramId, is_bot: false, first_name: "ChunkFailUser" },
            message: { message_id: 101, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(detailsAction.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);

      const [row] = await testDb!.db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 8802));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=network_error");
    });
  });

  describe("Callback Retry Recovery, Single-Ack Back Routing, and Callback Validation", () => {
    it("recovers on retry when callback acknowledgement expired but catalog render succeeds", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 88112233;

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "pro-portfolio-template"));

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "RetryUser",
        selectedLanguageId: enLang.id,
      });

      const updateId = 9101;
      const callbackReqPayload = {
        update_id: updateId,
        callback_query: {
          id: "cb_retry_ack_expired",
          from: {
            id: customerTelegramId,
            is_bot: false,
            first_name: "RetryUser",
          },
          message: {
            message_id: 200,
            chat: { id: customerTelegramId, type: "private" },
          },
          data: tokens.product(prod.id),
        },
      };

      // 1. First attempt: answerCallbackQuery succeeds, but editMessageText fails
      fakeTransport.failEditWith = "Transient network disconnect";
      fakeTransport.failEditKind = "network_error";

      const req1 = createWebhookRequest(callbackReqPayload, TEST_WEBHOOK_SECRET);
      const res1 = await handleTelegramWebhookRequest(req1, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res1.status).toBe(500);

      const [attempt1Row] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(attempt1Row.processedAt).toBeNull();
      expect(attempt1Row.processingError).toBe("category=network_error");

      // 2. Second attempt: Telegram redelivers the update.
      // Now, answerCallbackQuery fails with terminal 'query is too old', but editMessageText succeeds.
      fakeTransport.clear();
      fakeTransport.failAnswerWith =
        "Bad Request: query is too old and response timeout expired or query id is invalid";

      const req2 = createWebhookRequest(callbackReqPayload, TEST_WEBHOOK_SECRET);
      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res2.status).toBe(200);

      // Verify update is marked processed and error cleared
      const [attempt2Row] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(attempt2Row.processedAt).not.toBeNull();
      expect(attempt2Row.processingError).toBeNull();

      // Product card content was delivered via editMessageText
      expect(fakeTransport.editedMessages).toHaveLength(1);
      expect(fakeTransport.editedMessages[0].text).toContain("49.99 USD");
    });

    it("does not treat expired callback as success if catalog edit also fails", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 88112234;

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "pro-portfolio-template"));

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "DoubleFailUser",
        selectedLanguageId: enLang.id,
      });

      const updateId = 9102;
      const reqPayload = {
        update_id: updateId,
        callback_query: {
          id: "cb_double_fail",
          from: {
            id: customerTelegramId,
            is_bot: false,
            first_name: "DoubleFailUser",
          },
          message: {
            message_id: 201,
            chat: { id: customerTelegramId, type: "private" },
          },
          data: tokens.product(prod.id),
        },
      };

      // Both callback ack expired AND edit fails
      fakeTransport.failAnswerWith = "Bad Request: query is too old";
      fakeTransport.failEditWith = "Telegram server unavailable";
      fakeTransport.failEditKind = "timeout";

      const req = createWebhookRequest(reqPayload, TEST_WEBHOOK_SECRET);
      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);

      const [row] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=timeout");
    });

    it("halts dispatch and returns 429 when callback acknowledgement is rate-limited", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 88112235;

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "pro-portfolio-template"));

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "RateLimitedUser",
        selectedLanguageId: enLang.id,
      });

      fakeTransport.failAnswerWith = "Too Many Requests: retry after 11";
      fakeTransport.failAnswerKind = "rate_limited";
      fakeTransport.failAnswerRetryAfter = 11;

      const updateId = 9103;
      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_rate_limited",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "RateLimitedUser",
            },
            message: {
              message_id: 202,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.product(prod.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("11");

      // No edits should have occurred
      expect(fakeTransport.editedMessages).toHaveLength(0);

      const [row] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=rate_limited;status=429;retry_after=11");
    });

    it("halts dispatch on network or unknown api error during callback acknowledgement", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 88112236;

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "pro-portfolio-template"));

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "AckFailUser",
        selectedLanguageId: enLang.id,
      });

      fakeTransport.failAnswerWith = "Network socket timeout";
      fakeTransport.failAnswerKind = "timeout";

      const updateId = 9104;
      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_ack_fail",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "AckFailUser",
            },
            message: {
              message_id: 203,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.product(prod.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);
      expect(fakeTransport.editedMessages).toHaveLength(0);

      const [row] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(row.processedAt).toBeNull();
      expect(row.processingError).toBe("category=timeout");
    });

    it("executes Back-routing (b:<actionId>) with exactly 1 callback acknowledgement (no double-ack)", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 88112237;

      const [prod] = await db
        .select()
        .from(product)
        .where(eq(product.slug, "pro-portfolio-template"));

      const [enLang] = await db
        .select()
        .from(language)
        .where(eq(language.code, "en"));

      const [detailsAct] = await db
        .select()
        .from(productAction)
        .where(
          and(
            eq(productAction.productId, prod.id),
            eq(productAction.actionType, "SHOW_DETAILS"),
          ),
        );

      await db.insert(customer).values({
        telegramId: customerTelegramId,
        firstName: "BackNavUser",
        selectedLanguageId: enLang.id,
      });

      // 1. Back from child action (SHOW_DETAILS) -> returns to parent submenu
      const updateId1 = 9105;
      const req1 = createWebhookRequest(
        {
          update_id: updateId1,
          callback_query: {
            id: "cb_back_child",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "BackNavUser",
            },
            message: {
              message_id: 204,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.back(detailsAct.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res1 = await handleTelegramWebhookRequest(req1, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res1.status).toBe(200);
      // Exactly ONE answerCallbackQuery call was made! (no double-ack)
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      expect(fakeTransport.answeredCallbacks[0].callbackQueryId).toBe("cb_back_child");
      // Edited message contains parent submenu
      expect(fakeTransport.editedMessages).toHaveLength(1);
      expect(fakeTransport.editedMessages[0].text).toContain("Choose your customized package options");

      // 2. Back from root action (OPEN_SUBMENU) -> returns to product card
      fakeTransport.clear();
      const [rootAct] = await db
        .select()
        .from(productAction)
        .where(
          and(
            eq(productAction.productId, prod.id),
            isNull(productAction.parentActionId),
          ),
        );

      const updateId2 = 9106;
      const req2 = createWebhookRequest(
        {
          update_id: updateId2,
          callback_query: {
            id: "cb_back_root",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "BackNavUser",
            },
            message: {
              message_id: 204,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.back(rootAct.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res2.status).toBe(200);
      // Exactly ONE answerCallbackQuery call was made! (no double-ack)
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      expect(fakeTransport.answeredCallbacks[0].callbackQueryId).toBe("cb_back_root");
      // Edited message contains product card
      expect(fakeTransport.editedMessages).toHaveLength(1);
      expect(fakeTransport.editedMessages[0].text).toContain("49.99 USD");
    });

    it("rejects callback query with wrong-type optional user fields upfront without DB writes", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const testCases = [
        { field: "last_name", value: 12345 },
        { field: "username", value: true },
        { field: "language_code", value: ["en"] },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const updateId = 9110 + i;
        const fakeUserId = 883300 + i;

        const req = createWebhookRequest(
          {
            update_id: updateId,
            callback_query: {
              id: `cb_bad_user_${i}`,
              from: {
                id: fakeUserId,
                is_bot: false,
                first_name: "TestUser",
                [tc.field]: tc.value,
              },
              message: {
                message_id: 300,
                chat: { id: fakeUserId, type: "private" },
              },
              data: tokens.home(),
            },
          },
          TEST_WEBHOOK_SECRET,
        );

        const res = await handleTelegramWebhookRequest(req, {
          db: asAppDb(db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(400);

        // Zero DB records created
        const updateRows = await db
          .select()
          .from(telegramUpdate)
          .where(eq(telegramUpdate.updateId, updateId));
        expect(updateRows).toHaveLength(0);

        const custRows = await db
          .select()
          .from(customer)
          .where(eq(customer.telegramId, fakeUserId));
        expect(custRows).toHaveLength(0);

        // Zero transport calls
        expect(fakeTransport.answeredCallbacks).toHaveLength(0);
        expect(fakeTransport.editedMessages).toHaveLength(0);
        expect(fakeTransport.sentMessages).toHaveLength(0);
      }
    });

    it("safely ignores callbacks without message (inline-mode queries) before claim/writes", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const fakeUserId = 884400;
      const updateId = 9120;

      // Inline callback query has NO message object
      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_inline_no_msg",
            from: {
              id: fakeUserId,
              is_bot: false,
              first_name: "InlineUser",
            },
            data: tokens.home(),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: true });

      // Zero DB records created
      const updateRows = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(updateRows).toHaveLength(0);

      const custRows = await db
        .select()
        .from(customer)
        .where(eq(customer.telegramId, fakeUserId));
      expect(custRows).toHaveLength(0);

      // Zero transport calls
      expect(fakeTransport.answeredCallbacks).toHaveLength(0);
      expect(fakeTransport.editedMessages).toHaveLength(0);
      expect(fakeTransport.sentMessages).toHaveLength(0);
    });
  });

  describe("Phase 06-B: Non-Conversation Product Action Runtime", () => {
    let enLangId: string;
    let arLangId: string;
    let p6bProductId: string;
    let p6bCatId: string;
    let p6bSubCatId: string;
    let p6bMenuActionId: string;
    let templateActionId: string;
    let templateSubmenuActionId: string;
    let templateFallbackActionId: string;
    let templateInvalidSyntaxActionId: string;
    let templateMissingBodyActionId: string;
    let templateLongActionId: string;
    let urlValidActionId: string;
    let urlHttpActionId: string;
    let urlCredentialsActionId: string;
    let urlMissingActionId: string;
    let navCategoryActionId: string;
    let navProductActionId: string;
    let navNoTargetActionId: string;
    let navInactiveCatActionId: string;
    let navDeletedCatActionId: string;
    let navInactiveProdActionId: string;
    let navInactiveAncestorCatActionId: string;
    let targetCatId: string;
    let targetProdId: string;
    let inactiveCatId: string;
    let deletedCatId: string;
    let inactiveProdId: string;
    let inactiveAncestorParentCatId: string;
    let inactiveAncestorChildCatId: string;

    beforeAll(async () => {
      const db = testDb!.db;

      // 1. Languages setup (retrieve en and ar created in parent suite)
      const langs = await db.select().from(language);
      const en = langs.find((l) => l.code === "en")!;
      const ar = langs.find((l) => l.code === "ar")!;
      enLangId = en.id;
      arLangId = ar.id;

      // 2. Create a dedicated category hierarchy for Phase 06-B
      const [p6bCat] = await db
        .insert(category)
        .values({
          slug: "hardware-6b",
          sortOrder: 10,
          isActive: true,
        })
        .returning();
      p6bCatId = p6bCat.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: p6bCatId,
          languageId: enLangId,
          name: "Hardware Devices",
          description: "Physical devices and components",
        },
        {
          categoryId: p6bCatId,
          languageId: arLangId,
          name: "أجهزة وعتاد",
          description: "عتاد مادي وملحقات",
        },
      ]);

      const [p6bSubCat] = await db
        .insert(category)
        .values({
          parentId: p6bCatId,
          slug: "keyboards-6b",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      p6bSubCatId = p6bSubCat.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: p6bSubCatId,
          languageId: enLangId,
          name: "Mechanical Keyboards",
          description: "Custom mechanical keyboards",
        },
        {
          categoryId: p6bSubCatId,
          languageId: arLangId,
          name: "لوحات مفاتيح ميكانيكية",
          description: "لوحات مخصصة",
        },
      ]);

      // 3. Create a dedicated product
      const [p6bProd] = await db
        .insert(product)
        .values({
          categoryId: p6bSubCatId,
          slug: "custom-keyboard-pro",
          price: "129.50",
          isActive: true,
          sortOrder: 1,
        })
        .returning();
      p6bProductId = p6bProd.id;

      await db.insert(productTranslation).values([
        {
          productId: p6bProductId,
          languageId: enLangId,
          name: "Custom Keyboard Pro",
          description: "Premium mechanical keyboard with hot-swappable switches.",
          details: "Aluminum case, RGB backlighting, custom stabilizers.",
        },
        {
          productId: p6bProductId,
          languageId: arLangId,
          name: "لوحة مفاتيح احترافية مخصصة",
          description: "لوحة مفاتيح ميكانيكية فاخرة بمفاتيح قابلة للتبديل.",
          details: "هيكل ألمنيوم، إضاءة RGB، مثبتات مخصصة.",
        },
      ]);

      // 4. Root submenu for Phase 06-B
      const [menuAct] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_SUBMENU",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      p6bMenuActionId = menuAct.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: p6bMenuActionId,
          languageId: enLangId,
          label: "More Options",
          menuText: "Choose a sub-action:",
        },
        {
          actionId: p6bMenuActionId,
          languageId: arLangId,
          label: "المزيد من الخيارات",
          menuText: "اختر إجراء فرعي:",
        },
      ]);

      // 5. SEND_TEMPLATE_MESSAGE Actions:
      // A. Root template action with all 4 placeholders
      const [t1] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 2,
          isActive: true,
        })
        .returning();
      templateActionId = t1.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: templateActionId,
          languageId: enLangId,
          label: "Request Invoice",
          templateBody:
            "Hello {{customer_name}}, {{product_name}} is {{price}} at {{store_name}}.",
        },
        {
          actionId: templateActionId,
          languageId: arLangId,
          label: "طلب فاتورة",
          templateBody:
            "مرحباً {{customer_name}}، {{product_name}} بسعر {{price}} في {{store_name}}.",
        },
      ]);

      // B. Child template action in submenu
      const [tSub] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          parentActionId: p6bMenuActionId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 1,
          isActive: true,
        })
        .returning();
      templateSubmenuActionId = tSub.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: templateSubmenuActionId,
          languageId: enLangId,
          label: "Get Quick Quote",
          templateBody: "Quote for {{customer_name}}: {{product_name}} - {{price}}.",
        },
      ]);

      // C. Template with body fallback (Arabic row has label but whitespace body)
      const [tFb] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 3,
          isActive: true,
        })
        .returning();
      templateFallbackActionId = tFb.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: templateFallbackActionId,
          languageId: enLangId,
          label: "Warranty Info",
          templateBody:
            "Warranty for {{product_name}} at {{store_name}}: 2 years full coverage.",
        },
        {
          actionId: templateFallbackActionId,
          languageId: arLangId,
          label: "معلومات الضمان",
          templateBody: "   ", // whitespace only! Must fall back to English
        },
      ]);

      // D. Template with invalid syntax (triple braces)
      const [tInv] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 4,
          isActive: true,
        })
        .returning();
      templateInvalidSyntaxActionId = tInv.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: templateInvalidSyntaxActionId,
          languageId: enLangId,
          label: "Broken Template",
          templateBody: "Malformed {{{price}}}",
        },
      ]);

      // E. Template with missing body (null body in all languages)
      const [tMiss] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 5,
          isActive: true,
        })
        .returning();
      templateMissingBodyActionId = tMiss.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: templateMissingBodyActionId,
          languageId: enLangId,
          label: "No Body Action",
          templateBody: null,
        },
      ]);

      // F. Template that expands to > 4096 characters
      const [tLong] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "SEND_TEMPLATE_MESSAGE",
          sortOrder: 6,
          isActive: true,
        })
        .returning();
      templateLongActionId = tLong.id;

      const longBodyPrefix = "Detailed terms:\n\n" + "X".repeat(3950) + "\n\n";
      await db.insert(productActionTranslation).values([
        {
          actionId: templateLongActionId,
          languageId: enLangId,
          label: "Long Terms",
          templateBody: `${longBodyPrefix}Item: {{product_name}} | Customer: {{customer_name}} | Price: {{price}} | Store: {{store_name}}`,
        },
      ]);

      // 6. OPEN_URL Actions:
      // A. Valid HTTPS URL
      const [uValid] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_URL",
          url: "https://docs.example.com/guide/keyboards",
          sortOrder: 7,
          isActive: true,
        })
        .returning();
      urlValidActionId = uValid.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: urlValidActionId,
          languageId: enLangId,
          label: "Online Manual",
        },
        {
          actionId: urlValidActionId,
          languageId: arLangId,
          label: "دليل الاستخدام",
        },
      ]);

      // B. URL with whitespace (rejected by WHATWG / validation)
      const [uWhitespace] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_URL",
          url: "https://example.com/with space",
          sortOrder: 8,
          isActive: true,
        })
        .returning();
      urlHttpActionId = uWhitespace.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: urlHttpActionId,
          languageId: enLangId,
          label: "Whitespace Link",
        },
      ]);

      // C. URL with embedded credentials
      const [uCreds] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_URL",
          url: "https://user:pass@example.com/secret",
          sortOrder: 9,
          isActive: true,
        })
        .returning();
      urlCredentialsActionId = uCreds.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: urlCredentialsActionId,
          languageId: enLangId,
          label: "Credentials Link",
        },
      ]);

      // D. Missing URL (null)
      const [uMiss] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_URL",
          url: null,
          sortOrder: 10,
          isActive: true,
        })
        .returning();
      urlMissingActionId = uMiss.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: urlMissingActionId,
          languageId: enLangId,
          label: "Missing Link",
        },
      ]);

      // 7. NAVIGATE_CATALOG Actions:
      // Valid target category:
      const [tCat] = await db
        .insert(category)
        .values({
          slug: "accessories-6b",
          sortOrder: 20,
          isActive: true,
        })
        .returning();
      targetCatId = tCat.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: targetCatId,
          languageId: enLangId,
          name: "Accessories",
          description: "Keyboard accessories and cables",
        },
        {
          categoryId: targetCatId,
          languageId: arLangId,
          name: "إكسسوارات",
          description: "ملحقات وكابلات",
        },
      ]);

      // Valid target product:
      const [tProd] = await db
        .insert(product)
        .values({
          categoryId: targetCatId,
          slug: "custom-usb-c-cable",
          price: "19.99",
          isActive: true,
          sortOrder: 1,
        })
        .returning();
      targetProdId = tProd.id;

      await db.insert(productTranslation).values([
        {
          productId: targetProdId,
          languageId: enLangId,
          name: "Coiled USB-C Cable",
          description: "Aviator connector coiled cable.",
        },
        {
          productId: targetProdId,
          languageId: arLangId,
          name: "كابل USB-C حلزوني",
          description: "كابل حلزوني مع موصل طيران.",
        },
      ]);

      // Inactive target category:
      const [inactCat] = await db
        .insert(category)
        .values({
          slug: "secret-cat-6b",
          sortOrder: 21,
          isActive: false,
        })
        .returning();
      inactiveCatId = inactCat.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: inactiveCatId,
          languageId: enLangId,
          name: "Hidden Category Name",
          description: "Secret description",
        },
      ]);

      // Deleted target category:
      const [delCat] = await db
        .insert(category)
        .values({
          slug: "deleted-cat-6b",
          sortOrder: 22,
          isActive: true,
          deletedAt: new Date(),
        })
        .returning();
      deletedCatId = delCat.id;

      // Inactive target product:
      const [inactProd] = await db
        .insert(product)
        .values({
          categoryId: targetCatId,
          slug: "secret-product-6b",
          price: "999.00",
          isActive: false,
          sortOrder: 2,
        })
        .returning();
      inactiveProdId = inactProd.id;

      await db.insert(productTranslation).values([
        {
          productId: inactiveProdId,
          languageId: enLangId,
          name: "Top Secret Prototype",
          description: "Confidential prototype",
        },
      ]);

      // Category with inactive parent:
      const [inactParent] = await db
        .insert(category)
        .values({
          slug: "inactive-parent-6b",
          sortOrder: 23,
          isActive: false,
        })
        .returning();
      inactiveAncestorParentCatId = inactParent.id;

      const [inactChild] = await db
        .insert(category)
        .values({
          parentId: inactiveAncestorParentCatId,
          slug: "child-of-inactive-6b",
          sortOrder: 1,
          isActive: true, // child active, but parent is inactive
        })
        .returning();
      inactiveAncestorChildCatId = inactChild.id;

      await db.insert(categoryTranslation).values([
        {
          categoryId: inactiveAncestorChildCatId,
          languageId: enLangId,
          name: "Orphaned Active Subcategory",
        },
      ]);

      // Action: Navigate to valid category
      const [navCat] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateCategoryId: targetCatId,
          sortOrder: 11,
          isActive: true,
        })
        .returning();
      navCategoryActionId = navCat.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navCategoryActionId,
          languageId: enLangId,
          label: "View Accessories",
        },
        {
          actionId: navCategoryActionId,
          languageId: arLangId,
          label: "عرض الإكسسوارات",
        },
      ]);

      // Action: Navigate to valid product
      const [navProd] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateProductId: targetProdId,
          sortOrder: 12,
          isActive: true,
        })
        .returning();
      navProductActionId = navProd.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navProductActionId,
          languageId: enLangId,
          label: "Buy Coiled Cable",
        },
        {
          actionId: navProductActionId,
          languageId: arLangId,
          label: "شراء الكابل الحلزوني",
        },
      ]);

      // Action: Navigate with no targets
      const [navNoTarget] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateCategoryId: null,
          navigateProductId: null,
          sortOrder: 13,
          isActive: true,
        })
        .returning();
      navNoTargetActionId = navNoTarget.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navNoTargetActionId,
          languageId: enLangId,
          label: "No Target Action",
        },
      ]);

      // Action: Navigate to inactive category
      const [navInactCat] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateCategoryId: inactiveCatId,
          sortOrder: 14,
          isActive: true,
        })
        .returning();
      navInactiveCatActionId = navInactCat.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navInactiveCatActionId,
          languageId: enLangId,
          label: "Go to Inactive Category",
        },
      ]);

      // Action: Navigate to deleted category
      const [navDelCat] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateCategoryId: deletedCatId,
          sortOrder: 15,
          isActive: true,
        })
        .returning();
      navDeletedCatActionId = navDelCat.id;

      // Action: Navigate to inactive product
      const [navInactProd] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateProductId: inactiveProdId,
          sortOrder: 16,
          isActive: true,
        })
        .returning();
      navInactiveProdActionId = navInactProd.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navInactiveProdActionId,
          languageId: enLangId,
          label: "Go to Inactive Product",
        },
      ]);

      // Action: Navigate to category with inactive ancestor
      const [navInactAncestor] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "NAVIGATE_CATALOG",
          navigateCategoryId: inactiveAncestorChildCatId,
          sortOrder: 17,
          isActive: true,
        })
        .returning();
      navInactiveAncestorCatActionId = navInactAncestor.id;

      await db.insert(productActionTranslation).values([
        {
          actionId: navInactiveAncestorCatActionId,
          languageId: enLangId,
          label: "Go to Orphaned Cat",
        },
      ]);
    });

    // -------------------------------------------------------------------------
    // 1. SEND_TEMPLATE_MESSAGE Tests
    // -------------------------------------------------------------------------
    it("SEND_TEMPLATE_MESSAGE: uses all 4 real placeholders and delivers sendMessage with navigation on final chunk", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7001;

      const req = createWebhookRequest(
        {
          update_id: 20001,
          callback_query: {
            id: "cb_tpl_1",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Tariq",
              last_name: "Mansour",
            },
            message: {
              message_id: 10,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      // Delivered via sendMessage (bot response to customer in chat), not editMessageText
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.editedMessages).toHaveLength(0);

      const sent = fakeTransport.sentMessages[0];
      expect(sent.chatId).toBe(customerTelegramId);
      // Expected placeholder substitution:
      // {{store_name}} -> Acme Digital Store
      // {{product_name}} -> Custom Keyboard Pro
      // {{customer_name}} -> Tariq Mansour
      // {{price}} -> 129.50 USD
      expect(sent.text).toBe(
        "Hello Tariq Mansour, Custom Keyboard Pro is 129.50 USD at Acme Digital Store.",
      );

      // Navigation: Back returns to product (root action), Return to Product is absent, Home is present
      expect(sent.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "◀ Back", callback_data: tokens.product(p6bProductId) }],
        [{ text: "🏠 Home", callback_data: tokens.home() }],
      ]);
    });

    it("SEND_TEMPLATE_MESSAGE in submenu: navigation includes Return to Product and Back returns to submenu", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7002;

      const req = createWebhookRequest(
        {
          update_id: 20002,
          callback_query: {
            id: "cb_tpl_sub",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Layla",
            },
            message: {
              message_id: 11,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateSubmenuActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const sent = fakeTransport.sentMessages[0];
      expect(sent.text).toBe("Quote for Layla: Custom Keyboard Pro - 129.50 USD.");

      // In submenu: Back points to submenu, Return to Product points to product
      expect(sent.replyMarkup?.inline_keyboard).toEqual([
        [{ text: "◀ Back", callback_data: tokens.action(p6bMenuActionId) }],
        [{ text: "📦 Return to Product", callback_data: tokens.product(p6bProductId) }],
        [{ text: "🏠 Home", callback_data: tokens.home() }],
      ]);
    });

    it("SEND_TEMPLATE_MESSAGE: uses preferred body when present in customer language", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7003;

      // Select Arabic language for this customer
      const langs = await db.select().from(language);
      const ar = langs.find((l) => l.code === "ar")!;
      await db
        .insert(customer)
        .values({
          telegramId: customerTelegramId,
          selectedLanguageId: ar.id,
        })
        .onConflictDoUpdate({
          target: customer.telegramId,
          set: { selectedLanguageId: ar.id },
        });

      const req = createWebhookRequest(
        {
          update_id: 20003,
          callback_query: {
            id: "cb_tpl_ar",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "سارة",
              last_name: "أحمد",
            },
            message: {
              message_id: 12,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const sent = fakeTransport.sentMessages[0];
      expect(sent.text).toBe(
        "مرحباً سارة أحمد، لوحة مفاتيح احترافية مخصصة بسعر 129.50 USD في Acme Digital Store.",
      );
      // Navigation buttons in Arabic
      expect(sent.replyMarkup?.inline_keyboard[0][0].text).toBe("◀ رجوع");
      expect(sent.replyMarkup?.inline_keyboard[1][0].text).toBe("🏠 الرئيسية");
    });

    it("SEND_TEMPLATE_MESSAGE: falls back when optional-language body is whitespace, even if its label exists", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7004;

      // Customer language is Arabic
      const langs = await db.select().from(language);
      const ar = langs.find((l) => l.code === "ar")!;
      await db
        .insert(customer)
        .values({
          telegramId: customerTelegramId,
          selectedLanguageId: ar.id,
        })
        .onConflictDoUpdate({
          target: customer.telegramId,
          set: { selectedLanguageId: ar.id },
        });

      const req = createWebhookRequest(
        {
          update_id: 20004,
          callback_query: {
            id: "cb_tpl_fb",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "خالد",
            },
            message: {
              message_id: 13,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateFallbackActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const sent = fakeTransport.sentMessages[0];
      // Body fell back to English default, but product_name used Arabic customer translation
      expect(sent.text).toBe(
        "Warranty for لوحة مفاتيح احترافية مخصصة at Acme Digital Store: 2 years full coverage.",
      );
    });

    it("SEND_TEMPLATE_MESSAGE: supports Arabic-default store and generic customer fallback", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7005;

      const langs = await db.select().from(language);
      const en = langs.find((l) => l.code === "en")!;
      const ar = langs.find((l) => l.code === "ar")!;

      // Temporarily switch bot_setting defaultLanguageId to Arabic
      await db
        .update(botSetting)
        .set({ defaultLanguageId: ar.id })
        .where(eq(botSetting.id, 1));

      try {
        // Customer with NO first or last name
        const req = createWebhookRequest(
          {
            update_id: 20005,
            callback_query: {
              id: "cb_tpl_ar_default",
              from: {
                id: customerTelegramId,
                is_bot: false,
                first_name: "   ", // whitespace only
              },
              message: {
                message_id: 14,
                chat: { id: customerTelegramId, type: "private" },
              },
              data: tokens.action(templateActionId),
            },
          },
          TEST_WEBHOOK_SECRET,
        );

        const res = await handleTelegramWebhookRequest(req, {
          db: asAppDb(db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(200);
        expect(fakeTransport.sentMessages).toHaveLength(1);
        const sent = fakeTransport.sentMessages[0];
        // Arabic customer fallback "عميلنا العزيز" substituted
        expect(sent.text).toBe(
          "مرحباً عميلنا العزيز، لوحة مفاتيح احترافية مخصصة بسعر 129.50 USD في Acme Digital Store.",
        );
      } finally {
        // Restore defaultLanguageId to English
        await db
          .update(botSetting)
          .set({ defaultLanguageId: en.id })
          .where(eq(botSetting.id, 1));
      }
    });

    it("SEND_TEMPLATE_MESSAGE: uses English generic fallback when customer has no name in English context", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7006;

      const req = createWebhookRequest(
        {
          update_id: 20006,
          callback_query: {
            id: "cb_tpl_en_noname",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "",
            },
            message: {
              message_id: 15,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const sent = fakeTransport.sentMessages[0];
      // English generic fallback "Customer" substituted
      expect(sent.text).toBe(
        "Hello Customer, Custom Keyboard Pro is 129.50 USD at Acme Digital Store.",
      );
    });

    it("SEND_TEMPLATE_MESSAGE: does not recursively expand placeholder-looking text inside substituted values", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7007;

      // Customer whose first name contains {{price}} and last name contains {{store_name}}
      const req = createWebhookRequest(
        {
          update_id: 20007,
          callback_query: {
            id: "cb_tpl_non_recursive",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "Eve {{price}}",
              last_name: "{{store_name}}",
            },
            message: {
              message_id: 16,
              chat: { id: customerTelegramId, type: "private" },
            },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const sent = fakeTransport.sentMessages[0];
      // Substituted customer name was treated as literal text, never re-expanded
      expect(sent.text).toBe(
        "Hello Eve {{price}} {{store_name}}, Custom Keyboard Pro is 129.50 USD at Acme Digital Store.",
      );
    });

    it("SEND_TEMPLATE_MESSAGE: handles missing or default-invalid body safely", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();

      // Case 1: Malformed syntax (triple braces)
      const req1 = createWebhookRequest(
        {
          update_id: 20008,
          callback_query: {
            id: "cb_tpl_malformed",
            from: { id: 7008, is_bot: false, first_name: "Alex" },
            message: { message_id: 17, chat: { id: 7008, type: "private" } },
            data: tokens.action(templateInvalidSyntaxActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res1 = await handleTelegramWebhookRequest(req1, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res1.status).toBe(200);
      expect(fakeTransport.sentMessages[0].text).toContain("This option is no longer available.");
      expect(fakeTransport.sentMessages[0].replyMarkup?.inline_keyboard).toBeDefined();

      fakeTransport.clear();

      // Case 2: Missing body entirely (null)
      const req2 = createWebhookRequest(
        {
          update_id: 20009,
          callback_query: {
            id: "cb_tpl_missing",
            from: { id: 7009, is_bot: false, first_name: "Ben" },
            message: { message_id: 18, chat: { id: 7009, type: "private" } },
            data: tokens.action(templateMissingBodyActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);
      expect(fakeTransport.sentMessages[0].text).toContain("This option is no longer available.");
    });

    it("SEND_TEMPLATE_MESSAGE: expanded long content is fully reconstructable from chunks and navigation is on final chunk", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7010;

      const req = createWebhookRequest(
        {
          update_id: 20010,
          callback_query: {
            id: "cb_tpl_long",
            from: {
              id: customerTelegramId,
              is_bot: false,
              first_name: "CustomerWithVeryLongName".repeat(5),
            },
            message: { message_id: 19, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(templateLongActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      // Because length > 4096, must be delivered in multiple sequential chunks
      expect(fakeTransport.sentMessages.length).toBeGreaterThanOrEqual(2);

      // Reconstructable without dropped characters
      const fullText = fakeTransport.sentMessages.map((m) => m.text).join("");
      expect(fullText).toContain("Custom Keyboard Pro");
      expect(fullText).toContain("129.50 USD");
      expect(fullText).toContain("Acme Digital Store");
      expect(fullText).toContain("CustomerWithVeryLongName");

      // Intermediate chunk(s) must NOT have replyMarkup
      for (let i = 0; i < fakeTransport.sentMessages.length - 1; i++) {
        expect(fakeTransport.sentMessages[i].replyMarkup).toBeUndefined();
      }

      // Final chunk MUST have navigation replyMarkup attached
      const lastChunk = fakeTransport.sentMessages[fakeTransport.sentMessages.length - 1];
      expect(lastChunk.replyMarkup?.inline_keyboard).toBeDefined();
      expect(lastChunk.replyMarkup?.inline_keyboard[0][0].text).toBe("◀ Back");
    });

    it("SEND_TEMPLATE_MESSAGE: transport failure leaves update retryable rather than processed", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      fakeTransport.failSendWith = "Telegram Bot API 500 Network Disconnect";
      const updateId = 20011;

      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_tpl_fail",
            from: { id: 7011, is_bot: false, first_name: "FailUser" },
            message: { message_id: 20, chat: { id: 7011, type: "private" } },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);

      // Update record in database must NOT be marked processed
      const [updateRow] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(updateRow).toBeDefined();
      expect(updateRow.processedAt).toBeNull();
      expect(updateRow.processingError).toContain("category=api_error");
    });

    // -------------------------------------------------------------------------
    // 2. OPEN_URL Tests
    // -------------------------------------------------------------------------
    it("OPEN_URL: valid informational HTTPS URL renders small view with URL button and Back/Home", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7012;

      const req = createWebhookRequest(
        {
          update_id: 20012,
          callback_query: {
            id: "cb_url_valid",
            from: { id: customerTelegramId, is_bot: false, first_name: "UrlUser" },
            message: { message_id: 21, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(urlValidActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      expect(fakeTransport.editedMessages).toHaveLength(1);

      const edited = fakeTransport.editedMessages[0];
      expect(edited.text).toBe("Online Manual");

      const rows = edited.replyMarkup?.inline_keyboard ?? [];
      expect(rows).toHaveLength(3);

      // Row 0: URL button (contains url, NO callback_data)
      expect(rows[0][0].text).toBe("🌐 Open link");
      expect(rows[0][0].url).toBe("https://docs.example.com/guide/keyboards");
      expect(rows[0][0].callback_data).toBeUndefined();

      // Row 1: Back (contains callback_data, NO url)
      expect(rows[1][0].text).toBe("◀ Back");
      expect(rows[1][0].callback_data).toBe(tokens.product(p6bProductId));
      expect(rows[1][0].url).toBeUndefined();

      // Row 2: Home
      expect(rows[2][0].text).toBe("🏠 Home");
      expect(rows[2][0].callback_data).toBe(tokens.home());
      expect(rows[2][0].url).toBeUndefined();
    });

    it("OPEN_URL: invalid or insecure URLs produce safe feedback without a URL button", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();

      // 1. Insecure http: URL
      const reqHttp = createWebhookRequest(
        {
          update_id: 20013,
          callback_query: {
            id: "cb_url_http",
            from: { id: 7013, is_bot: false, first_name: "InsecureUser" },
            message: { message_id: 22, chat: { id: 7013, type: "private" } },
            data: tokens.action(urlHttpActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resHttp = await handleTelegramWebhookRequest(reqHttp, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resHttp.status).toBe(200);
      const editedHttp = fakeTransport.editedMessages[0];
      expect(editedHttp.text).toContain("This option is no longer available.");
      // MUST NOT contain a URL button
      for (const row of editedHttp.replyMarkup?.inline_keyboard ?? []) {
        for (const btn of row) {
          expect(btn.url).toBeUndefined();
        }
      }

      fakeTransport.clear();

      // 2. Embedded credentials URL
      const reqCreds = createWebhookRequest(
        {
          update_id: 20014,
          callback_query: {
            id: "cb_url_creds",
            from: { id: 7014, is_bot: false, first_name: "CredsUser" },
            message: { message_id: 23, chat: { id: 7014, type: "private" } },
            data: tokens.action(urlCredentialsActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resCreds = await handleTelegramWebhookRequest(reqCreds, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resCreds.status).toBe(200);
      const editedCreds = fakeTransport.editedMessages[0];
      expect(editedCreds.text).toContain("This option is no longer available.");
      for (const row of editedCreds.replyMarkup?.inline_keyboard ?? []) {
        for (const btn of row) {
          expect(btn.url).toBeUndefined();
        }
      }

      fakeTransport.clear();

      // 3. Missing URL (null)
      const reqMiss = createWebhookRequest(
        {
          update_id: 20015,
          callback_query: {
            id: "cb_url_null",
            from: { id: 7015, is_bot: false, first_name: "NullUser" },
            message: { message_id: 24, chat: { id: 7015, type: "private" } },
            data: tokens.action(urlMissingActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resMiss = await handleTelegramWebhookRequest(reqMiss, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resMiss.status).toBe(200);
      const editedMiss = fakeTransport.editedMessages[0];
      expect(editedMiss.text).toContain("This option is no longer available.");
      for (const row of editedMiss.replyMarkup?.inline_keyboard ?? []) {
        for (const btn of row) {
          expect(btn.url).toBeUndefined();
        }
      }
    });

    it("OPEN_URL: rechecks action and product hierarchy activation on tap", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7016;

      // Deactivate the OPEN_URL action in the database
      await db
        .update(productAction)
        .set({ isActive: false })
        .where(eq(productAction.id, urlValidActionId));

      try {
        const req = createWebhookRequest(
          {
            update_id: 20016,
            callback_query: {
              id: "cb_url_deact",
              from: { id: customerTelegramId, is_bot: false, first_name: "TapUser" },
              message: { message_id: 25, chat: { id: customerTelegramId, type: "private" } },
              data: tokens.action(urlValidActionId),
            },
          },
          TEST_WEBHOOK_SECRET,
        );

        const res = await handleTelegramWebhookRequest(req, {
          db: asAppDb(db),
          transport: fakeTransport,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });

        expect(res.status).toBe(200);
        const edited = fakeTransport.editedMessages[0];
        expect(edited.text).toContain("This option is no longer available.");
        // URL button not rendered
        for (const row of edited.replyMarkup?.inline_keyboard ?? []) {
          for (const btn of row) {
            expect(btn.url).toBeUndefined();
          }
        }
      } finally {
        // Restore action isActive
        await db
          .update(productAction)
          .set({ isActive: true })
          .where(eq(productAction.id, urlValidActionId));
      }
    });

    it("OPEN_URL: rendering failure follows existing attempt failure policy", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      fakeTransport.failEditWith = "Telegram Bot API edit timeout";
      const updateId = 20017;

      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_url_fail",
            from: { id: 7017, is_bot: false, first_name: "FailUser" },
            message: { message_id: 26, chat: { id: 7017, type: "private" } },
            data: tokens.action(urlValidActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(500);
      const [updateRow] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, updateId));
      expect(updateRow).toBeDefined();
      expect(updateRow.processedAt).toBeNull();
      expect(updateRow.processingError).toContain("category=api_error");
    });

    // -------------------------------------------------------------------------
    // 3. NAVIGATE_CATALOG Tests
    // -------------------------------------------------------------------------
    it("NAVIGATE_CATALOG: valid category target renders expected category page and acknowledges callback once", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7018;

      const req = createWebhookRequest(
        {
          update_id: 20018,
          callback_query: {
            id: "cb_nav_cat",
            from: { id: customerTelegramId, is_bot: false, first_name: "NavUser" },
            message: { message_id: 27, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(navCategoryActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      // Callback acknowledged exactly once!
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      expect(fakeTransport.editedMessages).toHaveLength(1);

      const edited = fakeTransport.editedMessages[0];
      // Target category name and description rendered
      expect(edited.text).toContain("Accessories");
      expect(edited.text).toContain("Keyboard accessories and cables");

      // Contains target category's product button
      const flatButtons = (edited.replyMarkup?.inline_keyboard ?? []).flat();
      const cableBtn = flatButtons.find((b) => b.text === "Coiled USB-C Cable");
      expect(cableBtn).toBeDefined();
      expect(cableBtn?.callback_data).toBe(tokens.product(targetProdId));

      // Destination Back button points to parent (home since targetCat is root) and Home
      const backBtn = flatButtons.find((b) => b.text === "◀ Back");
      expect(backBtn?.callback_data).toBe(tokens.home());
    });

    it("NAVIGATE_CATALOG: valid product target renders product card, exact price, actions, and does not execute further", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7019;

      const req = createWebhookRequest(
        {
          update_id: 20019,
          callback_query: {
            id: "cb_nav_prod",
            from: { id: customerTelegramId, is_bot: false, first_name: "ProdNavUser" },
            message: { message_id: 28, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(navProductActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.answeredCallbacks).toHaveLength(1);
      expect(fakeTransport.editedMessages).toHaveLength(1);

      const edited = fakeTransport.editedMessages[0];
      // Rendered target product card
      expect(edited.text).toContain("Coiled USB-C Cable");
      expect(edited.text).toContain("Aviator connector coiled cable.");
      expect(edited.text).toContain("Price: 19.99 USD");

      // Destination Back points to product's category
      const flatButtons = (edited.replyMarkup?.inline_keyboard ?? []).flat();
      const backBtn = flatButtons.find((b) => b.text === "◀ Back");
      expect(backBtn?.callback_data).toBe(tokens.category(targetCatId));

      // Home button
      const homeBtn = flatButtons.find((b) => b.text === "🏠 Home");
      expect(homeBtn?.callback_data).toBe(tokens.home());
    });

    it("NAVIGATE_CATALOG: no target produces safe unavailable feedback with source navigation", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7020;

      const req = createWebhookRequest(
        {
          update_id: 20020,
          callback_query: {
            id: "cb_nav_notarget",
            from: { id: customerTelegramId, is_bot: false, first_name: "NoTargetUser" },
            message: { message_id: 29, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(navNoTargetActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      const edited = fakeTransport.editedMessages[0];
      expect(edited.text).toContain("This option is no longer available.");

      // Back navigation points back to SOURCE product
      const flatButtons = (edited.replyMarkup?.inline_keyboard ?? []).flat();
      const backBtn = flatButtons.find((b) => b.text === "◀ Back");
      expect(backBtn?.callback_data).toBe(tokens.product(p6bProductId));
    });

    it("NAVIGATE_CATALOG: inactive, deleted, or hidden-by-ancestor targets produce safe feedback without exposing details", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();

      // 1. Inactive category target
      const reqInact = createWebhookRequest(
        {
          update_id: 20021,
          callback_query: {
            id: "cb_nav_inact_cat",
            from: { id: 7021, is_bot: false, first_name: "InactUser" },
            message: { message_id: 30, chat: { id: 7021, type: "private" } },
            data: tokens.action(navInactiveCatActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resInact = await handleTelegramWebhookRequest(reqInact, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resInact.status).toBe(200);
      const editedInact = fakeTransport.editedMessages[0];
      expect(editedInact.text).toContain("This category is no longer available.");
      // MUST NOT expose hidden category details!
      expect(editedInact.text).not.toContain("Hidden Category Name");
      expect(editedInact.text).not.toContain("Secret description");

      fakeTransport.clear();

      // 2. Deleted category target
      const reqDel = createWebhookRequest(
        {
          update_id: 20022,
          callback_query: {
            id: "cb_nav_del_cat",
            from: { id: 7022, is_bot: false, first_name: "DelUser" },
            message: { message_id: 31, chat: { id: 7022, type: "private" } },
            data: tokens.action(navDeletedCatActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resDel = await handleTelegramWebhookRequest(reqDel, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resDel.status).toBe(200);
      const editedDel = fakeTransport.editedMessages[0];
      expect(editedDel.text).toContain("This category is no longer available.");

      fakeTransport.clear();

      // 3. Inactive product target
      const reqInactProd = createWebhookRequest(
        {
          update_id: 20023,
          callback_query: {
            id: "cb_nav_inact_prod",
            from: { id: 7023, is_bot: false, first_name: "InactProdUser" },
            message: { message_id: 32, chat: { id: 7023, type: "private" } },
            data: tokens.action(navInactiveProdActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resInactProd = await handleTelegramWebhookRequest(reqInactProd, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resInactProd.status).toBe(200);
      const editedInactProd = fakeTransport.editedMessages[0];
      expect(editedInactProd.text).toContain("This product is no longer available.");
      // MUST NOT expose hidden product name or price!
      expect(editedInactProd.text).not.toContain("Top Secret Prototype");
      expect(editedInactProd.text).not.toContain("999.00");

      fakeTransport.clear();

      // 4. Category whose parent ancestor is inactive
      const reqAncestor = createWebhookRequest(
        {
          update_id: 20024,
          callback_query: {
            id: "cb_nav_inact_ancestor",
            from: { id: 7024, is_bot: false, first_name: "AncestorUser" },
            message: { message_id: 33, chat: { id: 7024, type: "private" } },
            data: tokens.action(navInactiveAncestorCatActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const resAncestor = await handleTelegramWebhookRequest(reqAncestor, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(resAncestor.status).toBe(200);
      const editedAncestor = fakeTransport.editedMessages[0];
      expect(editedAncestor.text).toContain("This category is no longer available.");
      expect(editedAncestor.text).not.toContain("Orphaned Active Subcategory");
    });

    // -------------------------------------------------------------------------
    // 4. Regression & Boundary Tests
    // -------------------------------------------------------------------------
    it("Regression: duplicate processed update_id does not resend action responses", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7025;
      const updateId = 20025;

      const req = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_dup_test",
            from: { id: customerTelegramId, is_bot: false, first_name: "DupUser" },
            message: { message_id: 34, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      // First run: processes successfully
      const res1 = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res1.status).toBe(200);
      expect(fakeTransport.sentMessages).toHaveLength(1);

      fakeTransport.clear();

      // Second run with fresh Request object: duplicate detection recognizes already-processed update
      const req2 = createWebhookRequest(
        {
          update_id: updateId,
          callback_query: {
            id: "cb_dup_test",
            from: { id: customerTelegramId, is_bot: false, first_name: "DupUser" },
            message: { message_id: 34, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(templateActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );
      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ ok: true, status: "already_processed" });
      expect(fakeTransport.sentMessages).toHaveLength(0);
      expect(fakeTransport.editedMessages).toHaveLength(0);
    });

    it("Phase 07: OPEN_SUPPORT creates general support inquiry and confirms to customer", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerTelegramId = 7026;

      // Count inquiry rows before
      const inqBefore = await db.select().from(inquiry);

      // Create OPEN_SUPPORT action
      const [suppAct] = await db
        .insert(productAction)
        .values({
          productId: p6bProductId,
          actionType: "OPEN_SUPPORT",
          sortOrder: 30,
          isActive: true,
        })
        .returning();

      await db.insert(productActionTranslation).values([
        {
          actionId: suppAct.id,
          languageId: enLangId,
          label: "Support Desk",
        },
      ]);

      const req = createWebhookRequest(
        {
          update_id: 20026,
          callback_query: {
            id: "cb_supp_deferred",
            from: { id: customerTelegramId, is_bot: false, first_name: "SuppUser" },
            message: { message_id: 35, chat: { id: customerTelegramId, type: "private" } },
            data: tokens.action(suppAct.id),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toContain(
        "Thank you for contacting Acme Digital Store support.",
      );
      expect(fakeTransport.editedMessages[0].text).toContain("Reference: INQ-");

      // Inquiry created
      const inqAfter = await db.select().from(inquiry);
      expect(inqAfter).toHaveLength(inqBefore.length + 1);
    });

    it("Regression: read and navigation operations do not mutate catalog or action configuration", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();

      // Snapshot action rows
      const actionsBefore = await db
        .select()
        .from(productAction)
        .where(eq(productAction.productId, p6bProductId));

      const req = createWebhookRequest(
        {
          update_id: 20027,
          callback_query: {
            id: "cb_read_pure",
            from: { id: 7027, is_bot: false, first_name: "PureUser" },
            message: { message_id: 36, chat: { id: 7027, type: "private" } },
            data: tokens.action(navCategoryActionId),
          },
        },
        TEST_WEBHOOK_SECRET,
      );

      await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      const actionsAfter = await db
        .select()
        .from(productAction)
        .where(eq(productAction.productId, p6bProductId));

      expect(actionsAfter).toHaveLength(actionsBefore.length);
      for (let i = 0; i < actionsBefore.length; i++) {
        expect(actionsAfter[i].updatedAt).toEqual(actionsBefore[i].updatedAt);
        expect(actionsAfter[i].isActive).toEqual(actionsBefore[i].isActive);
      }
    });
  });
});

