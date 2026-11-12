import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  botSetting,
  category,
  categoryTranslation,
  inquiry,
  language,
  messageTemplate,
  messageTranslation,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  sellerNotificationDelivery,
  sellerNotificationSetting,
  telegramUpdate,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  checkAndRecordTestCooldown,
  checkSellerNotificationCapability,
  claimDeliveryAttempt,
  createOrResumeProductInquiry,
  createOrResumeSupportInquiry,
  generateDeliveryReference,
  getSellerNotificationDelivery,
  getVerifiedNotificationConfig,
  markDeliveryFailed,
  markDeliveryUnknown,
  readSellerNotificationConfig,
  recordVerificationSuccess,
  routeAndAppendCustomerText,
  saveSellerNotificationConfig,
  setSellerNotificationEnabled,
  upsertCustomer,
} from "@/lib/data";
import {
  attemptSellerNotificationDelivery,
} from "@/lib/telegram/seller-notifications";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("seller_notifications");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

async function createTestInquiryRow(
  db: ReturnType<typeof asAppDb>,
  customerId: string,
): Promise<string> {
  const [row] = await db
    .insert(inquiry)
    .values({
      customerId,
      reference: `INQ-${crypto.randomUUID().slice(0, 8)}`,
      status: "open",
      category: "General",
      productSnapshot: { title: "Test Support" },
    })
    .returning();
  return row.id;
}

describe.skipIf(!shouldRun)("Seller Notification Bot v1 — Database Integration Tests", () => {
  let enLangId: string;
  let arLangId: string;
  let catId: string;
  let prodId: string;
  let actId: string;
  let fixtureCustomerId: string;

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

    // 2. Bot setting
    await db.insert(botSetting).values({
      defaultLanguageId: enLangId,
      currency: "USD",
      displayName: "Test Store",
      supportCategory: ["General", "Technical"],
    });

    // 3. Message templates
    const [inqTmpl] = await db
      .insert(messageTemplate)
      .values({
        key: "inquiry_received",
        title: "Inquiry Received",
        purpose: "Inquiry confirmation",
      })
      .returning();

    await db.insert(messageTranslation).values([
      { templateId: inqTmpl.id, languageId: enLangId, body: "Inquiry received" },
      { templateId: inqTmpl.id, languageId: arLangId, body: "تم استلام الطلب" },
    ]);

    // 4. Category & Product
    const [c] = await db
      .insert(category)
      .values({ slug: "items", sortOrder: 1, isActive: true })
      .returning();
    catId = c.id;

    await db.insert(categoryTranslation).values([
      { categoryId: catId, languageId: enLangId, name: "Items" },
      { categoryId: catId, languageId: arLangId, name: "عناصر" },
    ]);

    const [p] = await db
      .insert(product)
      .values({ categoryId: catId, slug: "sample-item", price: "10.00", sortOrder: 1, isActive: true })
      .returning();
    prodId = p.id;

    await db.insert(productTranslation).values([
      { productId: prodId, languageId: enLangId, name: "Sample Item" },
      { productId: prodId, languageId: arLangId, name: "عنصر تجريبي" },
    ]);

    const [act] = await db
      .insert(productAction)
      .values({
        productId: prodId,
        actionType: "START_INQUIRY",
        sortOrder: 1,
        isActive: true,
      })
      .returning();
    actId = act.id;

    await db.insert(productActionTranslation).values([
      { actionId: actId, languageId: enLangId, label: "Inquire" },
      { actionId: actId, languageId: arLangId, label: "استفسار" },
    ]);

    // 5. Fixture Customer
    const custFixture = await upsertCustomer(asAppDb(db), {
      telegramId: 99999,
      firstName: "Fixture Customer",
    });
    fixtureCustomerId = custFixture.id;
  });

  // =========================================================================
  // Group A Tests (6, 7, 8)
  // =========================================================================

  describe("Group A: Setup, Verification & Cooldown", () => {
    it("Test 6: Verified acknowledgment records verification metadata in DB", async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      await saveSellerNotificationConfig(appDb, {
        destinationChatId: "987654321",
        language: "ar",
      });

      const updated = await recordVerificationSuccess(appDb, {
        botId: 1234567,
        botUsername: "MawthoqAlertsBot",
        destinationChatId: "987654321",
      });

      expect(updated.verifiedBotId).toBe(1234567);
      expect(updated.verifiedBotUsername).toBe("MawthoqAlertsBot");
      expect(updated.verifiedChatId).toBe("987654321");
      expect(updated.verifiedAt).toBeDefined();

      const verifiedConfig = await getVerifiedNotificationConfig(appDb);
      // Still disabled until explicit enable
      expect(verifiedConfig).toBeNull();

      // Explicitly enable
      await setSellerNotificationEnabled(appDb, true);
      const activeConfig = await getVerifiedNotificationConfig(appDb);
      expect(activeConfig).not.toBeNull();
      expect(activeConfig?.destinationChatId).toBe("987654321");
    });

    it("Test 7: Modifying destination chat ID disables notifications, clears verification, and increments revision", async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      const before = await readSellerNotificationConfig(appDb);
      const initialRev = before?.revision ?? 1;

      // Change destination to a new valid chat ID
      const updated = await saveSellerNotificationConfig(appDb, {
        destinationChatId: "555444333",
        language: "en",
      });

      expect(updated.enabled).toBe(false);
      expect(updated.verifiedAt).toBeNull();
      expect(updated.verifiedBotId).toBeNull();
      expect(updated.verifiedChatId).toBeNull();
      expect(updated.revision).toBe(initialRev + 1);

      // Enabling when unverified throws error
      await expect(setSellerNotificationEnabled(appDb, true)).rejects.toThrow();
    });

    it("Test 8: Rapid repeat test sends are throttled via persisted cooldown", async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      // Reset cooldown timestamp before testing fresh cycle
      await testDb.db
        .update(sellerNotificationSetting)
        .set({ lastTestAt: null })
        .where(eq(sellerNotificationSetting.id, 1));

      const firstAttempt = await checkAndRecordTestCooldown(appDb, 5);
      expect(firstAttempt.allowed).toBe(true);

      const secondAttempt = await checkAndRecordTestCooldown(appDb, 5);
      expect(secondAttempt.allowed).toBe(false);
      expect(secondAttempt.remainingSeconds).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Group B Tests (9–16): Business Events & Uniqueness
  // =========================================================================

  describe("Group B: Business Events & Atomicity", () => {
    let customerAId: string;
    let customerBId: string;

    beforeAll(async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      // Verify and enable notification config for Group B
      await saveSellerNotificationConfig(appDb, {
        destinationChatId: "123456789",
        language: "ar",
      });
      await recordVerificationSuccess(appDb, {
        botId: 1234567,
        botUsername: "MawthoqAlertsBot",
        destinationChatId: "123456789",
      });
      await setSellerNotificationEnabled(appDb, true);

      const custA = await upsertCustomer(appDb, {
        telegramId: 10001,
        firstName: "Buyer A",
      });
      customerAId = custA.id;

      const custB = await upsertCustomer(appDb, {
        telegramId: 10002,
        firstName: "Buyer B",
      });
      customerBId = custB.id;
    });

    it("Test 9: New product inquiry emits exactly one durable new-inquiry delivery row in the same transaction", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const config = await getVerifiedNotificationConfig(appDb);
      expect(config).not.toBeNull();

      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900001,
          updateType: "callback_query",
          chatId: 10001,
          fromId: 10001,
          payload: { attemptId: "att-900001", text: "inq" },
        });

      const deliveryRef = generateDeliveryReference();
      const deliveryId = crypto.randomUUID();
      const res = await createOrResumeProductInquiry(appDb, {
        updateId: 900001,
        attemptId: "att-900001",
        customerId: customerAId,
        productId: prodId,
        productSnapshot: { name: "Sample Item", price: "10.00", currency: "USD" },
        notificationEvent: config
          ? {
              deliveryId,
              reference: deliveryRef,
              destinationChatId: config.destinationChatId,
              revision: config.revision,
            }
          : undefined,
      });

      expect(res.isResume).toBe(false);
      expect(res.inquiry.id).toBeDefined();

      // Verify durable delivery row exists with matching reference and inquiryId
      const deliveries = await db
        .select()
        .from(sellerNotificationDelivery)
        .where(eq(sellerNotificationDelivery.inquiryId, res.inquiry.id));

      expect(deliveries.length).toBe(1);
      expect(deliveries[0].status).toBe("pending");
      expect(deliveries[0].reference).toBe(deliveryRef);
      expect(deliveries[0].eventType).toBe("new_inquiry");
    });

    it("Test 10: New support inquiry from category button emits exactly one durable delivery row", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const config = await getVerifiedNotificationConfig(appDb);
      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900002,
          updateType: "callback_query",
          chatId: 10002,
          fromId: 10002,
          payload: { attemptId: "att-900002", text: "support" },
        });

      const deliveryRef = generateDeliveryReference();
      const deliveryId = crypto.randomUUID();
      const res = await createOrResumeSupportInquiry(appDb, {
        updateId: 900002,
        attemptId: "att-900002",
        customerId: customerBId,
        category: "General",
        notificationEvent: config
          ? {
              deliveryId,
              reference: deliveryRef,
              destinationChatId: config.destinationChatId,
              revision: config.revision,
            }
          : undefined,
      });

      expect(res.isResume).toBe(false);
      const deliveries = await db
        .select()
        .from(sellerNotificationDelivery)
        .where(eq(sellerNotificationDelivery.inquiryId, res.inquiry.id));

      expect(deliveries.length).toBe(1);
      expect(deliveries[0].status).toBe("pending");
      expect(deliveries[0].reference).toBe(deliveryRef);
    });

    it("Test 11: Free-text customer message opening support emits exactly one durable event, not two", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const custC = await upsertCustomer(appDb, {
        telegramId: 10003,
        firstName: "Buyer C",
      });

      const config = await getVerifiedNotificationConfig(appDb);
      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900003,
          updateType: "message",
          chatId: 10003,
          fromId: 10003,
          payload: { attemptId: "att-900003", text: "Hello, I need help with an order" },
        });

      const deliveryRef = generateDeliveryReference();
      const deliveryId = crypto.randomUUID();
      const res = await routeAndAppendCustomerText(appDb, {
        updateId: 900003,
        attemptId: "att-900003",
        customerId: custC.id,
        body: "Hello, I need help with an order",
        telegramMessageId: 501,
        notificationEvent: config
          ? {
              deliveryId,
              reference: deliveryRef,
              destinationChatId: config.destinationChatId,
              revision: config.revision,
            }
          : undefined,
      });

      expect(res.status).toBe("saved");
      if (res.status === "saved") {
        expect(res.isNewSupport).toBe(true);
        expect(res.inquiry.id).toBeDefined();

        const deliveries = await db
          .select()
          .from(sellerNotificationDelivery)
          .where(eq(sellerNotificationDelivery.inquiryId, res.inquiry.id));

        expect(deliveries.length).toBe(1);
        expect(deliveries[0].reference).toBe(deliveryRef);
      }
    });

    it("Test 12: Resuming an existing inquiry emits ZERO notification delivery records", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const config = await getVerifiedNotificationConfig(appDb);
      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900004,
          updateType: "callback_query",
          chatId: 10001,
          fromId: 10001,
          payload: { attemptId: "att-900004", text: "inq" },
        });

      const res = await createOrResumeProductInquiry(appDb, {
        updateId: 900004,
        attemptId: "att-900004",
        customerId: customerAId,
        productId: prodId,
        productSnapshot: { name: "Sample Item", price: "10.00", currency: "USD" },
        notificationEvent: config
          ? {
              deliveryId: crypto.randomUUID(),
              reference: generateDeliveryReference(),
              destinationChatId: config.destinationChatId,
              revision: config.revision,
            }
          : undefined,
      });

      expect(res.isResume).toBe(true);

      // Verify no new delivery row was added for this customer resume
      const totalDeliveries = await db.select().from(sellerNotificationDelivery);
      const matching = totalDeliveries.filter((d) => d.inquiryId === res.inquiry.id);
      expect(matching.length).toBe(1); // Only the initial created row from Test 9
    });

    it("Test 13: Duplicate update delivery / receipt replay emits zero notification events", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const countBefore = (await db.select().from(sellerNotificationDelivery)).length;

      const config = await getVerifiedNotificationConfig(appDb);
      const res = await createOrResumeProductInquiry(appDb, {
        updateId: 900001,
        attemptId: "att-900001",
        customerId: customerAId,
        productId: prodId,
        productSnapshot: { name: "Sample Item", price: "10.00", currency: "USD" },
        notificationEvent: config
          ? {
              deliveryId: crypto.randomUUID(),
              reference: generateDeliveryReference(),
              destinationChatId: config.destinationChatId,
              revision: config.revision,
            }
          : undefined,
      });

      expect(res.isResume).toBe(true);
      const countAfter = (await db.select().from(sellerNotificationDelivery)).length;
      expect(countAfter).toBe(countBefore);
    });

    it("Test 14: Stale / fenced attempt update emits zero notification events and zero inquiries", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900005,
          updateType: "callback_query",
          chatId: 10005,
          fromId: 10005,
          payload: { attemptId: "att-900005", text: "fenced" },
        });

      const countBefore = (await db.select().from(sellerNotificationDelivery)).length;

      // Passing wrong attemptId simulates stale attempt -> must throw/reject
      await expect(
        createOrResumeProductInquiry(appDb, {
          updateId: 900005,
          attemptId: "wrong-attempt-id",
          customerId: customerAId,
          productId: prodId,
          productSnapshot: { name: "Sample Item", price: "10.00", currency: "USD" },
          notificationIntent: {
            reference: generateDeliveryReference(),
            destinationChatId: "123456789",
            revision: 1,
          },
        })
      ).rejects.toThrow();

      const countAfter = (await db.select().from(sellerNotificationDelivery)).length;
      expect(countAfter).toBe(countBefore);
    });

    it("Test 15: Disabled or unverified integration creates zero notification delivery records", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      // Disable notifications temporarily
      await setSellerNotificationEnabled(appDb, false);
      const config = await getVerifiedNotificationConfig(appDb);
      expect(config).toBeNull();

      const custD = await upsertCustomer(appDb, {
        telegramId: 10006,
        firstName: "Buyer D",
      });

      await db
        .insert(telegramUpdate)
        .values({
          updateId: 900006,
          updateType: "callback_query",
          chatId: 10006,
          fromId: 10006,
          payload: { attemptId: "att-900006", text: "new" },
        });

      const countBefore = (await db.select().from(sellerNotificationDelivery)).length;

      const res = await createOrResumeProductInquiry(appDb, {
        updateId: 900006,
        attemptId: "att-900006",
        customerId: custD.id,
        productId: prodId,
        productSnapshot: { name: "Sample Item", price: "10.00", currency: "USD" },
        notificationIntent: undefined, // Disabled creates no intent!
      });

      expect(res.isResume).toBe(false);
      const countAfter = (await db.select().from(sellerNotificationDelivery)).length;
      expect(countAfter).toBe(countBefore);

      // Re-enable for subsequent tests
      await setSellerNotificationEnabled(appDb, true);
    });
  });

  // =========================================================================
  // Group C Tests (17–26): Delivery, Outbox & Recovery
  // =========================================================================

  describe("Group C: Delivery, Outbox Claims & Failure Modes", () => {
    let testDeliveryId: string;

    beforeAll(async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);
      const setting = await readSellerNotificationConfig(appDb);
      const inqId = await createTestInquiryRow(db, fixtureCustomerId);

      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: setting?.destinationChatId ?? "123456789",
          revision: setting?.revision ?? 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();
      testDeliveryId = del.id;
    });

    it("Test 17: Acknowledged send updates outbox record to sent and records message ID", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const fakeTransport = createFakeTelegramTransport();
      process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN = "test_seller_token";

      const result = await attemptSellerNotificationDelivery({
        db: appDb,
        deliveryId: testDeliveryId,
        transport: fakeTransport,
      });

      expect(result.status).toBe("sent");
      if (result.status === "sent") {
        expect(result.messageId).toBeDefined();
      }

      const fresh = await getSellerNotificationDelivery(appDb, testDeliveryId);
      expect(fresh?.status).toBe("sent");
      expect(fresh?.telegramMessageId).toBeDefined();
      expect(fresh?.sentAt).toBeDefined();
    });

    it("Test 21: Sent delivery cannot be retried", async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      const claim = await claimDeliveryAttempt(appDb, testDeliveryId);
      expect(claim).toBeNull();
    });

    it("Test 20: Concurrent retry attempts: two workers claiming same delivery; only one succeeds", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "123456789",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();

      // Run two claims in parallel
      const [claim1, claim2] = await Promise.all([
        claimDeliveryAttempt(appDb, del.id),
        claimDeliveryAttempt(appDb, del.id),
      ]);

      const successCount = [claim1, claim2].filter(Boolean).length;
      expect(successCount).toBe(1);
    });

    it("Test 18: Delivery failure marks record failed and preserves data", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "123456789",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();

      const claim = await claimDeliveryAttempt(appDb, del.id);
      expect(claim).not.toBeNull();

      const failed = await markDeliveryFailed(appDb, {
        deliveryId: del.id,
        claimAttemptId: claim!.claimAttemptId!,
        errorCategory: "api_error",
        errorSummary: "Telegram API 500 Internal Error",
      });

      expect(failed.status).toBe("failed");
      expect(failed.errorCategory).toBe("api_error");
    });

    it("Test 22 & 23: Timeout marks record unknown; retrying unknown requires explicit ack", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "123456789",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();

      const claim = await claimDeliveryAttempt(appDb, del.id);
      const unknownRec = await markDeliveryUnknown(appDb, {
        deliveryId: del.id,
        claimAttemptId: claim!.claimAttemptId!,
        errorCategory: "timeout",
        errorSummary: "Network timed out",
      });

      expect(unknownRec.status).toBe("unknown");

      // Claiming unknown without acknowledgeUnknownRisk MUST return null
      const retryWithoutAck = await claimDeliveryAttempt(appDb, del.id, {
        acknowledgeUnknownRisk: false,
      });
      expect(retryWithoutAck).toBeNull();

      // Claiming unknown WITH acknowledgeUnknownRisk succeeds
      const retryWithAck = await claimDeliveryAttempt(appDb, del.id, {
        acknowledgeUnknownRisk: true,
      });
      expect(retryWithAck).not.toBeNull();
      expect(retryWithAck?.status).toBe("sending");
    });

    it("Test 24: Telegram 429 sets retry_after and blocks retry until elapsed", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "123456789",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();

      const claim = await claimDeliveryAttempt(appDb, del.id);
      const retryAfterDate = new Date(Date.now() + 60000); // 60s in future

      await markDeliveryFailed(appDb, {
        deliveryId: del.id,
        claimAttemptId: claim!.claimAttemptId!,
        errorCategory: "rate_limited",
        errorSummary: "Too Many Requests",
        retryAfter: retryAfterDate,
      });

      // Immediate claim must be blocked by rate limit
      const blockedClaim = await claimDeliveryAttempt(appDb, del.id);
      expect(blockedClaim).toBeNull();
    });

    it("Test 25: Stale sending claim (older than 30s) allows recovery attempt by next worker", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      const staleTime = new Date(Date.now() - 45000); // 45s ago
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "123456789",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "sending",
          claimAttemptId: "stale-worker-guid",
          claimExpiresAt: staleTime,
          attemptCount: 1,
        })
        .returning();

      // A new worker claims the delivery
      const reclaimed = await claimDeliveryAttempt(appDb, del.id);
      expect(reclaimed).not.toBeNull();
      expect(reclaimed?.claimAttemptId).not.toBe("stale-worker-guid");
      expect(reclaimed?.attemptCount).toBe(2);
    });

    it("Test 26: Destination change between inquiry and retry cancels obsolete pending delivery", async () => {
      if (!testDb) return;
      const db = testDb.db;
      const appDb = asAppDb(db);

      const inqId = await createTestInquiryRow(db, fixtureCustomerId);
      // Create delivery with old revision 1
      const [del] = await db
        .insert(sellerNotificationDelivery)
        .values({
          inquiryId: inqId,
          destinationChatId: "old_destination",
          revision: 1,
          reference: generateDeliveryReference(),
          eventType: "new_inquiry",
          status: "pending",
        })
        .returning();

      // Suppose current config is at revision 2
      const fakeTransport = createFakeTelegramTransport();
      const result = await attemptSellerNotificationDelivery({
        db: appDb,
        deliveryId: del.id,
        transport: fakeTransport,
      });

      expect(result.status).toBe("cancelled");
      const fresh = await getSellerNotificationDelivery(appDb, del.id);
      expect(fresh?.status).toBe("cancelled");
      expect(fakeTransport.sentMessages.length).toBe(0);
    });
  });

  // =========================================================================
  // Group D Tests (29, 30)
  // =========================================================================

  describe("Group D: Database Migration Verification", () => {
    it("Test 29: Migration 0003 created all tables, triggers, and constraints", async () => {
      if (!testDb) return;
      const appDb = asAppDb(testDb.db);

      const cap = await checkSellerNotificationCapability(appDb);
      expect(cap.supported).toBe(true);

      const setting = await readSellerNotificationConfig(appDb);
      expect(setting).toBeDefined();
    });

    it("Test 30: Singleton constraint on seller_notification_setting is enforced", async () => {
      if (!testDb) return;
      const db = testDb.db;

      // Inserting a second row with id=2 must fail the check constraint
      await expect(
        db.insert(sellerNotificationSetting).values({
          id: 2,
          enabled: false,
          language: "en",
        })
      ).rejects.toThrow();
    });
  });
});
