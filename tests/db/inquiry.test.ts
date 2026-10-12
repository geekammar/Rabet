import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import {
  category,
  customer,
  inquiry,
  inquiryMessage,
  language,
  product,
  telegramUpdate,
} from "@/db/schema";
import {
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  uniqueLanguageCode,
  type TestDatabase,
} from "./helpers";

/**
 * The unified conversation model (DATA_MODEL.md §9): inquiries, their frozen
 * context, and the Telegram idempotency log.
 *
 * An inquiry is a tracked conversation — never a purchase. What makes it
 * trustworthy is that the context the customer saw is **write-once** at the
 * database level, so no later catalog edit can rewrite a conversation, and
 * that the dedup sites make double-taps and redelivered updates no-ops.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("inquiry");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

/** Inserts a customer and returns its id. */
async function insertCustomer(telegramId: number) {
  return (
    await testDb!.db
      .insert(customer)
      .values({ telegramId, telegramUsername: "buyer" })
      .returning({ id: customer.id })
  )[0].id;
}

/**
 * Inserts a category, product and an active language, and returns them.
 *
 * Every call builds a *fresh* catalog pair: the suite shares one database per
 * file, so a fixed `slug` would collide on `category_slug_unique` /
 * `product_slug_unique` and a fixed root `sort_order` on
 * `category_root_sort_order_idx` (which is unique across *all* roots, not just
 * one parent's children). One counter value keys the slugs and the root order.
 */
async function insertCatalogFixture() {
  const fixtureKey = nextOrder();
  const languageId = (
    await testDb!.db
      .insert(language)
      .values({
        code: uniqueLanguageCode(),
        label: "English",
        isEnabled: true,
      })
      .returning({ id: language.id })
  )[0].id;
  const categoryId = (
    await testDb!.db
      .insert(category)
      .values({
        slug: `inquiry-category-${fixtureKey}`,
        isActive: true,
        sortOrder: fixtureKey,
      })
      .returning({ id: category.id })
  )[0].id;
  const productId = (
    await testDb!.db
      .insert(product)
      .values({
        categoryId,
        slug: `inquiry-product-${fixtureKey}`,
        price: "250.00",
        isActive: true,
      })
      .returning({ id: product.id })
  )[0].id;

  return { languageId, categoryId, productId };
}

describe.skipIf(!shouldRun)("inquiry reference integrity", () => {
  it("requires a customer and keeps a product inquiry linked to its product", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1001);

    const inserted = await testDb!.db
      .insert(inquiry)
      .values({
        customerId,
        productId,
        reference: "INQ-AAAA",
        productSnapshot: {
          name: "Website Design",
          price: "250.00",
          currency: "SAR",
          categoryPath: ["Digital Products", "Design"],
        },
        selectedOptions: ["Choose Options", "Design", "Landing Page", "Basic"],
      })
      .returning();

    expect(inserted[0].productId).toBe(productId);
    expect(inserted[0].status).toBe("open");
    expect(inserted[0].selectedOptions).toEqual([
      "Choose Options",
      "Design",
      "Landing Page",
      "Basic",
    ]);
  });

  it("rejects an inquiry for an unknown customer", async () => {
    const { productId } = await insertCatalogFixture();

    await expect(
      testDb!.db.insert(inquiry).values({
        customerId: "00000000-0000-0000-0000-000000000000",
        productId,
        reference: "INQ-ORPHAN",
        productSnapshot: { name: "Gone" },
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("allows a general support inquiry with no product", async () => {
    const customerId = await insertCustomer(1002);

    const inserted = await testDb!.db
      .insert(inquiry)
      .values({
        customerId,
        productId: null,
        reference: "INQ-SUPPORT",
        category: "Order issue",
        productSnapshot: {},
      })
      .returning();

    expect(inserted[0].productId).toBeNull();
    expect(inserted[0].category).toBe("Order issue");
  });

  it("keeps the conversation readable when its product is deleted", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1003);

    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId,
          reference: "INQ-DELETE",
          productSnapshot: { name: "Website Design", price: "250.00" },
        })
        .returning({ id: inquiry.id })
    )[0].id;

    // Deleting the product sets the link to NULL instead of cascading, so the
    // frozen snapshot keeps the conversation intact and readable.
    await testDb!.db.delete(product).where(eq(product.id, productId));

    const reloaded = await testDb!.db.query.inquiry.findFirst({
      where: eq(inquiry.id, inquiryId),
    });

    expect(reloaded?.productId).toBeNull();
    expect(reloaded?.productSnapshot).toEqual({
      name: "Website Design",
      price: "250.00",
    });
  });

  it("blocks deleting a customer who still has inquiries", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1004);

    await testDb!.db.insert(inquiry).values({
      customerId,
      productId,
      reference: "INQ-KEEP",
      productSnapshot: { name: "Website Design" },
    });

    // Conversations outlive account state: the row is not deletable while the
    // history exists, which is what makes later anonymization the erasure path
    // instead of deletion. An `ON DELETE RESTRICT` block is reported by
    // PostgreSQL as `integrity_constraint_violation` (23001) — not
    // `foreign_key_violation` (23503), which is what an insert-side FK breach
    // and the ancestry triggers raise.
    await expect(
      testDb!.db.delete(customer).where(eq(customer.id, customerId)),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
  });
});

describe.skipIf(!shouldRun)("inquiry context immutability", () => {
  it("rejects changing the frozen product snapshot", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1005);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId,
          reference: "INQ-FROZEN",
          productSnapshot: { name: "Website Design", price: "250.00" },
        })
        .returning({ id: inquiry.id })
    )[0].id;

    // A later re-price must not rewrite what the customer was quoted.
    await expect(
      testDb!.db
        .update(inquiry)
        .set({ productSnapshot: { name: "Website Design", price: "999.00" } })
        .where(eq(inquiry.id, inquiryId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const reloaded = await testDb!.db.query.inquiry.findFirst({
      where: eq(inquiry.id, inquiryId),
    });

    expect(reloaded?.productSnapshot).toEqual({
      name: "Website Design",
      price: "250.00",
    });
  });

  it("rejects changing the frozen selected options", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1006);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId,
          reference: "INQ-PATH",
          productSnapshot: { name: "Website Design" },
          selectedOptions: ["Choose Options", "Basic"],
        })
        .returning({ id: inquiry.id })
    )[0].id;

    await expect(
      testDb!.db
        .update(inquiry)
        .set({ selectedOptions: ["Tampered"] })
        .where(eq(inquiry.id, inquiryId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // Nulling the path is also a change and is rejected too.
    await expect(
      testDb!.db
        .update(inquiry)
        .set({ selectedOptions: null })
        .where(eq(inquiry.id, inquiryId)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("still allows the mutable columns of an inquiry to change", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1007);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId,
          reference: "INQ-STATUS",
          productSnapshot: { name: "Website Design" },
        })
        .returning({ id: inquiry.id })
    )[0].id;

    // Status, timestamps and the reply clock keep working; only the frozen
    // context is locked. `updated_at` is refreshed by the trigger.
    const updated = await testDb!.db
      .update(inquiry)
      .set({ status: "waiting_on_customer", lastReplyAt: new Date() })
      .where(eq(inquiry.id, inquiryId))
      .returning();

    expect(updated[0].status).toBe("waiting_on_customer");
    expect(updated[0].lastReplyAt).not.toBeNull();
    expect(updated[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
      updated[0].createdAt.getTime(),
    );
  });
});

describe.skipIf(!shouldRun)("inquiry uniqueness and messages", () => {
  it("permits at most one active inquiry per customer per product", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1008);

    await testDb!.db.insert(inquiry).values({
      customerId,
      productId,
      reference: "INQ-FIRST",
      productSnapshot: { name: "Website Design" },
    });

    // A repeat START_INQUIRY tap conflicts on the partial unique index, which
    // is what makes the action resume-by-construction instead of a
    // lookup-then-insert race.
    await expect(
      testDb!.db.insert(inquiry).values({
        customerId,
        productId,
        reference: "INQ-SECOND",
        productSnapshot: { name: "Website Design" },
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // A closed inquiry does not block a new one — closed is terminal for the
    // customer, so a later contact starts a fresh thread.
    await testDb!.db.execute(
      sql`update inquiry set status = 'closed', closed_at = now()
          where reference = 'INQ-FIRST'`,
    );

    await expect(
      testDb!.db.insert(inquiry).values({
        customerId,
        productId,
        reference: "INQ-AFTER-CLOSE",
        productSnapshot: { name: "Website Design" },
      }),
    ).resolves.toBeDefined();
  });

  it("stores a two-way conversation and dedups a redelivered message", async () => {
    const { productId } = await insertCatalogFixture();
    const customerId = await insertCustomer(1009);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId,
          reference: "INQ-THREAD",
          productSnapshot: { name: "Website Design" },
        })
        .returning({ id: inquiry.id })
    )[0].id;

    const customerMessage = (
      await testDb!.db
        .insert(inquiryMessage)
        .values({
          inquiryId,
          author: "customer",
          body: "What does the basic package include?",
          telegramMessageId: 5001,
        })
        .returning({ id: inquiryMessage.id })
    )[0].id;

    await testDb!.db.insert(inquiryMessage).values({
      inquiryId,
      author: "admin",
      body: "It includes a single landing page.",
      deliveryStatus: "pending",
    });

    // The same Telegram message id in the same thread cannot be stored twice:
    // a redelivered update is a no-op.
    await expect(
      testDb!.db.insert(inquiryMessage).values({
        inquiryId,
        author: "customer",
        body: "What does the basic package include?",
        telegramMessageId: 5001,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const thread = await testDb!.db.query.inquiryMessage.findMany({
      where: eq(inquiryMessage.inquiryId, inquiryId),
      orderBy: (message, { asc }) => [asc(message.createdAt)],
    });

    expect(thread.map((message) => message.author)).toEqual(["customer", "admin"]);
    expect(thread[0].id).toBe(customerMessage);
  });

  it("rejects a message body over the Telegram text limit", async () => {
    const customerId = await insertCustomer(1010);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId: null,
          reference: "INQ-LONG",
          productSnapshot: {},
        })
        .returning({ id: inquiry.id })
    )[0].id;

    await expect(
      testDb!.db.insert(inquiryMessage).values({
        inquiryId,
        author: "customer",
        body: "x".repeat(4097),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("deletes a thread's messages when the thread is deleted", async () => {
    const customerId = await insertCustomer(1011);
    const inquiryId = (
      await testDb!.db
        .insert(inquiry)
        .values({
          customerId,
          productId: null,
          reference: "INQ-CASCADE",
          productSnapshot: {},
        })
        .returning({ id: inquiry.id })
    )[0].id;

    await testDb!.db.insert(inquiryMessage).values({
      inquiryId,
      author: "customer",
      body: "Hello",
      telegramMessageId: 6001,
    });

    await testDb!.db.delete(inquiry).where(eq(inquiry.id, inquiryId));

    const remaining = await testDb!.db.query.inquiryMessage.findMany({
      where: eq(inquiryMessage.inquiryId, inquiryId),
    });

    expect(remaining).toHaveLength(0);
  });
});

describe.skipIf(!shouldRun)("telegram update idempotency", () => {
  it("stores an update once and rejects a duplicate update id", async () => {
    await testDb!.db.insert(telegramUpdate).values({
      updateId: 4123456789,
      updateType: "callback_query",
      payload: { data: "b:00000000-0000-0000-0000-000000000000" },
    });

    // The dedup lock: the insert is what makes a redelivered update a no-op.
    await expect(
      testDb!.db.insert(telegramUpdate).values({
        updateId: 4123456789,
        updateType: "callback_query",
        payload: {},
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const rows = await testDb!.db.select().from(telegramUpdate);

    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).toBeNull();
  });

  it("records processing completion and failure separately", async () => {
    const ok = (
      await testDb!.db
        .insert(telegramUpdate)
        .values({ updateId: 4123456790, updateType: "message" })
        .returning({ id: telegramUpdate.id })
    )[0].id;

    await testDb!.db
      .update(telegramUpdate)
      .set({ processedAt: new Date() })
      .where(eq(telegramUpdate.id, ok));

    const failed = (
      await testDb!.db
        .insert(telegramUpdate)
        .values({ updateId: 4123456791, updateType: "message" })
        .returning({ id: telegramUpdate.id })
    )[0].id;

    await testDb!.db
      .update(telegramUpdate)
      .set({ processingError: "bot blocked by user (403)" })
      .where(eq(telegramUpdate.id, failed));

    const rows = await testDb!.db
      .select()
      .from(telegramUpdate)
      .where(inArray(telegramUpdate.updateId, [4123456790, 4123456791]))
      .orderBy(telegramUpdate.updateId);

    expect(rows[0].processedAt).not.toBeNull();
    expect(rows[0].processingError).toBeNull();
    expect(rows[1].processingError).toBe("bot blocked by user (403)");
    expect(rows[1].processedAt).toBeNull();
  });
});
