import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";

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
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
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
      expect(fakeTransport.sentMessages[0].text).toContain(`Message received for inquiry ${savedRef}`);

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
});
