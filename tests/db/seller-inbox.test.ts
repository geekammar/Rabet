import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import {
  botSetting,
  category,
  categoryTranslation,
  customer,
  inquiry,
  inquiryMessage,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import {
  deriveRetryOperationId,
  getSellerInquiryThread,
  isInquirySupport,
  listInquiryMessagesPaged,
  listSellerInquiries,
  retrySellerReply,
  sendSellerReply,
  transitionInquiryStatus,
} from "@/lib/data/seller-inbox";
import {
  upsertCustomer,
} from "@/lib/data/customer";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("seller_inbox");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

async function seedBaseStore(db: import("@/db/client").Database) {
  // 1. Language
  const [lang] = await db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .onConflictDoNothing()
    .returning();

  const langId =
    lang?.id ??
    (
      await db
        .select()
        .from(language)
        .where(eq(language.code, "en"))
        .limit(1)
    )[0].id;

  // 2. Bot Settings
  await db
    .insert(botSetting)
    .values({
      id: 1,
      displayName: "Rabet Store",
      currency: "SAR",
      defaultLanguageId: langId,
      supportCategory: ["Billing", "Technical"],
    })
    .onConflictDoNothing();

  // 3. Category
  const [cat] = await db
    .insert(category)
    .values({
      slug: "tech",
      sortOrder: 1,
      isActive: true,
    })
    .onConflictDoNothing()
    .returning();

  const catId =
    cat?.id ??
    (
      await db
        .select()
        .from(category)
        .where(eq(category.slug, "tech"))
        .limit(1)
    )[0].id;

  await db
    .insert(categoryTranslation)
    .values({
      categoryId: catId,
      languageId: langId,
      name: "Technology",
    })
    .onConflictDoNothing();

  // 4. Product
  const [prod] = await db
    .insert(product)
    .values({
      categoryId: catId,
      slug: "hosting",
      price: "199.00",
      sortOrder: 1,
      isActive: true,
    })
    .onConflictDoNothing()
    .returning();

  const prodId =
    prod?.id ??
    (
      await db
        .select()
        .from(product)
        .where(eq(product.slug, "hosting"))
        .limit(1)
    )[0].id;

  await db
    .insert(productTranslation)
    .values({
      productId: prodId,
      languageId: langId,
      name: "Cloud Hosting",
    })
    .onConflictDoNothing();

  return { langId, catId, prodId };
}

describe.skipIf(!shouldRun)("Phase 09: Seller Inbox, Reliable Replies & Lifecycle", () => {
  it("A: First reply reserves and sends once, updating waiting_on_customer and delivery metadata honestly", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, {
      telegramId: 10001,
      firstName: "Alice",
      telegramUsername: "alice_buyer",
    });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST01",
        status: "open",
        productSnapshot: {
          name: "Cloud Hosting",
          price: "199.00",
          currency: "SAR",
          categoryPath: ["Technology"],
        },
        selectedOptions: ["Cloud Hosting", "Ask Seller"],
      })
      .returning();

    // Customer message
    await db.insert(inquiryMessage).values({
      inquiryId: inq.id,
      author: "customer",
      body: "Is setup automated?",
      deliveryStatus: "sent",
    });

    const fakeTransport = createFakeTelegramTransport();

    // Seller sends reply
    const sendRes = await sendSellerReply(db, fakeTransport, {
      inquiryId: inq.id,
      body: "Yes, setup takes under 60 seconds.",
    });

    expect(sendRes.success).toBe(true);
    expect(sendRes.message.deliveryStatus).toBe("sent");
    expect(sendRes.message.author).toBe("admin");
    expect(sendRes.message.deliveredAt).not.toBeNull();
    expect(sendRes.message.telegramMessageId).toBeGreaterThan(0);

    // Verify Telegram call
    expect(fakeTransport.sentMessages).toHaveLength(1);
    expect(fakeTransport.sentMessages[0].chatId).toBe(10001);
    expect(fakeTransport.sentMessages[0].text).toBe(
      "[INQ-TEST01]\n\nYes, setup takes under 60 seconds.",
    );

    // Verify database inquiry status advanced to waiting_on_customer
    const updatedThread = await getSellerInquiryThread(db, inq.id);
    expect(updatedThread.inquiry.status).toBe("waiting_on_customer");
    expect(updatedThread.inquiry.lastReplyAt).not.toBeNull();
  });

  it("B: Duplicate submissions return existing operation outcome without re-sending", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, {
      telegramId: 10002,
      firstName: "Bob",
    });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST02",
        status: "open",
        productSnapshot: { name: "Cloud Hosting", price: "199.00" },
      })
      .returning();

    const fakeTransport = createFakeTelegramTransport();
    const opId = crypto.randomUUID();

    // First attempt
    const res1 = await sendSellerReply(db, fakeTransport, {
      inquiryId: inq.id,
      body: "Hello Bob",
      operationId: opId,
    });

    expect(res1.success).toBe(true);
    expect(fakeTransport.sentMessages).toHaveLength(1);

    // Second duplicate attempt with exact same operationId
    const res2 = await sendSellerReply(db, fakeTransport, {
      inquiryId: inq.id,
      body: "Hello Bob",
      operationId: opId,
    });

    expect(res2.success).toBe(true);
    expect(res2.alreadyReserved).toBe(true);
    expect(res2.message.id).toBe(opId);
    // Transport was NOT called a second time
    expect(fakeTransport.sentMessages).toHaveLength(1);

    // Total messages in DB remains exactly 1
    const msgs = await db
      .select()
      .from(inquiryMessage)
      .where(eq(inquiryMessage.inquiryId, inq.id));
    expect(msgs).toHaveLength(1);
  });

  it("C: Reusing operation ID with different body or inquiry is rejected", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10003, firstName: "Charlie" });

    const [inq1] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST03A",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    const [inq2] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: null,
        category: "Billing",
        reference: "INQ-TEST03B",
        status: "open",
        productSnapshot: { type: "support" },
      })
      .returning();

    const fakeTransport = createFakeTelegramTransport();
    const opId = crypto.randomUUID();

    await sendSellerReply(db, fakeTransport, {
      inquiryId: inq1.id,
      body: "First body",
      operationId: opId,
    });

    // Reusing same opId with different body on same inquiry
    await expect(
      sendSellerReply(db, fakeTransport, {
        inquiryId: inq1.id,
        body: "Tampered body",
        operationId: opId,
      }),
    ).rejects.toThrow("Cannot reuse operation ID with different inquiry or body content.");

    // Reusing same opId on different inquiry
    await expect(
      sendSellerReply(db, fakeTransport, {
        inquiryId: inq2.id,
        body: "First body",
        operationId: opId,
      }),
    ).rejects.toThrow("Cannot reuse operation ID with different inquiry or body content.");
  });

  it("D: Concurrent submissions on independent connections produce exactly one row and one transport call", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10004, firstName: "Dana" });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST04",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    // Independent postgres-js connection
    const rawSql = postgres(testDb!.url, { max: 1 });
    const independentDb = asAppDb(drizzle(rawSql));

    const opId = crypto.randomUUID();
    const fakeTransport = createFakeTelegramTransport();

    try {
      const results = await Promise.all([
        sendSellerReply(db, fakeTransport, {
          inquiryId: inq.id,
          body: "Concurrent test message",
          operationId: opId,
        }),
        sendSellerReply(independentDb, fakeTransport, {
          inquiryId: inq.id,
          body: "Concurrent test message",
          operationId: opId,
        }),
      ]);

      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      // Exactly one was the sender, the other was alreadyReserved
      const sends = results.filter((r) => !r.alreadyReserved);
      const cached = results.filter((r) => r.alreadyReserved);
      expect(sends).toHaveLength(1);
      expect(cached).toHaveLength(1);

      // Only one transport call
      expect(fakeTransport.sentMessages).toHaveLength(1);

      // Exactly one message row in DB
      const rows = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.inquiryId, inq.id));
      expect(rows).toHaveLength(1);
    } finally {
      await rawSql.end();
    }
  });

  it("E: Delivery failure (timeout, 429 rate limit, 403 blocked) is recorded honestly with safe diagnostics", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10005, firstName: "Evan" });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST05",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    // 1. Timeout failure
    const fakeTransport1 = createFakeTelegramTransport();
    fakeTransport1.failSendWith = "Request timed out";
    fakeTransport1.failSendKind = "timeout";

    const timeoutRes = await sendSellerReply(db, fakeTransport1, {
      inquiryId: inq.id,
      body: "Timeout attempt",
    });

    expect(timeoutRes.success).toBe(false);
    expect(timeoutRes.message.deliveryStatus).toBe("failed");
    expect(timeoutRes.message.deliveryError).toBe("category=timeout");

    // 2. 429 Rate limit failure
    const fakeTransport2 = createFakeTelegramTransport();
    fakeTransport2.failSendWith = "Too Many Requests";
    fakeTransport2.failSendKind = "rate_limited";
    fakeTransport2.failSendHttpStatus = 429;
    fakeTransport2.failSendRetryAfter = 8;

    const rateLimitRes = await sendSellerReply(db, fakeTransport2, {
      inquiryId: inq.id,
      body: "Rate limited attempt",
    });

    expect(rateLimitRes.success).toBe(false);
    expect(rateLimitRes.message.deliveryStatus).toBe("failed");
    expect(rateLimitRes.message.deliveryError).toBe(
      "category=rate_limited;status=429;retry_after=8",
    );

    // 3. 403 Blocked user failure
    const fakeTransport3 = createFakeTelegramTransport();
    fakeTransport3.failSendWith = "Forbidden: bot was blocked by the user";
    fakeTransport3.failSendKind = "blocked";
    fakeTransport3.failSendHttpStatus = 403;
    fakeTransport3.failSendIsBlocked = true;

    const blockedRes = await sendSellerReply(db, fakeTransport3, {
      inquiryId: inq.id,
      body: "Blocked user attempt",
    });

    expect(blockedRes.success).toBe(false);
    expect(blockedRes.message.deliveryStatus).toBe("failed");
    expect(blockedRes.message.deliveryError).toBe("category=blocked;status=403");

    // Verify customer.isBlocked was updated to true
    const updatedCust = await db
      .select()
      .from(customer)
      .where(eq(customer.id, cust.id))
      .limit(1);
    expect(updatedCust[0].isBlocked).toBe(true);

    // Further attempts to reply to blocked customer reject immediately before transport
    await expect(
      sendSellerReply(db, fakeTransport3, {
        inquiryId: inq.id,
        body: "Attempt while blocked",
      }),
    ).rejects.toThrow("Customer has blocked the bot.");

    // 4. Stale blocked flag recovery when customer re-engages
    await upsertCustomer(db, {
      telegramId: 10005,
      firstName: "Evan (Unblocked)",
    });

    const recoveredCust = await db
      .select()
      .from(customer)
      .where(eq(customer.id, cust.id))
      .limit(1);
    expect(recoveredCust[0].isBlocked).toBe(false);
  });

  it("F: Explicit retry derives stable UUID, and concurrent retries send once", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10006, firstName: "Fiona" });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST06",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    // Initial failed send
    const failingTransport = createFakeTelegramTransport();
    failingTransport.failSendWith = "API Network Error";
    failingTransport.failSendKind = "network_error";

    const initialRes = await sendSellerReply(db, failingTransport, {
      inquiryId: inq.id,
      body: "Original text to Fiona",
    });

    expect(initialRes.success).toBe(false);
    const failedMsgId = initialRes.message.id;

    // Independent connection for concurrency test
    const rawSql = postgres(testDb!.url, { max: 1 });
    const independentDb = asAppDb(drizzle(rawSql));

    const workingTransport = createFakeTelegramTransport();

    try {
      // Two concurrent retries targeting the same failed message
      const [retry1, retry2] = await Promise.all([
        retrySellerReply(db, workingTransport, {
          inquiryId: inq.id,
          sourceMessageId: failedMsgId,
        }),
        retrySellerReply(independentDb, workingTransport, {
          inquiryId: inq.id,
          sourceMessageId: failedMsgId,
        }),
      ]);

      expect(retry1.success).toBe(true);
      expect(retry2.success).toBe(true);

      // Verify stable retry operation UUID
      const expectedRetryOpId = deriveRetryOperationId(failedMsgId);
      expect(retry1.message.id).toBe(expectedRetryOpId);
      expect(retry2.message.id).toBe(expectedRetryOpId);

      // Exactly one transport call
      expect(workingTransport.sentMessages).toHaveLength(1);
      expect(workingTransport.sentMessages[0].text).toBe(
        "[INQ-TEST06]\n\nOriginal text to Fiona",
      );

      // The original failed message remains failed
      const [origMsg] = await db
        .select()
        .from(inquiryMessage)
        .where(eq(inquiryMessage.id, failedMsgId));
      expect(origMsg.deliveryStatus).toBe("failed");
    } finally {
      await rawSql.end();
    }
  });

  it("G: Race: Customer replies while seller send is in flight — leaves inquiry status open", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10007, firstName: "George" });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST07",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    // Custom transport that pauses to let customer reply concurrently
    let customerReplied = false;
    const slowTransport = createFakeTelegramTransport();
    const originalSendMessage = slowTransport.sendMessage.bind(slowTransport);

    slowTransport.sendMessage = async (params) => {
      // Simulate customer reply during external send
      await db
        .update(inquiry)
        .set({ status: "open", updatedAt: new Date() })
        .where(eq(inquiry.id, inq.id));
      await db.insert(inquiryMessage).values({
        inquiryId: inq.id,
        author: "customer",
        body: "Wait, I have another question!",
        deliveryStatus: "sent",
      });
      customerReplied = true;
      return originalSendMessage(params);
    };

    const replyRes = await sendSellerReply(db, slowTransport, {
      inquiryId: inq.id,
      body: "Seller response",
    });

    expect(replyRes.success).toBe(true);
    expect(customerReplied).toBe(true);

    // Verify delivery completion did NOT revert inquiry back to waiting_on_customer!
    const [finalInq] = await db
      .select()
      .from(inquiry)
      .where(eq(inquiry.id, inq.id));
    expect(finalInq.status).toBe("open");
  });

  it("H: Concurrency: Close before reservation prevents sending; Close after reservation preserves closed state", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10008, firstName: "Hannah" });

    // Thread 1: Close before reservation
    const [inq1] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST08A",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    await transitionInquiryStatus(db, {
      inquiryId: inq1.id,
      targetStatus: "closed",
    });

    const fakeTransport = createFakeTelegramTransport();
    await expect(
      sendSellerReply(db, fakeTransport, {
        inquiryId: inq1.id,
        body: "Message into closed thread",
      }),
    ).rejects.toThrow("Cannot reply to a closed inquiry.");
    expect(fakeTransport.sentMessages).toHaveLength(0);

    // Thread 2: Close after reservation while send in flight
    const [inq2] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST08B",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    const slowTransport = createFakeTelegramTransport();
    const origSend = slowTransport.sendMessage.bind(slowTransport);
    slowTransport.sendMessage = async (params) => {
      // Concurrently close thread after reservation committed
      await transitionInquiryStatus(db, {
        inquiryId: inq2.id,
        targetStatus: "closed",
      });
      return origSend(params);
    };

    const sendRes2 = await sendSellerReply(db, slowTransport, {
      inquiryId: inq2.id,
      body: "Seller message reserved before close",
    });

    expect(sendRes2.success).toBe(true);

    // Completion must preserve the later closed state
    const [finalInq2] = await db
      .select()
      .from(inquiry)
      .where(eq(inquiry.id, inq2.id));
    expect(finalInq2.status).toBe("closed");
    expect(finalInq2.closedAt).not.toBeNull();
  });

  it("I: Lifecycle transitions: resolve, close, reopen, and conflict rejection", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10009, firstName: "Ian" });

    // 1. Valid transitions: open -> resolved -> closed -> open
    const [inq1] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST09A",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    const resolved = await transitionInquiryStatus(db, {
      inquiryId: inq1.id,
      targetStatus: "resolved",
    });
    expect(resolved.status).toBe("resolved");

    const closed = await transitionInquiryStatus(db, {
      inquiryId: inq1.id,
      targetStatus: "closed",
    });
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();

    const reopened = await transitionInquiryStatus(db, {
      inquiryId: inq1.id,
      targetStatus: "open",
    });
    expect(reopened.status).toBe("open");
    expect(reopened.closedAt).toBeNull();

    // 2. Reject undocumented transition (e.g. resolved -> open)
    await transitionInquiryStatus(db, { inquiryId: inq1.id, targetStatus: "resolved" });
    await expect(
      transitionInquiryStatus(db, { inquiryId: inq1.id, targetStatus: "open" }),
    ).rejects.toThrow('Invalid status transition from "resolved" to "open".');

    // Close inq1
    await transitionInquiryStatus(db, { inquiryId: inq1.id, targetStatus: "closed" });

    // 3. Reopen conflict check: create inq2 for same customer & product (open)
    await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-TEST09B",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    // Attempting to reopen inq1 while inq2 is active for the same product must be rejected!
    await expect(
      transitionInquiryStatus(db, {
        inquiryId: inq1.id,
        targetStatus: "open",
      }),
    ).rejects.toThrow("Cannot reopen: Another active conversation already exists (INQ-TEST09B).");
  });

  it("J: Support conversation classification and reopen conflict by category", async () => {
    const db = asAppDb(testDb!.db);
    await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10010, firstName: "Julia" });

    // General support inquiry 1 (Technical)
    const [inq1] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: null,
        category: "Technical",
        reference: "INQ-TEST10A",
        status: "closed",
        productSnapshot: { type: "support" },
      })
      .returning();

    // General support inquiry 2 (Technical, active)
    const [inq2] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: null,
        category: "Technical",
        reference: "INQ-TEST10B",
        status: "open",
        productSnapshot: { type: "support" },
      })
      .returning();

    expect(isInquirySupport(inq1.productSnapshot)).toBe(true);

    // Reopen inq1 while inq2 is active with same category is rejected
    await expect(
      transitionInquiryStatus(db, {
        inquiryId: inq1.id,
        targetStatus: "open",
      }),
    ).rejects.toThrow("Cannot reopen: Another active conversation already exists (INQ-TEST10B).");

    // Close inq2
    await transitionInquiryStatus(db, { inquiryId: inq2.id, targetStatus: "closed" });

    // Now inq1 can be reopened successfully
    const reopened = await transitionInquiryStatus(db, {
      inquiryId: inq1.id,
      targetStatus: "open",
    });
    expect(reopened.status).toBe("open");
  });

  it("K: Frozen context survives live product catalog changes and deletion", async () => {
    const db = asAppDb(testDb!.db);
    const { catId } = await seedBaseStore(db);

    // Create a product that will be modified and deleted
    const [tempProd] = await db
      .insert(product)
      .values({
        categoryId: catId,
        slug: "temp-gadget",
        price: "49.00",
        isActive: true,
      })
      .returning();

    const cust = await upsertCustomer(db, { telegramId: 10011, firstName: "Kevin" });

    const [inq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: tempProd.id,
        reference: "INQ-TEST11",
        status: "open",
        productSnapshot: {
          name: "Temporary Gadget",
          price: "49.00",
          currency: "SAR",
          categoryPath: ["Technology"],
        },
        selectedOptions: ["Temporary Gadget", "Option A"],
      })
      .returning();

    // 1. Modify the live product price & slug
    await db
      .update(product)
      .set({ price: "999.00", slug: "temp-gadget-modified", isActive: false })
      .where(eq(product.id, tempProd.id));

    // 2. Delete the product (inquiry.product_id has ON DELETE SET NULL)
    await db.delete(product).where(eq(product.id, tempProd.id));

    // Inquiry thread still reads complete frozen context
    const thread = await getSellerInquiryThread(db, inq.id);
    expect(thread.inquiry.productId).toBeNull(); // ON DELETE SET NULL
    expect(thread.isSupport).toBe(false); // correctly identified as product inquiry from snapshot!
    expect((thread.inquiry.productSnapshot as { price: string }).price).toBe("49.00");
    expect((thread.inquiry.productSnapshot as { name: string }).name).toBe("Temporary Gadget");
    expect(thread.inquiry.selectedOptions).toEqual(["Temporary Gadget", "Option A"]);
  });

  it("L: Inbox read queries: status filter, type filter, reference lookup, pagination, and zero business writes", async () => {
    const db = asAppDb(testDb!.db);
    const { prodId } = await seedBaseStore(db);

    const cust = await upsertCustomer(db, { telegramId: 10012, firstName: "Laura" });

    // Seed 3 inquiries with different statuses and types
    const [pInq] = await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: prodId,
        reference: "INQ-FILTER-PROD",
        status: "open",
        productSnapshot: { name: "Cloud Hosting" },
      })
      .returning();

    await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: null,
        category: "Billing",
        reference: "INQ-FILTER-SUPP",
        status: "waiting_on_customer",
        productSnapshot: { type: "support" },
      })
      .returning();

    await db
      .insert(inquiry)
      .values({
        customerId: cust.id,
        productId: null,
        category: "General",
        reference: "INQ-FILTER-CLOSED",
        status: "closed",
        productSnapshot: { type: "support" },
      })
      .returning();

    // Add a message to pInq
    await db.insert(inquiryMessage).values({
      inquiryId: pInq.id,
      author: "customer",
      body: "Need help with cloud hosting",
      deliveryStatus: "sent",
    });

    // 1. Default active filter (open + waiting_on_customer)
    const activeList = await listSellerInquiries(db, { status: "active" });
    const activeRefs = activeList.items.map((i) => i.reference);
    expect(activeRefs).toContain("INQ-FILTER-PROD");
    expect(activeRefs).toContain("INQ-FILTER-SUPP");
    expect(activeRefs).not.toContain("INQ-FILTER-CLOSED");

    // Message preview is populated
    const foundProd = activeList.items.find((i) => i.reference === "INQ-FILTER-PROD");
    expect(foundProd?.lastMessage?.body).toBe("Need help with cloud hosting");

    // 2. Filter by type = "support"
    const supportList = await listSellerInquiries(db, { type: "support", status: "all" });
    const supportRefs = supportList.items.map((i) => i.reference);
    expect(supportRefs).toContain("INQ-FILTER-SUPP");
    expect(supportRefs).toContain("INQ-FILTER-CLOSED");
    expect(supportRefs).not.toContain("INQ-FILTER-PROD");

    // 3. Exact reference search
    const exactMatch = await listSellerInquiries(db, { reference: "inq-filter-prod" });
    expect(exactMatch.items).toHaveLength(1);
    expect(exactMatch.items[0].reference).toBe("INQ-FILTER-PROD");

    // 4. Messages pagination
    const pagedMsgs = await listInquiryMessagesPaged(db, pInq.id, { page: 1, pageSize: 10 });
    expect(pagedMsgs.totalCount).toBe(1);
    expect(pagedMsgs.items[0].body).toBe("Need help with cloud hosting");
  });
});
