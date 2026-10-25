import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";

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
  telegramUpdate,
} from "@/db/schema";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  appendInboundCustomerMessage,
  claimTelegramUpdate,
  createOrResumeProductInquiry,
  createOrResumeSupportInquiry,
  createReceiptAssertionQuery,
  executeAtomicBatch,
  listActiveCustomerInquiriesPaged,
  routeAndAppendCustomerText,
  upsertCustomer,
} from "@/lib/data";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

const TEST_BOT_TOKEN = "123456789:TEST_BOT_TOKEN_FOR_PHASE07";
const TEST_WEBHOOK_SECRET = "secret-token-phase-07-verification";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("customer_inquiries");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

function createWebhookRequest(body: unknown, secretHeader = TEST_WEBHOOK_SECRET): Request {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secretHeader,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(!shouldRun)("Phase 07: Unified Customer Inquiries, Support & Inbound Messages", () => {
  let enLangId: string;
  let arLangId: string;
  let rootCatId: string;
  let subCatId: string;
  let prodAId: string;
  let prodBId: string;
  let rootMenuActId: string;
  let subMenuActId: string;
  let startInqActId: string;
  let openSupportActId: string;
  let openSupportConfiguredActId: string;

  beforeAll(async () => {
    if (!testDb) return;
    const db = testDb.db;

    // 1. Languages
    const [en] = await db
      .insert(language)
      .values({ code: "en", label: "English", isEnabled: true, textDirection: "ltr" })
      .returning();
    const [ar] = await db
      .insert(language)
      .values({ code: "ar", label: "العربية", isEnabled: true, textDirection: "rtl" })
      .returning();
    enLangId = en.id;
    arLangId = ar.id;

    // 2. Bot settings
    await db.insert(botSetting).values({
      defaultLanguageId: enLangId,
      currency: "USD",
      displayName: "Rabet Store",
      supportCategory: ["Billing", "Technical"],
    });

    // 3. Global message templates
    const [inqTmpl] = await db
      .insert(messageTemplate)
      .values({
        key: "inquiry_received",
        title: "Inquiry Received",
        purpose: "Inquiry confirmation",
        allowedPlaceholders: ["store_name", "product_name"],
      })
      .returning();

    await db.insert(messageTranslation).values([
      {
        templateId: inqTmpl.id,
        languageId: enLangId,
        body: "Thank you for your inquiry about {{product_name}} at {{store_name}}.",
      },
      {
        templateId: inqTmpl.id,
        languageId: arLangId,
        body: "شكرًا لاستفسارك عن {{product_name}} في {{store_name}}.",
      },
    ]);

    // 4. Category hierarchy: Root -> Subcategory
    const [rootCat] = await db
      .insert(category)
      .values({ slug: "electronics", sortOrder: 1, isActive: true })
      .returning();
    rootCatId = rootCat.id;

    await db.insert(categoryTranslation).values([
      { categoryId: rootCatId, languageId: enLangId, name: "Electronics" },
      { categoryId: rootCatId, languageId: arLangId, name: "إلكترونيات" },
    ]);

    const [subCat] = await db
      .insert(category)
      .values({ parentId: rootCatId, slug: "laptops", sortOrder: 1, isActive: true })
      .returning();
    subCatId = subCat.id;

    await db.insert(categoryTranslation).values([
      { categoryId: subCatId, languageId: enLangId, name: "Laptops" },
      { categoryId: subCatId, languageId: arLangId, name: "حواسيب محمولة" },
    ]);

    // 5. Products: Prod A ($999.00), Prod B ($1499.00)
    const [pA] = await db
      .insert(product)
      .values({ categoryId: subCatId, slug: "laptop-pro", price: "999.00", isActive: true })
      .returning();
    prodAId = pA.id;

    await db.insert(productTranslation).values([
      { productId: prodAId, languageId: enLangId, name: "Laptop Pro 14", description: "Pro Laptop" },
      { productId: prodAId, languageId: arLangId, name: "لابتوب برو 14", description: "لابتوب احترافي" },
    ]);

    const [pB] = await db
      .insert(product)
      .values({ categoryId: subCatId, slug: "laptop-max", price: "1499.00", isActive: true })
      .returning();
    prodBId = pB.id;

    await db.insert(productTranslation).values([
      { productId: prodBId, languageId: enLangId, name: "Laptop Max 16", description: "Max Laptop" },
    ]);

    // 6. Button Tree on Prod A:
    // Root Menu (OPEN_SUBMENU: "Configure") -> Sub Menu (OPEN_SUBMENU: "Specifications") -> Ask Seller (START_INQUIRY)
    const [rm] = await db
      .insert(productAction)
      .values({ productId: prodAId, actionType: "OPEN_SUBMENU", sortOrder: 1, isActive: true })
      .returning();
    rootMenuActId = rm.id;

    await db.insert(productActionTranslation).values([
      { actionId: rootMenuActId, languageId: enLangId, label: "Configure" },
    ]);

    const [sm] = await db
      .insert(productAction)
      .values({
        productId: prodAId,
        parentActionId: rootMenuActId,
        actionType: "OPEN_SUBMENU",
        sortOrder: 1,
        isActive: true,
      })
      .returning();
    subMenuActId = sm.id;

    await db.insert(productActionTranslation).values([
      { actionId: subMenuActId, languageId: enLangId, label: "Specifications" },
    ]);

    const [termInq] = await db
      .insert(productAction)
      .values({
        productId: prodAId,
        parentActionId: subMenuActId,
        actionType: "START_INQUIRY",
        sortOrder: 1,
        isActive: true,
      })
      .returning();
    startInqActId = termInq.id;

    await db.insert(productActionTranslation).values([
      { actionId: startInqActId, languageId: enLangId, label: "Ask Seller" },
    ]);

    // General support action (no configured category)
    const [suppGen] = await db
      .insert(productAction)
      .values({ productId: prodAId, actionType: "OPEN_SUPPORT", sortOrder: 2, isActive: true })
      .returning();
    openSupportActId = suppGen.id;

    await db.insert(productActionTranslation).values([
      { actionId: openSupportActId, languageId: enLangId, label: "Support" },
    ]);

    // Configured support action (category: "Billing")
    const [suppBill] = await db
      .insert(productAction)
      .values({
        productId: prodAId,
        actionType: "OPEN_SUPPORT",
        actionConfig: { support_category: "Billing" },
        sortOrder: 3,
        isActive: true,
      })
      .returning();
    openSupportConfiguredActId = suppBill.id;

    await db.insert(productActionTranslation).values([
      { actionId: openSupportConfiguredActId, languageId: enLangId, label: "Billing Questions" },
    ]);
  });

  describe("1. START_INQUIRY: Creation, Context Freezing, Resumption & Closure", () => {
    it("creates product inquiry with frozen name, exact price, currency, category path, and ordered options", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 10001;

      const req = createWebhookRequest({
        update_id: 30001,
        callback_query: {
          id: "cb_inq_1",
          from: { id: customerId, is_bot: false, first_name: "Tariq", language_code: "en" },
          message: { message_id: 101, chat: { id: customerId, type: "private" } },
          data: tokens.action(startInqActId),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify created inquiry record
      const [inqRow] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.productId, prodAId));

      expect(inqRow).toBeDefined();
      expect(inqRow.status).toBe("open");
      expect(inqRow.reference).toMatch(/^INQ-[A-Z0-9]{6}$/);

      // Frozen snapshot verification
      const snap = inqRow.productSnapshot as {
        productId: string;
        name: string;
        price: string;
        currency: string;
        categoryPath: string[];
      };
      expect(snap.productId).toBe(prodAId);
      expect(snap.name).toBe("Laptop Pro 14");
      expect(snap.price).toBe("999.00");
      expect(snap.currency).toBe("USD");
      expect(snap.categoryPath).toEqual(["Electronics", "Laptops"]);

      // Selected options: ordered root-to-leaf, excluding the terminal Ask Seller button
      expect(inqRow.selectedOptions).toEqual(["Configure", "Specifications"]);

      // Confirmation message verification
      expect(fakeTransport.editedMessages).toHaveLength(1);
      const confMsg = fakeTransport.editedMessages[0];
      expect(confMsg.text).toContain("Thank you for your inquiry about Laptop Pro 14 at Rabet Store.");
      expect(confMsg.text).toContain(`Reference: ${inqRow.reference}`);
      expect(confMsg.text).toContain("Price: 999.00 USD");
      expect(confMsg.text).toContain("Options: Configure › Specifications");
      expect(confMsg.text).toContain("Please send your message here to communicate with us.");
    });

    it("resumes existing active inquiry on repeat START_INQUIRY without creating duplicate", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 10001;

      const inqCountBefore = (await db.select().from(inquiry)).length;

      const req = createWebhookRequest({
        update_id: 30002,
        callback_query: {
          id: "cb_inq_repeat",
          from: { id: customerId, is_bot: false, first_name: "Tariq" },
          message: { message_id: 102, chat: { id: customerId, type: "private" } },
          data: tokens.action(startInqActId),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      const inqAfter = await db.select().from(inquiry);
      expect(inqAfter).toHaveLength(inqCountBefore); // NO duplicate created

      expect(fakeTransport.editedMessages).toHaveLength(1);
      expect(fakeTransport.editedMessages[0].text).toContain("Reference: INQ-");
    });

    it("keeps different products as separate active inquiries for the same customer", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 10001;

      // Add START_INQUIRY button to Prod B
      const [termInqB] = await db
        .insert(productAction)
        .values({ productId: prodBId, actionType: "START_INQUIRY", sortOrder: 1, isActive: true })
        .returning();

      await db.insert(productActionTranslation).values([
        { actionId: termInqB.id, languageId: enLangId, label: "Ask Seller B" },
      ]);

      const req = createWebhookRequest({
        update_id: 30003,
        callback_query: {
          id: "cb_inq_b",
          from: { id: customerId, is_bot: false, first_name: "Tariq" },
          message: { message_id: 103, chat: { id: customerId, type: "private" } },
          data: tokens.action(termInqB.id),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Customer now has two distinct active inquiries for Prod A and Prod B
      const activeInqs = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.status, "open"));
      expect(activeInqs.length).toBeGreaterThanOrEqual(2);
    });

    it("preserves frozen snapshot when catalog price or name changes later", async () => {
      const db = testDb!.db;
      const [existingInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.productId, prodAId));

      const oldSnapshot = existingInq.productSnapshot as { price: string; name: string };
      expect(oldSnapshot.price).toBe("999.00");

      // Seller updates product price to $1199.00 in catalog
      await db
        .update(product)
        .set({ price: "1199.00" })
        .where(eq(product.id, prodAId));

      // Reload inquiry from database: snapshot remains strictly 999.00
      const [reloaded] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, existingInq.id));

      const reloadedSnap = reloaded.productSnapshot as { price: string };
      expect(reloadedSnap.price).toBe("999.00");
    });

    it("creates a new inquiry after closure without reopening the closed thread", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 10001;

      // Close the existing inquiry for Prod A
      const [existingInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.productId, prodAId));

      await db
        .update(inquiry)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(inquiry.id, existingInq.id));

      // Customer contacts seller again for Prod A
      const req = createWebhookRequest({
        update_id: 30004,
        callback_query: {
          id: "cb_inq_post_close",
          from: { id: customerId, is_bot: false, first_name: "Tariq" },
          message: { message_id: 104, chat: { id: customerId, type: "private" } },
          data: tokens.action(startInqActId),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify original closed inquiry remained closed
      const [orig] = await db.select().from(inquiry).where(eq(inquiry.id, existingInq.id));
      expect(orig.status).toBe("closed");

      // Verify NEW active inquiry was created with a different reference
      const [newInq] = await db
        .select()
        .from(inquiry)
        .where(and(eq(inquiry.productId, prodAId), eq(inquiry.status, "open")));

      expect(newInq.id).not.toBe(existingInq.id);
      expect(newInq.reference).not.toBe(existingInq.reference);
    });

    it("fails closed with safe feedback if source product is inactive or deleted", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 10002;

      // Soft delete product B
      await db
        .update(product)
        .set({ deletedAt: new Date() })
        .where(eq(product.id, prodBId));

      const [actionB] = await db
        .select()
        .from(productAction)
        .where(eq(productAction.productId, prodBId))
        .limit(1);

      const inqCountBefore = (await db.select().from(inquiry)).length;

      const req = createWebhookRequest({
        update_id: 30005,
        callback_query: {
          id: "cb_inq_inactive_prod",
          from: { id: customerId, is_bot: false, first_name: "Sara" },
          message: { message_id: 105, chat: { id: customerId, type: "private" } },
          data: tokens.action(actionB.id),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toContain("no longer available");

      // Zero new inquiries
      const inqCountAfter = (await db.select().from(inquiry)).length;
      expect(inqCountAfter).toBe(inqCountBefore);
    });
  });

  describe("2. OPEN_SUPPORT: General & Categorized Support", () => {
    it("creates general support inquiry with product_id = NULL and category = NULL", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 20001;

      const req = createWebhookRequest({
        update_id: 30010,
        callback_query: {
          id: "cb_supp_gen",
          from: { id: customerId, is_bot: false, first_name: "Youssef" },
          message: { message_id: 110, chat: { id: customerId, type: "private" } },
          data: tokens.action(openSupportActId),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify support inquiry created
      const [suppInq] = await db
        .select()
        .from(inquiry)
        .where(and(eq(inquiry.customerId, (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0].id), isNull(inquiry.productId)));

      expect(suppInq).toBeDefined();
      expect(suppInq.productId).toBeNull();
      expect(suppInq.category).toBeNull();
      expect(suppInq.status).toBe("open");
      expect(suppInq.productSnapshot).toEqual({ type: "support" });

      expect(fakeTransport.editedMessages[0].text).toContain("Thank you for contacting Rabet Store support.");
      expect(fakeTransport.editedMessages[0].text).toContain(`Reference: ${suppInq.reference}`);
    });

    it("creates categorized support when actionConfig has valid support_category", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 20001;

      const req = createWebhookRequest({
        update_id: 30011,
        callback_query: {
          id: "cb_supp_bill",
          from: { id: customerId, is_bot: false, first_name: "Youssef" },
          message: { message_id: 111, chat: { id: customerId, type: "private" } },
          data: tokens.action(openSupportConfiguredActId),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify categorized inquiry exists alongside general support
      const custRow = (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0];
      const categorized = await db
        .select()
        .from(inquiry)
        .where(and(eq(inquiry.customerId, custRow.id), eq(inquiry.category, "Billing")));

      expect(categorized).toHaveLength(1);
      expect(categorized[0].productId).toBeNull();
      expect(fakeTransport.editedMessages[0].text).toContain("Category: Billing");
    });

    it("rejects support tap if configured category was removed from bot_setting", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 20002;

      // Create an action with category "ObsoleteCategory" not in bot_setting.support_category
      const [obsAct] = await db
        .insert(productAction)
        .values({
          productId: prodAId,
          actionType: "OPEN_SUPPORT",
          actionConfig: { support_category: "ObsoleteCategory" },
          sortOrder: 10,
          isActive: true,
        })
        .returning();

      await db.insert(productActionTranslation).values([
        { actionId: obsAct.id, languageId: enLangId, label: "Old Support" },
      ]);

      const inqCountBefore = (await db.select().from(inquiry)).length;

      const req = createWebhookRequest({
        update_id: 30012,
        callback_query: {
          id: "cb_supp_obsolete",
          from: { id: customerId, is_bot: false, first_name: "Layla" },
          message: { message_id: 112, chat: { id: customerId, type: "private" } },
          data: tokens.action(obsAct.id),
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.editedMessages[0].text).toBe("This support category is currently unavailable.");

      // Zero inquiries created
      const inqCountAfter = (await db.select().from(inquiry)).length;
      expect(inqCountAfter).toBe(inqCountBefore);
    });
  });

  describe("3. Inbound Text Message Routing & /reply Command", () => {
    it("creates general support inquiry and saves text when customer has zero active inquiries", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 40001;

      const req = createWebhookRequest({
        update_id: 30020,
        message: {
          message_id: 201,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "FreshCustomer" },
          text: "Hi, I have a general question about shipping.",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Verify support inquiry created
      const custRow = (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0];
      const inqs = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.customerId, custRow.id));

      expect(inqs).toHaveLength(1);
      expect(inqs[0].productId).toBeNull();
      expect(inqs[0].category).toBeNull();
      expect(inqs[0].status).toBe("open");

      // Verify message saved to that inquiry
      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inqs[0].id));

      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toBe("Hi, I have a general question about shipping.");
      expect(msgs[0].author).toBe("customer");
      expect(msgs[0].deliveryStatus).toBe("sent");
      expect(msgs[0].deliveredAt).toBeDefined();

      // Truthful acknowledgement sent
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages[0].text).toContain("Support inquiry opened");
      expect(fakeTransport.sentMessages[0].text).toContain(inqs[0].reference);
    });

    it("appends to the single active inquiry when customer has exactly one", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 40001; // Same customer who now has exactly 1 active inquiry

      const custRow = (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0];
      const inq = (await db.select().from(inquiry).where(eq(inquiry.customerId, custRow.id)))[0];

      const req = createWebhookRequest({
        update_id: 30021,
        message: {
          message_id: 202,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "FreshCustomer" },
          text: "Also, do you deliver internationally?",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Message appended to existing inquiry
      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inq.id));

      expect(msgs).toHaveLength(2);
      expect(msgs[1].body).toBe("Also, do you deliver internationally?");

      // Truthful acknowledgement
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages[0].text).toContain(`Message received for inquiry ${inq.reference}`);
    });

    it("does NOT save text and requires /reply destination when customer has multiple active inquiries", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 40001;
      const custRow = (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0];

      // Open a second active inquiry for this customer
      const [secondInq] = await db
        .insert(inquiry)
        .values({
          customerId: custRow.id,
          productId: prodAId,
          reference: "INQ-MULT02",
          productSnapshot: { name: "Laptop Pro 14", price: "999.00" },
          status: "open",
        })
        .returning();

      const msgsBefore = await db.select().from(inquiryMessage);

      // Customer sends ambiguous ordinary text
      const req = createWebhookRequest({
        update_id: 30022,
        message: {
          message_id: 203,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "FreshCustomer" },
          text: "Ambiguous message without reference",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Zero message rows created
      const msgsAfter = await db.select().from(inquiryMessage);
      expect(msgsAfter).toHaveLength(msgsBefore.length);

      // Disambiguation prompt shown with references
      expect(fakeTransport.sentMessages).toHaveLength(1);
      const prompt = fakeTransport.sentMessages[0].text;
      expect(prompt).toContain("Your message was not saved because you have multiple active inquiries");
      expect(prompt).toContain(secondInq.reference);
      expect(prompt).toContain("/reply");
    });

    it("/reply routes message strictly to specified active inquiry", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 40001;

      const req = createWebhookRequest({
        update_id: 30023,
        message: {
          message_id: 204,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "FreshCustomer" },
          text: "/reply INQ-MULT02 I am asking specifically about this laptop.",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Message saved to INQ-MULT02 only
      const [targetInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.reference, "INQ-MULT02"));

      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, targetInq.id));

      expect(msgs).toHaveLength(1);
      // Wrapper stripped: only message body stored!
      expect(msgs[0].body).toBe("I am asking specifically about this laptop.");

      expect(fakeTransport.sentMessages[0].text).toContain("Message received for inquiry INQ-MULT02");
    });

    it("/reply rejects unknown or another customer's reference with safe feedback and zero writes", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 50001; // Different customer

      const msgsBefore = await db.select().from(inquiryMessage);

      // Attempting to reply to customer 40001's reference INQ-MULT02
      const req = createWebhookRequest({
        update_id: 30024,
        message: {
          message_id: 205,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "Intruder" },
          text: "/reply INQ-MULT02 Sneaky reply",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Zero writes
      const msgsAfter = await db.select().from(inquiryMessage);
      expect(msgsAfter).toHaveLength(msgsBefore.length);

      // Safe guidance, does NOT reveal whether INQ-MULT02 exists
      expect(fakeTransport.sentMessages[0].text).toBe(
        "Inquiry not found or already closed. Please check the reference and try again.",
      );
    });

    it("rejects unsupported non-text content without creating empty rows", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 50002;

      const msgsBefore = await db.select().from(inquiryMessage);

      // Simulated photo or attachment message (text is undefined)
      const req = createWebhookRequest({
        update_id: 30025,
        message: {
          message_id: 206,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "PhotoUser" },
          // No text field
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);

      // Zero message rows
      const msgsAfter = await db.select().from(inquiryMessage);
      expect(msgsAfter).toHaveLength(msgsBefore.length);

      expect(fakeTransport.sentMessages[0].text).toBe("We only support text messages in this version.");
    });
  });

  describe("4. Durable Atomicity & Retry Recovery", () => {
    it("preserves committed message and skips duplicate insert on confirmation failure retry", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60001;

      // Fail outgoing transport delivery on first attempt
      fakeTransport.failSendWith = "Temporary Telegram network timeout";

      const req = createWebhookRequest({
        update_id: 30030,
        message: {
          message_id: 301,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "RetryUser" },
          text: "A durable message that survives confirmation crash",
        },
      });

      // First attempt fails during Telegram transport send
      const res1 = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res1.status).toBe(500);

      // Verify update record recorded safe diagnostic error and has receipt!
      const [upd] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 30030));

      expect(upd.processedAt).toBeNull();
      expect(upd.processingError).toBe("category=api_error");

      const payload = upd.payload as { receipt?: { kind: string; reference: string } };
      expect(payload.receipt).toBeDefined();
      expect(payload.receipt?.kind).toBe("message");
      const savedRef = payload.receipt!.reference;

      // Exactly ONE message row committed
      const msgsAfterAttempt1 = await db.select().from(inquiryMessage);
      const matching1 = msgsAfterAttempt1.filter(
        (m) => m.body === "A durable message that survives confirmation crash",
      );
      expect(matching1).toHaveLength(1);

      // Now Telegram retries the exact same update_id after transport recovers
      fakeTransport.failSendWith = null;
      fakeTransport.clear();

      const req2 = createWebhookRequest({
        update_id: 30030,
        message: {
          message_id: 301,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "RetryUser" },
          text: "A durable message that survives confirmation crash",
        },
      });

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res2.status).toBe(200);

      // Exactly ONE message row exists (NO duplicate inserted on retry!)
      const msgsAfterAttempt2 = await db.select().from(inquiryMessage);
      const matching2 = msgsAfterAttempt2.filter(
        (m) => m.body === "A durable message that survives confirmation crash",
      );
      expect(matching2).toHaveLength(1);

      // Confirmation delivered using recovered receipt
      expect(fakeTransport.sentMessages).toHaveLength(1);
      expect(fakeTransport.sentMessages[0].text).toContain(`Support inquiry opened (Reference: ${savedRef})`);

      // Update marked processed
      const [updAfter] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 30030));
      expect(updAfter.processedAt).not.toBeNull();
      expect(updAfter.processingError).toBeNull();
    });

    it("does not reroute text if another conversation was opened between initial commit and retry", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60002;

      fakeTransport.failSendWith = "Outbound gateway failure";

      const req = createWebhookRequest({
        update_id: 30031,
        message: {
          message_id: 302,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "StableUser" },
          text: "Message bound to initial conversation",
        },
      });

      // First attempt creates thread 1 and commits message, then fails on outgoing confirmation
      const res1 = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res1.status).toBe(500);

      const [upd] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 30031));
      const receipt = (upd.payload as { receipt?: { inquiryId: string } })?.receipt;
      const boundInquiryId = receipt!.inquiryId;

      // Meanwhile, customer opens another inquiry (e.g. for Prod A)
      const custRow = (await db.select().from(customer).where(eq(customer.telegramId, customerId)))[0];
      await db.insert(inquiry).values({
        customerId: custRow.id,
        productId: prodAId,
        reference: "INQ-COMPETE",
        productSnapshot: { name: "Laptop Pro 14", price: "999.00" },
        status: "open",
      });

      // Retry arrives
      fakeTransport.failSendWith = null;
      fakeTransport.clear();

      const req2 = createWebhookRequest({
        update_id: 30031,
        message: {
          message_id: 302,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "StableUser" },
          text: "Message bound to initial conversation",
        },
      });

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);

      // Message is still on the ORIGINAL bound inquiry, NOT rerouted to INQ-COMPETE
      const [msg] = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.body, "Message bound to initial conversation"));

      expect(msg.inquiryId).toBe(boundInquiryId);
    });

    it("does not reopen a closed thread through retries", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60003;

      fakeTransport.failSendWith = "Temporary socket error";

      const req = createWebhookRequest({
        update_id: 30032,
        message: {
          message_id: 303,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "CloseRetryUser" },
          text: "Message before closure",
        },
      });

      // Commit message, fail transport
      const res1 = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res1.status).toBe(500);

      const [upd] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 30032));
      const receipt = (upd.payload as { receipt?: { inquiryId: string } })?.receipt;
      const targetInquiryId = receipt!.inquiryId;

      // Thread is closed (e.g. admin closes it)
      await db
        .update(inquiry)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(inquiry.id, targetInquiryId));

      // Retry arrives
      fakeTransport.failSendWith = null;
      fakeTransport.clear();

      const req2 = createWebhookRequest({
        update_id: 30032,
        message: {
          message_id: 303,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "CloseRetryUser" },
          text: "Message before closure",
        },
      });

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);

      // Status remains strictly 'closed' — retry does NOT reopen it
      const [inqAfter] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, targetInquiryId));

      expect(inqAfter.status).toBe("closed");
      expect(inqAfter.closedAt).not.toBeNull();
    });

    it("rejects overlong text (> 4096 chars) with safe guidance and zero writes", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60004;

      const overlongText = "a".repeat(4097);

      const req = createWebhookRequest({
        update_id: 30033,
        message: {
          message_id: 304,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "LongUser" },
          text: overlongText,
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages[0].text).toBe("Message is too long (maximum 4096 characters).");

      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.telegramMessageId, 304));
      expect(msgs).toHaveLength(0);
    });

    it("rejects blank whitespace text with safe guidance and zero writes", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60005;

      const req = createWebhookRequest({
        update_id: 30034,
        message: {
          message_id: 305,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "BlankUser" },
          text: "   \n\t   ",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages[0].text).toBe("Please send a non-empty message.");

      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.telegramMessageId, 305));
      expect(msgs).toHaveLength(0);
    });

    it("inquiry_freeze_context trigger rejects mutating productSnapshot or selectedOptions", async () => {
      const db = testDb!.db;
      const [anyInq] = await db.select().from(inquiry).limit(1);

      await expect(
        db
          .update(inquiry)
          .set({ productSnapshot: { name: "Hacked" } })
          .where(eq(inquiry.id, anyInq.id)),
      ).rejects.toThrow();

      await expect(
        db
          .update(inquiry)
          .set({ selectedOptions: ["HackedOption"] })
          .where(eq(inquiry.id, anyInq.id)),
      ).rejects.toThrow();
    });

    it("delivers truthful Arabic feedback when customer language is Arabic", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const customerId = 60006;

      const req = createWebhookRequest({
        update_id: 30035,
        message: {
          message_id: 306,
          chat: { id: customerId, type: "private" },
          from: { id: customerId, is_bot: false, first_name: "عمر", language_code: "ar" },
          text: "مرحبا، أود الاستفسار عن خدمة الشحن.",
        },
      });

      const res = await handleTelegramWebhookRequest(req, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(res.status).toBe(200);
      expect(fakeTransport.sentMessages[0].text).toContain("تم فتح طلب الدعم (المرجع: INQ-");
      expect(fakeTransport.sentMessages[0].text).toContain("لقد استلمنا رسالتك.");
    });
  });

  describe("5. Phase 07 PR #18 Repair Regressions: Concurrency, Fencing, Atomic Routing & Recovery", () => {
    it("A. Concurrent support creation: same customer/category produces exactly one active thread with valid receipts", async () => {
      const sql1 = postgres(testDb!.url, { max: 1 });
      const sql2 = postgres(testDb!.url, { max: 1 });
      const sqlGate = postgres(testDb!.url, { max: 1 });
      const db1 = drizzle(sql1);
      const db2 = drizzle(sql2);

      try {
        const custA = await upsertCustomer(asAppDb(db1), {
          telegramId: 70001,
          firstName: "Concurrent",
          lastName: "SupportCust",
        });

        // Seed 2 update rows
        await sql1`INSERT INTO telegram_update (update_id, update_type, payload) VALUES
          (80001, 'callback_query', jsonb_build_object('attemptId', 'att-80001')),
          (80002, 'callback_query', jsonb_build_object('attemptId', 'att-80002'))`;

        // Explicit Gate: sqlGate holds customer lock, ensuring both p1 and p2 queue in PostgreSQL
        await sqlGate.unsafe(`BEGIN; SELECT id FROM customer WHERE id = '${custA.id}' FOR UPDATE;`);

        const p1 = createOrResumeSupportInquiry(asAppDb(db1), {
          customerId: custA.id,
          category: null,
          updateId: 80001,
          attemptId: "att-80001",
        });

        const p2 = createOrResumeSupportInquiry(asAppDb(db2), {
          customerId: custA.id,
          category: null,
          updateId: 80002,
          attemptId: "att-80002",
        });

        // Give both queries time to enter PostgreSQL and block on the gate
        await new Promise((r) => setTimeout(r, 60));

        // Release the lock gate: PostgreSQL serializes them on the customer lock
        await sqlGate.unsafe("COMMIT;");

        const [r1, r2] = await Promise.all([p1, p2]);

        // Assert: Exactly ONE active support thread exists
        const allSupport = await sql1`
          SELECT id, reference, status FROM inquiry
          WHERE customer_id = ${custA.id}::uuid AND product_id IS NULL AND status IN ('open', 'waiting_on_customer')
        `;
        expect(allSupport).toHaveLength(1);

        // Both requests received the exact same active inquiry
        expect(r1.inquiry.id).toBe(r2.inquiry.id);
        expect(r1.inquiry.reference).toBe(r2.inquiry.reference);
        const resumeFlags = [r1.isResume, r2.isResume];
        expect(resumeFlags).toContain(false);
        expect(resumeFlags).toContain(true);

        // Receipts in both update rows are valid and non-null
        const [upd1] = await sql1`SELECT payload FROM telegram_update WHERE update_id = 80001`;
        const [upd2] = await sql1`SELECT payload FROM telegram_update WHERE update_id = 80002`;
        expect(upd1.payload.receipt.inquiryId).toBe(r1.inquiry.id);
        expect(upd2.payload.receipt.inquiryId).toBe(r1.inquiry.id);

        // Different category produces a distinct active thread
        await sql1`INSERT INTO telegram_update (update_id, update_type, payload) VALUES
          (80003, 'callback_query', jsonb_build_object('attemptId', 'att-80003'))`;

        const r3 = await createOrResumeSupportInquiry(asAppDb(db1), {
          customerId: custA.id,
          category: "Billing",
          updateId: 80003,
          attemptId: "att-80003",
        });
        expect(r3.inquiry.id).not.toBe(r1.inquiry.id);
        expect(r3.inquiry.category).toBe("Billing");
      } finally {
        await sql1.end();
        await sql2.end();
        await sqlGate.end();
      }
    });

    it("B. Concurrent product creation: exactly one active thread with valid non-null receipts", async () => {
      const sql1 = postgres(testDb!.url, { max: 1 });
      const sql2 = postgres(testDb!.url, { max: 1 });
      const sqlGate = postgres(testDb!.url, { max: 1 });
      const db1 = drizzle(sql1);
      const db2 = drizzle(sql2);

      try {
        const custB = await upsertCustomer(asAppDb(db1), {
          telegramId: 70002,
          firstName: "Concurrent",
          lastName: "ProdCust",
        });

        await sql1`INSERT INTO telegram_update (update_id, update_type, payload) VALUES
          (80011, 'callback_query', jsonb_build_object('attemptId', 'att-80011')),
          (80012, 'callback_query', jsonb_build_object('attemptId', 'att-80012'))`;

        // Explicit Gate: sqlGate holds customer lock, ensuring both p1 and p2 queue in PostgreSQL
        await sqlGate.unsafe(`BEGIN; SELECT id FROM customer WHERE id = '${custB.id}' FOR UPDATE;`);

        const p1 = createOrResumeProductInquiry(asAppDb(db1), {
          customerId: custB.id,
          productId: prodAId,
          productSnapshot: { name: "Laptop Pro 14", price: "999.00", currency: "USD" },
          selectedOptions: ["Option 1"],
          updateId: 80011,
          attemptId: "att-80011",
        });

        const p2 = createOrResumeProductInquiry(asAppDb(db2), {
          customerId: custB.id,
          productId: prodAId,
          productSnapshot: { name: "Laptop Pro 14", price: "999.00", currency: "USD" },
          selectedOptions: ["Option 1"],
          updateId: 80012,
          attemptId: "att-80012",
        });

        await new Promise((r) => setTimeout(r, 60));

        await sqlGate.unsafe("COMMIT;");

        const [r1, r2] = await Promise.all([p1, p2]);

        const allProdInq = await sql1`
          SELECT id, reference FROM inquiry
          WHERE customer_id = ${custB.id}::uuid AND product_id = ${prodAId}::uuid AND status IN ('open', 'waiting_on_customer')
        `;
        expect(allProdInq).toHaveLength(1);
        expect(r1.inquiry.id).toBe(r2.inquiry.id);
        const resumeFlags = [r1.isResume, r2.isResume];
        expect(resumeFlags).toContain(false);
        expect(resumeFlags).toContain(true);

        const [upd1] = await sql1`SELECT payload FROM telegram_update WHERE update_id = 80011`;
        const [upd2] = await sql1`SELECT payload FROM telegram_update WHERE update_id = 80012`;
        expect(upd1.payload.receipt.inquiryId).toBe(r1.inquiry.id);
        expect(upd2.payload.receipt.inquiryId).toBe(r1.inquiry.id);
      } finally {
        await sql1.end();
        await sql2.end();
        await sqlGate.end();
      }
    });

    it("C. Stale attempt fencing: replaces attempt ownership before write, creating zero rows", async () => {
      const db = testDb!.db;
      const custC = await upsertCustomer(asAppDb(db), {
        telegramId: 70003,
        firstName: "Stale",
        lastName: "AttemptCust",
      });

      // Update claimed under attempt-1
      await db.insert(telegramUpdate).values({
        updateId: 80020,
        updateType: "message",
        payload: { attemptId: "attempt-1", claimedAt: new Date().toISOString() },
        processedAt: null,
      });

      // Competing worker steals ownership -> sets attemptId: "attempt-2"
      await db
        .update(telegramUpdate)
        .set({
          payload: { attemptId: "attempt-2", claimedAt: new Date().toISOString() },
        })
        .where(eq(telegramUpdate.updateId, 80020));

      // Attempt-1 attempts to run createOrResumeProductInquiry -> MUST FAIL
      await expect(
        createOrResumeProductInquiry(asAppDb(db), {
          customerId: custC.id,
          productId: prodAId,
          productSnapshot: { name: "Laptop", price: "999.00" },
          updateId: 80020,
          attemptId: "attempt-1",
        }),
      ).rejects.toThrow();

      // Zero inquiries created for customer C
      const inqs = await db.select().from(inquiry).where(eq(inquiry.customerId, custC.id));
      expect(inqs).toHaveLength(0);

      // Attempt-1 attempts to run routeAndAppendCustomerText -> MUST FAIL
      await expect(
        routeAndAppendCustomerText(asAppDb(db), {
          customerId: custC.id,
          body: "Hello from stale worker",
          telegramMessageId: 1001,
          updateId: 80020,
          attemptId: "attempt-1",
        }),
      ).rejects.toThrow();

      // Zero messages and zero inquiries created
      const inqs2 = await db.select().from(inquiry).where(eq(inquiry.customerId, custC.id));
      expect(inqs2).toHaveLength(0);

      const msgs = await db.select().from(inquiryMessage);
      const staleMsgs = msgs.filter((m) => m.body === "Hello from stale worker");
      expect(staleMsgs).toHaveLength(0);

      // Telegram update payload receipt was NOT written for attempt-1
      const [upd] = await db
        .select()
        .from(telegramUpdate)
        .where(eq(telegramUpdate.updateId, 80020));
      expect((upd.payload as Record<string, unknown>).receipt).toBeUndefined();
    });

    it("D. Inactive or foreign destination: reject direct write and controlled close-before-append", async () => {
      const db = testDb!.db;
      const custOwner = await upsertCustomer(asAppDb(db), {
        telegramId: 70004,
        firstName: "Owner",
      });
      const custAttacker = await upsertCustomer(asAppDb(db), {
        telegramId: 70005,
        firstName: "Attacker",
      });

      // Create inquiry for custOwner
      await db.insert(telegramUpdate).values({
        updateId: 80031,
        updateType: "callback_query",
        payload: { attemptId: "att-80031" },
      });
      const inqResult = await createOrResumeSupportInquiry(asAppDb(db), {
        customerId: custOwner.id,
        category: null,
        updateId: 80031,
        attemptId: "att-80031",
      });

      // 1. Foreign customer attempts append to custOwner's inquiry
      await db.insert(telegramUpdate).values({
        updateId: 80032,
        updateType: "message",
        payload: { attemptId: "att-80032" },
      });
      await expect(
        appendInboundCustomerMessage(asAppDb(db), {
          customerId: custAttacker.id,
          inquiryId: inqResult.inquiry.id,
          reference: inqResult.inquiry.reference,
          body: "Injected text",
          telegramMessageId: 9001,
          updateId: 80032,
          attemptId: "att-80032",
        }),
      ).rejects.toThrow();

      // Zero message rows created
      const msgs1 = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inqResult.inquiry.id));
      expect(msgs1).toHaveLength(0);

      // 2. Controlled close-before-append: close inquiry, then customer attempts to append
      await db
        .update(inquiry)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(inquiry.id, inqResult.inquiry.id));

      await db.insert(telegramUpdate).values({
        updateId: 80033,
        updateType: "message",
        payload: { attemptId: "att-80033" },
      });

      await expect(
        appendInboundCustomerMessage(asAppDb(db), {
          customerId: custOwner.id,
          inquiryId: inqResult.inquiry.id,
          reference: inqResult.inquiry.reference,
          body: "Text to closed inquiry",
          telegramMessageId: 9002,
          updateId: 80033,
          attemptId: "att-80033",
        }),
      ).rejects.toThrow();

      const msgs2 = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inqResult.inquiry.id));
      expect(msgs2).toHaveLength(0);

      // Inquiry remains closed
      const [inqAfter] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, inqResult.inquiry.id));
      expect(inqAfter.status).toBe("closed");
    });

    it("E. Atomic zero-active flow: failure rollback leaves zero partial support threads and clean retry", async () => {
      const db = testDb!.db;
      const custE = await upsertCustomer(asAppDb(db), {
        telegramId: 70006,
        firstName: "ZeroActiveCust",
      });

      // 1. Stale attempt failure: transaction aborts
      await db.insert(telegramUpdate).values({
        updateId: 80040,
        updateType: "message",
        payload: { attemptId: "att-fresh" },
      });

      await expect(
        routeAndAppendCustomerText(asAppDb(db), {
          customerId: custE.id,
          body: "Initial text that should roll back",
          telegramMessageId: 4001,
          updateId: 80040,
          attemptId: "att-STALE",
        }),
      ).rejects.toThrow();

      // Verify no partial support inquiry was committed
      const inqs = await db.select().from(inquiry).where(eq(inquiry.customerId, custE.id));
      expect(inqs).toHaveLength(0);

      // 2. Successful execution saves one message to one support thread
      const routeRes = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custE.id,
        body: "Durable first text",
        telegramMessageId: 4002,
        updateId: 80040,
        attemptId: "att-fresh",
      });

      expect(routeRes.status).toBe("saved");
      if (routeRes.status === "saved") {
        expect(routeRes.isNewSupport).toBe(true);
        expect(routeRes.message.body).toBe("Durable first text");

        // Receipt was recorded
        const [upd] = await db
          .select()
          .from(telegramUpdate)
          .where(eq(telegramUpdate.updateId, 80040));
        expect((upd.payload as { receipt: Record<string, unknown> }).receipt.kind).toBe("message");
        expect((upd.payload as { receipt: Record<string, unknown> }).receipt.isNewSupport).toBe(true);
      }
    });

    it("F. Post-commit retry: confirmation failure does not reroute or duplicate when new inquiry opened", async () => {
      const db = testDb!.db;
      const custF = await upsertCustomer(asAppDb(db), {
        telegramId: 70007,
        firstName: "PostCommitCust",
      });

      // First webhook request with failing transport
      const failingTransport = createFakeTelegramTransport();
      failingTransport.sendMessage = async () => {
        return { ok: false, error: "Network timeout", errorKind: "timeout" };
      };

      const req1 = createWebhookRequest({
        update_id: 80050,
        message: {
          message_id: 501,
          chat: { id: 70007, type: "private" },
          from: { id: 70007, is_bot: false, first_name: "PostCommitCust" },
          text: "Message destined for thread 1",
        },
      });

      const res1 = await handleTelegramWebhookRequest(req1, {
        db: asAppDb(db),
        transport: failingTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      // Transport failed -> HTTP 500
      expect(res1.status).toBe(500);

      // But message was committed!
      const msgs = await db.select().from(inquiryMessage);
      const savedMsg = msgs.find((m) => m.body === "Message destined for thread 1");
      expect(savedMsg).toBeDefined();

      const [origInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, savedMsg!.inquiryId));

      // Meanwhile, customer creates a SECOND inquiry (e.g. for product B)
      await db.insert(telegramUpdate).values({
        updateId: 80051,
        updateType: "callback_query",
        payload: { attemptId: "att-80051" },
      });
      await createOrResumeProductInquiry(asAppDb(db), {
        customerId: custF.id,
        productId: prodBId,
        productSnapshot: { name: "Laptop Max 16", price: "1499.00" },
        updateId: 80051,
        attemptId: "att-80051",
      });

      // Now customer has 2 active inquiries!
      // When update 80050 is retried by Telegram, it MUST NOT treat it as ambiguous and MUST NOT reroute!
      const workingTransport = createFakeTelegramTransport();
      const req2 = createWebhookRequest({
        update_id: 80050,
        message: {
          message_id: 501,
          chat: { id: 70007, type: "private" },
          from: { id: 70007, is_bot: false, first_name: "PostCommitCust" },
          text: "Message destined for thread 1",
        },
      });

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: workingTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);

      // Confirmation acknowledges the ORIGINAL inquiry reference
      expect(workingTransport.sentMessages[0].text).toContain(origInq.reference);

      // Exactly ONE message row exists (zero duplicate message)
      const msgsAfter = await db.select().from(inquiryMessage);
      const matchingMsgs = msgsAfter.filter((m) => m.body === "Message destined for thread 1");
      expect(matchingMsgs).toHaveLength(1);
    });

    it("G. Callback recovery: catalog changed/disabled after commit preserves frozen snapshot", async () => {
      const db = testDb!.db;
      const custG = await upsertCustomer(asAppDb(db), {
        telegramId: 70008,
        firstName: "RecoveryCust",
      });

      // 1. Initial product inquiry callback commit fails on confirmation delivery
      const failingTransport = createFakeTelegramTransport();
      failingTransport.editMessageText = async () => {
        return { ok: false, error: "Network timeout", errorKind: "timeout" };
      };

      const req1 = createWebhookRequest({
        update_id: 80060,
        callback_query: {
          id: "cb_80060",
          from: { id: 70008, is_bot: false, first_name: "RecoveryCust" },
          data: tokens.action(startInqActId),
          message: {
            message_id: 601,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 70008, type: "private" },
            text: "Product Card",
          },
        },
      });

      const res1 = await handleTelegramWebhookRequest(req1, {
        db: asAppDb(db),
        transport: failingTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res1.status).toBe(500);

      // Verify inquiry was committed
      const inqs = await db.select().from(inquiry).where(eq(inquiry.customerId, custG.id));
      expect(inqs).toHaveLength(1);
      const committedInq = inqs[0];

      // 2. Catalog changes after commit:
      // - Product price changed from 999.00 to 1999.00
      // - Product name changed
      // - Product action disabled (is_active = false)
      await db
        .update(product)
        .set({ price: "1999.00" })
        .where(eq(product.id, prodAId));
      await db
        .update(productAction)
        .set({ isActive: false })
        .where(eq(productAction.id, startInqActId));

      // 3. Retry arrives
      const workingTransport = createFakeTelegramTransport();
      const req2 = createWebhookRequest({
        update_id: 80060,
        callback_query: {
          id: "cb_80060",
          from: { id: 70008, is_bot: false, first_name: "RecoveryCust" },
          data: tokens.action(startInqActId),
          message: {
            message_id: 601,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 70008, type: "private" },
            text: "Product Card",
          },
        },
      });

      const res2 = await handleTelegramWebhookRequest(req2, {
        db: asAppDb(db),
        transport: workingTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(res2.status).toBe(200);

      // Must succeed and render the FROZEN price and name, NOT 1999.00, and NOT option unavailable!
      expect(workingTransport.editedMessages).toHaveLength(1);
      const editedText = workingTransport.editedMessages[0].text;
      expect(editedText).toContain("Laptop Pro 14");
      expect(editedText).toContain("1199.00 USD");
      expect(editedText).not.toContain("1999.00");
      expect(editedText).toContain(committedInq.reference);

      // Restore product price and action for subsequent tests
      await db
        .update(product)
        .set({ price: "1199.00" })
        .where(eq(product.id, prodAId));
      await db
        .update(productAction)
        .set({ isActive: true })
        .where(eq(productAction.id, startInqActId));
    });

    it("H. Contracts: whitespace preservation, multiline commands, pagination > 10, not_editable fallback", async () => {
      const db = testDb!.db;
      const custH = await upsertCustomer(asAppDb(db), {
        telegramId: 70009,
        firstName: "ContractsCust",
      });

      // 1. Whitespace preservation in ordinary text
      await db.insert(telegramUpdate).values({
        updateId: 80071,
        updateType: "message",
        payload: { attemptId: "att-80071" },
      });

      const rawCustomerText = "   hello   \n\n  world   ";
      const routeRes = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custH.id,
        body: rawCustomerText,
        telegramMessageId: 701,
        updateId: 80071,
        attemptId: "att-80071",
      });
      expect(routeRes.status).toBe("saved");
      if (routeRes.status === "saved") {
        expect(routeRes.message.body).toBe(rawCustomerText); // Exact raw content preserved!
      }

      // 2. Whitespace preservation in /reply command body
      const [activeInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.customerId, custH.id))
        .limit(1);

      const fakeTransport = createFakeTelegramTransport();
      const replyReq = createWebhookRequest({
        update_id: 80072,
        message: {
          message_id: 702,
          chat: { id: 70009, type: "private" },
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          text: `/reply ${activeInq.reference}   line1  \n  line2   `,
        },
      });

      await handleTelegramWebhookRequest(replyReq, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      const msgs = await db.select().from(inquiryMessage);
      const replyMsg = msgs.find((m) => m.telegramMessageId === 702);
      expect(replyMsg).toBeDefined();
      expect(replyMsg!.body).toBe("  line1  \n  line2   "); // Body after ref preserved!

      // 3. Multiline unknown command returns guidance, 0 message rows
      const multilineCmdReq = createWebhookRequest({
        update_id: 80073,
        message: {
          message_id: 703,
          chat: { id: 70009, type: "private" },
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          text: "/mycommand@bot\nThis is multiline text under command",
        },
      });
      const transport3 = createFakeTelegramTransport();
      await handleTelegramWebhookRequest(multilineCmdReq, {
        db: asAppDb(db),
        transport: transport3,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(transport3.sentMessages[0].text).toContain("/start");
      const msgs3 = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.telegramMessageId, 703));
      expect(msgs3).toHaveLength(0);

      // 4. More than 10 active references remain reachable via pagination
      // Seed 12 active inquiries for custH
      for (let i = 0; i < 11; i++) {
        await db.insert(inquiry).values({
          customerId: custH.id,
          reference: `INQ-TEST${i}X`,
          status: "open",
          productSnapshot: { type: "support" },
          category: `Dept ${i}`,
        });
      }

      // Customer sends text -> triggers ambiguous response
      const ambigTransport = createFakeTelegramTransport();
      const ambigReq = createWebhookRequest({
        update_id: 80074,
        message: {
          message_id: 704,
          chat: { id: 70009, type: "private" },
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          text: "Which inquiry does this go to?",
        },
      });
      await handleTelegramWebhookRequest(ambigReq, {
        db: asAppDb(db),
        transport: ambigTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(ambigTransport.sentMessages[0].text).toContain("multiple active inquiries");
      expect(ambigTransport.sentMessages[0].replyMarkup?.inline_keyboard).toBeDefined();

      // Keyboard has Next button pointing to page 2 (inq:2)
      const kb = ambigTransport.sentMessages[0].replyMarkup!.inline_keyboard;
      const nextBtn = kb.flat().find((b) => b.callback_data === "inq:2");
      expect(nextBtn).toBeDefined();

      // Tap inq:2 callback query
      const p2Transport = createFakeTelegramTransport();
      const p2Req = createWebhookRequest({
        update_id: 80075,
        callback_query: {
          id: "cb_inq2",
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          data: "inq:2",
          message: {
            message_id: 705,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 70009, type: "private" },
            text: "List Page 1",
          },
        },
      });
      await handleTelegramWebhookRequest(p2Req, {
        db: asAppDb(db),
        transport: p2Transport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(p2Transport.editedMessages).toHaveLength(1);
      const p2Kb = p2Transport.editedMessages[0].replyMarkup!.inline_keyboard;
      const prevBtn = p2Kb.flat().find((b) => b.callback_data === "inq");
      const next3Btn = p2Kb.flat().find((b) => b.callback_data === "inq:3");
      expect(prevBtn).toBeDefined();
      expect(next3Btn).toBeDefined();

      // 5. not_editable fallback vs retryable network errors
      // When editMessageText returns not_editable: falls back to sendMessage
      const notEditableTransport = createFakeTelegramTransport();
      notEditableTransport.editMessageText = async () => ({
        ok: false,
        error: "Message is not modified",
        errorKind: "not_editable",
      });

      const fallbackReq = createWebhookRequest({
        update_id: 80076,
        callback_query: {
          id: "cb_fallback",
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          data: tokens.home(),
          message: {
            message_id: 706,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 70009, type: "private" },
            text: "Previous",
          },
        },
      });

      const fallbackRes = await handleTelegramWebhookRequest(fallbackReq, {
        db: asAppDb(db),
        transport: notEditableTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(fallbackRes.status).toBe(200);
      expect(notEditableTransport.sentMessages).toHaveLength(1); // Sent fallback message!

      // When editMessageText returns timeout: DOES NOT fall back to sendMessage, throws 500
      const timeoutTransport = createFakeTelegramTransport();
      timeoutTransport.editMessageText = async () => ({
        ok: false,
        error: "Connection timed out",
        errorKind: "timeout",
      });

      const timeoutReq = createWebhookRequest({
        update_id: 80077,
        callback_query: {
          id: "cb_timeout",
          from: { id: 70009, is_bot: false, first_name: "ContractsCust" },
          data: tokens.home(),
          message: {
            message_id: 707,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 70009, type: "private" },
            text: "Previous",
          },
        },
      });

      const timeoutRes = await handleTelegramWebhookRequest(timeoutReq, {
        db: asAppDb(db),
        transport: timeoutTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });
      expect(timeoutRes.status).toBe(500);
      expect(timeoutTransport.sentMessages).toHaveLength(0); // Zero replacement message sent!
    });

    it("I. Controlled concurrent closure on ordinary text routing with independent connections", async () => {
      const db = testDb!.db;
      const custI = await upsertCustomer(asAppDb(db), {
        telegramId: 70010,
        firstName: "ConcurrentCloseCust",
      });

      // Seed 1 active support inquiry for custI
      await db.insert(telegramUpdate).values({
        updateId: 80080,
        updateType: "message",
        payload: { attemptId: "att-80080" },
      });
      const inqRes = await createOrResumeSupportInquiry(asAppDb(db), {
        customerId: custI.id,
        category: null,
        updateId: 80080,
        attemptId: "att-80080",
      });
      const inqId = inqRes.inquiry.id;

      // 1. Independent connection 1 begins and holds uncommitted closure on inqId
      const sqlGate = postgres(testDb!.url, { max: 1 });
      let releaseGate: () => void;
      const gatePromise = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const tx1Promise = sqlGate.begin(async (sqlTx) => {
        // Hold lock and update status to closed
        await sqlTx`UPDATE inquiry SET status = 'closed', closed_at = now() WHERE id = ${inqId}::uuid`;
        // Wait on release signal
        await gatePromise;
      });

      // Give connection 1 time to execute the update and hold the row lock
      await new Promise((r) => setTimeout(r, 80));

      // 2. Connection 2 attempts ordinary-text routing while status change is in flight
      await db.insert(telegramUpdate).values({
        updateId: 80081,
        updateType: "message",
        payload: { attemptId: "att-80081" },
      });

      const routePromise = routeAndAppendCustomerText(asAppDb(db), {
        customerId: custI.id,
        body: "Text dispatched while closure in flight",
        telegramMessageId: 801,
        updateId: 80081,
        attemptId: "att-80081",
      });
      const routeExpectPromise = expect(routePromise).rejects.toThrow();

      // Give connection 2 time to reach and block on the locked destination inquiry
      await new Promise((r) => setTimeout(r, 80));

      // 3. Commit closure on connection 1
      releaseGate!();
      await tx1Promise;
      await sqlGate.end();

      // 4. Connection 2 must fail safely with batch rollback
      await routeExpectPromise;

      // 5. Verification: zero messages land on closed inquiry, status remains closed, lastReplyAt is null, zero new support threads
      const msgs = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inqId));
      expect(msgs).toHaveLength(0);

      const [inqAfter] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, inqId));
      expect(inqAfter.status).toBe("closed");
      expect(inqAfter.lastReplyAt).toBeNull();

      const allInquiries = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.customerId, custI.id));
      expect(allInquiries).toHaveLength(1); // No new support inquiry was created!

      // 6. Test legitimate ordering: message commits BEFORE closure
      const custI2 = await upsertCustomer(asAppDb(db), {
        telegramId: 70011,
        firstName: "LegitOrderCust",
      });
      await db.insert(telegramUpdate).values({
        updateId: 80082,
        updateType: "message",
        payload: { attemptId: "att-80082" },
      });
      const inqRes2 = await createOrResumeSupportInquiry(asAppDb(db), {
        customerId: custI2.id,
        category: null,
        updateId: 80082,
        attemptId: "att-80082",
      });

      // Message commits first
      await db.insert(telegramUpdate).values({
        updateId: 80083,
        updateType: "message",
        payload: { attemptId: "att-80083" },
      });
      const legitRouteRes = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custI2.id,
        body: "Legit message before close",
        telegramMessageId: 802,
        updateId: 80083,
        attemptId: "att-80083",
      });
      expect(legitRouteRes.status).toBe("saved");

      // THEN closure commits
      await db
        .update(inquiry)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(inquiry.id, inqRes2.inquiry.id));

      const msgsLegit = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inqRes2.inquiry.id));
      expect(msgsLegit).toHaveLength(1);
      expect(msgsLegit[0].body).toBe("Legit message before close");

      const [inqLegitAfter] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, inqRes2.inquiry.id));
      expect(inqLegitAfter.status).toBe("closed");
      expect(inqLegitAfter.lastReplyAt).not.toBeNull();
    });

    it("J. Post-mutation rollback proof: fault injection suppresses receipt write, rolling back business writes", async () => {
      const db = testDb!.db;
      const rawSql = postgres(testDb!.url, { max: 1 });
      const custJ = await upsertCustomer(asAppDb(db), {
        telegramId: 70012,
        firstName: "FaultCust",
      });

      // Install temporary trigger that suppresses receipt update
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION fail_receipt_update() RETURNS trigger AS $$
        BEGIN
          IF NEW.payload ? 'receipt' THEN
            NEW.payload = NEW.payload - 'receipt';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER inject_receipt_suppress
          BEFORE UPDATE ON telegram_update
          FOR EACH ROW
          EXECUTE FUNCTION fail_receipt_update();
      `);

      try {
        await db.insert(telegramUpdate).values({
          updateId: 80090,
          updateType: "callback_query",
          payload: { attemptId: "att-80090" },
        });

        // Business mutation (support inquiry creation) executes, but receipt write is suppressed by trigger
        // Assertion query at end of batch must fail and roll back all mutations!
        await expect(
          createOrResumeSupportInquiry(asAppDb(db), {
            customerId: custJ.id,
            category: "FaultTest",
            updateId: 80090,
            attemptId: "att-80090",
          }),
        ).rejects.toThrow();

        // Verify rollback: no inquiry was committed
        const inqs = await db
          .select()
          .from(inquiry)
          .where(eq(inquiry.customerId, custJ.id));
        expect(inqs).toHaveLength(0);

        // Verify telegram_update has no receipt
        const [upd] = await db
          .select()
          .from(telegramUpdate)
          .where(eq(telegramUpdate.updateId, 80090));
        expect((upd.payload as Record<string, unknown>).receipt).toBeUndefined();
      } finally {
        await rawSql.unsafe(`
          DROP TRIGGER IF EXISTS inject_receipt_suppress ON telegram_update;
          DROP FUNCTION IF EXISTS fail_receipt_update();
        `);
        await rawSql.end();
      }
    });

    it("K. First support message persisted metadata on database rows and timestamp behavior", async () => {
      const db = testDb!.db;
      const custK = await upsertCustomer(asAppDb(db), {
        telegramId: 70013,
        firstName: "MetadataCust",
      });

      const beforeTime = Date.now() - 1000;

      // 1. First ordinary message with zero active inquiries
      await db.insert(telegramUpdate).values({
        updateId: 80100,
        updateType: "message",
        payload: { attemptId: "att-80100" },
      });

      const routeRes = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custK.id,
        body: "First support text",
        telegramMessageId: 1001,
        updateId: 80100,
        attemptId: "att-80100",
      });
      expect(routeRes.status).toBe("saved");
      if (routeRes.status !== "saved") return;

      // Inspect actual persisted database row, not just returned object
      const [persistedInq] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, routeRes.inquiry.id));

      expect(persistedInq.lastReplyAt).not.toBeNull();
      expect(persistedInq.lastReplyAt!.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(persistedInq.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(persistedInq.status).toBe("open");

      const firstReplyAt = persistedInq.lastReplyAt!;
      const firstUpdatedAt = persistedInq.updatedAt;

      // 2. Existing waiting_on_customer inquiry receiving a new message
      await db
        .update(inquiry)
        .set({ status: "waiting_on_customer" })
        .where(eq(inquiry.id, persistedInq.id));

      await new Promise((r) => setTimeout(r, 20));

      await db.insert(telegramUpdate).values({
        updateId: 80101,
        updateType: "message",
        payload: { attemptId: "att-80101" },
      });

      const routeRes2 = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custK.id,
        body: "Customer response to advance timestamps",
        telegramMessageId: 1002,
        updateId: 80101,
        attemptId: "att-80101",
      });
      expect(routeRes2.status).toBe("saved");

      const [persistedInq2] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, persistedInq.id));

      expect(persistedInq2.status).toBe("open");
      expect(persistedInq2.lastReplyAt!.getTime()).toBeGreaterThan(firstReplyAt.getTime());
      expect(persistedInq2.updatedAt.getTime()).toBeGreaterThan(firstUpdatedAt.getTime());

      // 3. Duplicate delivery does not advance timestamps again
      const replyAtBeforeDup = persistedInq2.lastReplyAt!;
      const updatedAtBeforeDup = persistedInq2.updatedAt;

      const dupRes = await routeAndAppendCustomerText(asAppDb(db), {
        customerId: custK.id,
        body: "Customer response to advance timestamps",
        telegramMessageId: 1002,
        updateId: 80101,
        attemptId: "att-80101",
      });
      expect(dupRes.status).toBe("saved");
      if (dupRes.status === "saved") {
        expect(dupRes.isDuplicate).toBe(true);
      }

      const [persistedInqDup] = await db
        .select()
        .from(inquiry)
        .where(eq(inquiry.id, persistedInq.id));

      expect(persistedInqDup.lastReplyAt!.getTime()).toBe(replyAtBeforeDup.getTime());
      expect(persistedInqDup.updatedAt.getTime()).toBe(updatedAtBeforeDup.getTime());
    });

    it("L. Command recognition & stable pagination tie-breaker contracts", async () => {
      const db = testDb!.db;
      const fakeTransport = createFakeTelegramTransport();
      const custL = await upsertCustomer(asAppDb(db), {
        telegramId: 70014,
        firstName: "CommandCust",
      });

      // 1. Leading whitespace followed by unknown multiline slash command: returns guidance, 0 message rows
      const leadingSpaceCmdReq = createWebhookRequest({
        update_id: 80110,
        message: {
          message_id: 1101,
          chat: { id: 70014, type: "private" },
          from: { id: 70014, is_bot: false, first_name: "CommandCust" },
          text: "   /unknowncmd\nLine two of unknown command",
        },
      });

      await handleTelegramWebhookRequest(leadingSpaceCmdReq, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(fakeTransport.sentMessages[0].text).toContain("/start");
      const msgs1 = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.telegramMessageId, 1101));
      expect(msgs1).toHaveLength(0);

      // 2. /replyall is treated as an unknown command, NOT /reply
      fakeTransport.clear();
      const replyallReq = createWebhookRequest({
        update_id: 80111,
        message: {
          message_id: 1102,
          chat: { id: 70014, type: "private" },
          from: { id: 70014, is_bot: false, first_name: "CommandCust" },
          text: "/replyall INQ-TEST Hello to all",
        },
      });

      await handleTelegramWebhookRequest(replyallReq, {
        db: asAppDb(db),
        transport: fakeTransport,
        botToken: TEST_BOT_TOKEN,
        webhookSecret: TEST_WEBHOOK_SECRET,
      });

      expect(fakeTransport.sentMessages[0].text).toContain("/start");
      const msgs2 = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.telegramMessageId, 1102));
      expect(msgs2).toHaveLength(0);

      // 3. Stable pagination tie-breaker with identical updated_at across pages
      const fixedTime = new Date("2026-10-25T12:00:00Z");
      const seededRefs: string[] = [];
      for (let i = 0; i < 9; i++) {
        const ref = `INQ-TIE${i}`;
        seededRefs.push(ref);
        await db.insert(inquiry).values({
          customerId: custL.id,
          reference: ref,
          status: "open",
          productSnapshot: { type: "support" },
          category: `TieCategory`,
          updatedAt: fixedTime,
          createdAt: fixedTime,
        });
      }

      // Fetch page 1 (pageSize 4), page 2 (pageSize 4), page 3 (pageSize 4)
      const p1 = await listActiveCustomerInquiriesPaged(asAppDb(db), custL.id, {
        page: 1,
        pageSize: 4,
      });
      const p2 = await listActiveCustomerInquiriesPaged(asAppDb(db), custL.id, {
        page: 2,
        pageSize: 4,
      });
      const p3 = await listActiveCustomerInquiriesPaged(asAppDb(db), custL.id, {
        page: 3,
        pageSize: 4,
      });

      expect(p1.inquiries).toHaveLength(4);
      expect(p2.inquiries).toHaveLength(4);
      expect(p3.inquiries).toHaveLength(1);

      const allFetchedRefs = [
        ...p1.inquiries.map((inq) => inq.reference),
        ...p2.inquiries.map((inq) => inq.reference),
        ...p3.inquiries.map((inq) => inq.reference),
      ];

      // Every reference reachable once with zero duplicates and zero omissions
      expect(new Set(allFetchedRefs).size).toBe(9);
      for (const ref of seededRefs) {
        expect(allFetchedRefs).toContain(ref);
      }
    });

    it("M. Real claim envelope rollback: JSON-null receipt suppression (Fault Form A - return NULL from trigger)", async () => {
      const db = testDb!.db;
      const rawSql = postgres(testDb!.url, { max: 1 });
      const custM = await upsertCustomer(asAppDb(db), {
        telegramId: 70020,
        firstName: "CustFaultM",
      });

      // Install trigger returning NULL on receipt write (skipping update, leaving initial receipt:null unchanged)
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION test_suppress_receipt_return_null() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'UPDATE' AND NEW.payload ? 'receipt' AND jsonb_typeof(NEW.payload->'receipt') = 'object' THEN
            RETURN NULL;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER test_inject_suppress_receipt
          BEFORE UPDATE ON telegram_update
          FOR EACH ROW
          EXECUTE FUNCTION test_suppress_receipt_return_null();
      `);

      try {
        // Exercise 1: Support inquiry creation
        const claim1 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80201,
          updateType: "callback_query",
          payload: { callback_query: { id: "cb-80201" } },
        });
        expect(claim1.status).toBe("claimed");
        // Confirm initial stored receipt is JSON null
        const [claimedRow1] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80201));
        expect((claimedRow1.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          createOrResumeSupportInquiry(asAppDb(db), {
            customerId: custM.id,
            category: "FaultMSupport",
            updateId: 80201,
            attemptId: claim1.attemptId,
          }),
        ).rejects.toThrow();

        // Verify zero inquiries survive
        const inqs1 = await db.select().from(inquiry).where(eq(inquiry.customerId, custM.id));
        expect(inqs1).toHaveLength(0);

        // Exercise 2: Zero-active ordinary text (creation + first message)
        const claim2 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80202,
          updateType: "message",
          payload: { message: { message_id: 9101, text: "Hello from zero active fault M" } },
        });
        expect(claim2.status).toBe("claimed");
        const [claimedRow2] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80202));
        expect((claimedRow2.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          routeAndAppendCustomerText(asAppDb(db), {
            customerId: custM.id,
            body: "Hello from zero active fault M",
            telegramMessageId: 9101,
            updateId: 80202,
            attemptId: claim2.attemptId,
          }),
        ).rejects.toThrow();

        // Also test via webhook request: returns 500, no success acknowledgment sent
        const fakeTransport2 = createFakeTelegramTransport();
        const req2 = createWebhookRequest({
          update_id: 80204,
          message: {
            message_id: 9104,
            chat: { id: 70020, type: "private" },
            from: { id: 70020, is_bot: false, first_name: "CustFaultM" },
            text: "Hello from zero active fault M webhook",
          },
        });

        const resp2 = await handleTelegramWebhookRequest(req2, {
          db: asAppDb(db),
          transport: fakeTransport2,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });
        expect(resp2.status).toBe(500);

        // Verify 0 inquiries and 0 messages survive for this customer/attempt
        const inqs2 = await db.select().from(inquiry).where(eq(inquiry.customerId, custM.id));
        expect(inqs2).toHaveLength(0);
        const msgs2 = await db.select().from(inquiryMessage).where(sql`${inquiryMessage.body} LIKE '%fault M%'`);
        expect(msgs2).toHaveLength(0);
        // Verify no success acknowledgement was sent
        expect(fakeTransport2.sentMessages).toHaveLength(0);

        // Exercise 3: Append to an existing waiting_on_customer inquiry
        const baselineTime = new Date("2026-10-25T10:00:00.000Z");
        const [existingInq] = await db
          .insert(inquiry)
          .values({
            customerId: custM.id,
            reference: "INQ-FLTM03",
            status: "waiting_on_customer",
            category: null,
            productSnapshot: { type: "support" },
            openedAt: baselineTime,
            lastReplyAt: baselineTime,
            createdAt: baselineTime,
            updatedAt: baselineTime,
          })
          .returning();

        const claim3 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80203,
          updateType: "message",
          payload: { message: { message_id: 9102, text: "reply to waiting inquiry" } },
        });
        expect(claim3.status).toBe("claimed");
        const [claimedRow3] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80203));
        expect((claimedRow3.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          appendInboundCustomerMessage(asAppDb(db), {
            customerId: custM.id,
            inquiryId: existingInq.id,
            reference: existingInq.reference,
            body: "reply to waiting inquiry",
            telegramMessageId: 9102,
            updateId: 80203,
            attemptId: claim3.attemptId,
          }),
        ).rejects.toThrow();

        // Verify 0 messages survive
        const msgs3 = await db.select().from(inquiryMessage).where(eq(inquiryMessage.inquiryId, existingInq.id));
        expect(msgs3).toHaveLength(0);

        // Verify existing inquiry status and timestamps remain untouched
        const [freshInq] = await db.select().from(inquiry).where(eq(inquiry.id, existingInq.id));
        expect(freshInq.status).toBe("waiting_on_customer");
        expect(freshInq.updatedAt.toISOString()).toBe(baselineTime.toISOString());
        expect(freshInq.lastReplyAt?.toISOString()).toBe(baselineTime.toISOString());
      } finally {
        await rawSql.unsafe(`
          DROP TRIGGER IF EXISTS test_inject_suppress_receipt ON telegram_update;
          DROP FUNCTION IF EXISTS test_suppress_receipt_return_null();
        `);
        await rawSql.end();
      }
    });

    it("N. Real claim envelope rollback: JSON-null receipt corruption (Fault Form B - replace receipt with JSON null)", async () => {
      const db = testDb!.db;
      const rawSql = postgres(testDb!.url, { max: 1 });
      const custN = await upsertCustomer(asAppDb(db), {
        telegramId: 70030,
        firstName: "CustFaultN",
      });

      // Install trigger replacing receipt with JSON null on update
      await rawSql.unsafe(`
        CREATE OR REPLACE FUNCTION test_corrupt_receipt_json_null() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'UPDATE' AND NEW.payload ? 'receipt' THEN
            NEW.payload = jsonb_set(NEW.payload, '{receipt}', 'null'::jsonb);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER test_inject_corrupt_receipt
          BEFORE UPDATE ON telegram_update
          FOR EACH ROW
          EXECUTE FUNCTION test_corrupt_receipt_json_null();
      `);

      try {
        // Exercise 1: Support inquiry creation
        const claim1 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80301,
          updateType: "callback_query",
          payload: { callback_query: { id: "cb-80301" } },
        });
        expect(claim1.status).toBe("claimed");
        const [claimedRow1] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80301));
        expect((claimedRow1.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          createOrResumeSupportInquiry(asAppDb(db), {
            customerId: custN.id,
            category: "FaultNSupport",
            updateId: 80301,
            attemptId: claim1.attemptId,
          }),
        ).rejects.toThrow();

        // Verify zero inquiries survive
        const inqs1 = await db.select().from(inquiry).where(eq(inquiry.customerId, custN.id));
        expect(inqs1).toHaveLength(0);

        // Exercise 2: Zero-active ordinary text (creation + first message)
        const claim2 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80302,
          updateType: "message",
          payload: { message: { message_id: 9201, text: "Hello from zero active fault N" } },
        });
        expect(claim2.status).toBe("claimed");
        const [claimedRow2] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80302));
        expect((claimedRow2.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          routeAndAppendCustomerText(asAppDb(db), {
            customerId: custN.id,
            body: "Hello from zero active fault N",
            telegramMessageId: 9201,
            updateId: 80302,
            attemptId: claim2.attemptId,
          }),
        ).rejects.toThrow();

        // Also test via webhook request: returns 500, no success acknowledgment sent
        const fakeTransport2 = createFakeTelegramTransport();
        const req2 = createWebhookRequest({
          update_id: 80304,
          message: {
            message_id: 9204,
            chat: { id: 70030, type: "private" },
            from: { id: 70030, is_bot: false, first_name: "CustFaultN" },
            text: "Hello from zero active fault N webhook",
          },
        });

        const resp2 = await handleTelegramWebhookRequest(req2, {
          db: asAppDb(db),
          transport: fakeTransport2,
          botToken: TEST_BOT_TOKEN,
          webhookSecret: TEST_WEBHOOK_SECRET,
        });
        expect(resp2.status).toBe(500);

        // Verify 0 inquiries and 0 messages survive for this customer/attempt
        const inqs2 = await db.select().from(inquiry).where(eq(inquiry.customerId, custN.id));
        expect(inqs2).toHaveLength(0);
        const msgs2 = await db.select().from(inquiryMessage).where(sql`${inquiryMessage.body} LIKE '%fault N%'`);
        expect(msgs2).toHaveLength(0);
        expect(fakeTransport2.sentMessages).toHaveLength(0);

        // Exercise 3: Append to an existing waiting_on_customer inquiry
        const baselineTime = new Date("2026-10-25T11:00:00.000Z");
        const [existingInq] = await db
          .insert(inquiry)
          .values({
            customerId: custN.id,
            reference: "INQ-FLTN03",
            status: "waiting_on_customer",
            category: null,
            productSnapshot: { type: "support" },
            openedAt: baselineTime,
            lastReplyAt: baselineTime,
            createdAt: baselineTime,
            updatedAt: baselineTime,
          })
          .returning();

        const claim3 = await claimTelegramUpdate(asAppDb(db), {
          updateId: 80303,
          updateType: "message",
          payload: { message: { message_id: 9202, text: "reply to waiting inquiry N" } },
        });
        expect(claim3.status).toBe("claimed");
        const [claimedRow3] = await db.select().from(telegramUpdate).where(eq(telegramUpdate.updateId, 80303));
        expect((claimedRow3.payload as { receipt: unknown }).receipt).toBeNull();

        await expect(
          appendInboundCustomerMessage(asAppDb(db), {
            customerId: custN.id,
            inquiryId: existingInq.id,
            reference: existingInq.reference,
            body: "reply to waiting inquiry N",
            telegramMessageId: 9202,
            updateId: 80303,
            attemptId: claim3.attemptId,
          }),
        ).rejects.toThrow();

        // Verify 0 messages survive
        const msgs3 = await db.select().from(inquiryMessage).where(eq(inquiryMessage.inquiryId, existingInq.id));
        expect(msgs3).toHaveLength(0);

        // Verify existing inquiry status and timestamps remain untouched
        const [freshInq] = await db.select().from(inquiry).where(eq(inquiry.id, existingInq.id));
        expect(freshInq.status).toBe("waiting_on_customer");
        expect(freshInq.updatedAt.toISOString()).toBe(baselineTime.toISOString());
        expect(freshInq.lastReplyAt?.toISOString()).toBe(baselineTime.toISOString());
      } finally {
        await rawSql.unsafe(`
          DROP TRIGGER IF EXISTS test_inject_corrupt_receipt ON telegram_update;
          DROP FUNCTION IF EXISTS test_corrupt_receipt_json_null();
        `);
        await rawSql.end();
      }
    });

    it("O. Direct receipt shape validation matrix: reject malformed shapes and accept valid outcomes", async () => {
      const db = testDb!.db;

      const testCases: Array<{
        name: string;
        payload: Record<string, unknown>;
        expectedKinds: ("inquiry" | "message" | "ambiguous" | "guidance")[];
        shouldPass: boolean;
      }> = [
        // Malformed / rejected shapes
        {
          name: "JSON null receipt",
          payload: { attemptId: "att-O", receipt: null },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "missing receipt key",
          payload: { attemptId: "att-O" },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "scalar string receipt",
          payload: { attemptId: "att-O", receipt: "inquiry" },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "scalar number receipt",
          payload: { attemptId: "att-O", receipt: 42 },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "array receipt",
          payload: { attemptId: "att-O", receipt: ["inquiry"] },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "empty object receipt",
          payload: { attemptId: "att-O", receipt: {} },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "inquiry missing reference",
          payload: { attemptId: "att-O", receipt: { kind: "inquiry", inquiryId: "inq-1" } },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "inquiry null inquiryId",
          payload: { attemptId: "att-O", receipt: { kind: "inquiry", inquiryId: null, reference: "INQ-123" } },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "inquiry empty inquiryId",
          payload: { attemptId: "att-O", receipt: { kind: "inquiry", inquiryId: "", reference: "INQ-123" } },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "inquiry whitespace reference",
          payload: { attemptId: "att-O", receipt: { kind: "inquiry", inquiryId: "inq-1", reference: "   " } },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "message missing reference",
          payload: { attemptId: "att-O", receipt: { kind: "message", inquiryId: "inq-1", messageId: "msg-1" } },
          expectedKinds: ["message"],
          shouldPass: false,
        },
        {
          name: "message when expecting inquiry",
          payload: { attemptId: "att-O", receipt: { kind: "message", inquiryId: "inq-1", messageId: "msg-1", reference: "INQ-1" } },
          expectedKinds: ["inquiry"],
          shouldPass: false,
        },
        {
          name: "ambiguous with scalar activeReferences",
          payload: { attemptId: "att-O", receipt: { kind: "ambiguous", activeReferences: "INQ-1" } },
          expectedKinds: ["message", "ambiguous"],
          shouldPass: false,
        },
        {
          name: "guidance with empty notice",
          payload: { attemptId: "att-O", receipt: { kind: "guidance", notice: "" } },
          expectedKinds: ["guidance"],
          shouldPass: false,
        },

        // Valid outcomes
        {
          name: "valid inquiry outcome",
          payload: { attemptId: "att-O", receipt: { kind: "inquiry", inquiryId: "inq-1", reference: "INQ-123" } },
          expectedKinds: ["inquiry"],
          shouldPass: true,
        },
        {
          name: "valid message outcome",
          payload: { attemptId: "att-O", receipt: { kind: "message", inquiryId: "inq-1", messageId: "msg-1", reference: "INQ-123" } },
          expectedKinds: ["message"],
          shouldPass: true,
        },
        {
          name: "valid ambiguous outcome",
          payload: { attemptId: "att-O", receipt: { kind: "ambiguous", activeReferences: ["INQ-1", "INQ-2"] } },
          expectedKinds: ["message", "ambiguous"],
          shouldPass: true,
        },
        {
          name: "valid guidance outcome",
          payload: { attemptId: "att-O", receipt: { kind: "guidance", notice: "Text only please" } },
          expectedKinds: ["guidance"],
          shouldPass: true,
        },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const testUpdateId = 80400 + i;

        await db.insert(telegramUpdate).values({
          updateId: testUpdateId,
          updateType: "message",
          payload: tc.payload,
          processedAt: null,
        });

        const assertQuery = createReceiptAssertionQuery(
          asAppDb(db),
          testUpdateId,
          "att-O",
          tc.expectedKinds,
        );

        if (tc.shouldPass) {
          const results = await executeAtomicBatch(asAppDb(db), [assertQuery]);
          const raw = results[0];
          const rows = Array.isArray(raw) ? raw : (raw as { rows: unknown[] })?.rows ?? [];
          expect((rows[0] as { assertion_status: string }).assertion_status, `Expected 'ok' for ${tc.name}`).toBe("ok");
        } else {
          await expect(
            executeAtomicBatch(asAppDb(db), [assertQuery]),
            `Expected rejection for ${tc.name}`,
          ).rejects.toThrow();
        }
      }
    });
  });
});
