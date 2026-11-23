import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import {
  appUser,
  cart,
  category,
  categoryTranslation,
  inventoryReservation,
  language,
  order,
  orderItem,
  product,
  productInventory,
  productTranslation,
  store,
  storeCommerceSetting,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  addToCart,
  confirmCodOrder,
  isCodAvailable,
  listMerchantOrders,
  readCartForBuyer,
  refreshReview,
  saveAddressAndPrepareReview,
  savePhone,
  startCheckout,
} from "@/lib/commerce/orders";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  pgErrorCode,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

type Fixture = {
  storeAId: string;
  storeBId: string;
  userAId: string;
  userBId: string;
  categoryAId: string;
  categoryBId: string;
  productA1Id: string;
  productA2Id: string;
  productB1Id: string;
  connectionAId: string;
  connectionBId: string;
  languageId: string;
};

let fixture: Fixture;

const BUYER_A = 91001;
const BUYER_B = 91002;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.RABET_COD_ORDERS_ENABLED = "true";
  testDb = await createTestDatabase("cod_orders");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({ name: "COD Store A", slug: "cod-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "COD Store B", slug: "cod-store-b", status: "active" })
    .returning();

  const [userA] = await db
    .insert(appUser)
    .values({ email: "cod.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "cod.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "cod-store-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "cod-store-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "A Root" },
    { categoryId: categoryB.id, languageId: english.id, name: "B Root" },
  ]);

  const [productA1] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "cod-a-one",
      price: "11.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();
  const [productA2] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "cod-a-two",
      price: "20.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();
  const [productB1] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "cod-b-one",
      price: "30.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: productA1.id,
      languageId: english.id,
      name: "A One",
      description: "First A product",
    },
    {
      productId: productA2.id,
      languageId: english.id,
      name: "A Two",
      description: "Second A product",
    },
    {
      productId: productB1.id,
      languageId: english.id,
      name: "B One",
      description: "First B product",
    },
  ]);

  await db.insert(storeCommerceSetting).values([
    {
      storeId: storeA.id,
      currency: "SAR",
      deliveryFee: "15.00",
      codEnabled: true,
    },
    {
      storeId: storeB.id,
      currency: "USD",
      deliveryFee: "7.00",
      codEnabled: true,
    },
  ]);

  await db.insert(productInventory).values([
    { productId: productA1.id, storeId: storeA.id, onHand: 5, reserved: 0 },
    { productId: productA2.id, storeId: storeA.id, onHand: 10, reserved: 0 },
    { productId: productB1.id, storeId: storeB.id, onHand: 5, reserved: 0 },
  ]);

  const [connectionA] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeA.id,
      botId: 880001,
      botUsername: "CodStoreABot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "a".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 880002,
      botUsername: "CodStoreBBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "b".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    userAId: userA.id,
    userBId: userB.id,
    categoryAId: categoryA.id,
    categoryBId: categoryB.id,
    productA1Id: productA1.id,
    productA2Id: productA2.id,
    productB1Id: productB1.id,
    connectionAId: connectionA.id,
    connectionBId: connectionB.id,
    languageId: english.id,
  };
});

afterAll(async () => {
  delete process.env.RABET_COD_ORDERS_ENABLED;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  const db = testDb.db;

  await db.execute(sql`
    truncate table
      "inventory_reservation",
      "order_item",
      "order",
      "cart_item",
      "cart"
    restart identity cascade
  `);

  await db
    .update(product)
    .set({ price: "11.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productA1Id));
  await db
    .update(product)
    .set({ price: "20.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productA2Id));
  await db
    .update(product)
    .set({ price: "30.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productB1Id));

  await db
    .update(productTranslation)
    .set({ name: "A One", description: "First A product" })
    .where(
      and(
        eq(productTranslation.productId, fixture.productA1Id),
        eq(productTranslation.languageId, fixture.languageId),
      ),
    );

  await db.execute(sql`
    update "product_inventory"
    set on_hand = case
      when product_id = ${fixture.productA1Id} then 5
      when product_id = ${fixture.productA2Id} then 10
      else 5
    end,
    reserved = 0
  `);

  await db
    .update(storeCommerceSetting)
    .set({ deliveryFee: "15.00", codEnabled: true })
    .where(eq(storeCommerceSetting.storeId, fixture.storeAId));
  await db
    .update(storeCommerceSetting)
    .set({ deliveryFee: "7.00", codEnabled: true })
    .where(eq(storeCommerceSetting.storeId, fixture.storeBId));
});

function db() {
  return testDb!.db;
}

function tx(): TransactionDatabase {
  return testDb!.db as unknown as TransactionDatabase;
}

async function scope(storeId: string) {
  return readStoreScopeForFixture(db(), storeId);
}

async function prepareReviewedOrder(input: {
  storeId: string;
  connectionId: string;
  buyerId: number;
  productId: string;
  quantity?: number;
  profileName?: string;
  phone?: string;
  address?: string;
}) {
  const storeScope = await scope(input.storeId);
  const added = await addToCart(tx(), storeScope, {
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    telegramChatId: input.buyerId,
    productId: input.productId,
    quantity: input.quantity ?? 1,
  });
  expect(added.status).toBe("added");
  if (added.status !== "added") throw new Error("add failed");

  const started = await startCheckout(tx(), storeScope, {
    cartId: added.cart.id,
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    profileName: input.profileName ?? "Buyer One",
  });
  expect(started.status).toBe("ready");
  if (started.status !== "ready") throw new Error("checkout failed");

  const phone = await savePhone(tx(), storeScope, {
    cartId: added.cart.id,
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    phone: input.phone ?? "+15551234567",
  });
  expect(phone.status).toBe("saved");

  const reviewed = await saveAddressAndPrepareReview(tx(), storeScope, {
    cartId: added.cart.id,
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    address: input.address ?? "123 Synthetic Test Street",
  });
  expect(reviewed.status).toBe("review");
  if (reviewed.status !== "review") throw new Error("review failed");

  return {
    scope: storeScope,
    cartId: added.cart.id,
    review: reviewed.review,
  };
}

describe.skipIf(!shouldRun)("COD orders on the managed store scope", () => {
  it("places one order, reserves stock once, and shows it only to the owning merchant", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 2,
    });

    expect(review.subtotal).toBe("22.00");
    expect(review.deliveryFee).toBe("15.00");
    expect(review.total).toBe("37.00");
    expect(review.currency).toBe("SAR");

    const result = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(result.status).toBe("placed");
    if (result.status !== "placed") return;

    expect(result.reference).toMatch(/^ORD-[A-HJ-NP-Z2-9]{6}$/);
    expect(result.total).toBe("37.00");

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.onHand).toBe(5);
    expect(inventory.reserved).toBe(2);

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      reference: result.reference,
      status: "placed",
      paymentMethod: "cod",
      paymentStatus: "awaiting_collection",
      fulfillmentStatus: "unfulfilled",
      subtotal: "22.00",
      deliveryFee: "15.00",
      total: "37.00",
      currency: "SAR",
      customerName: "Buyer One",
      customerPhone: "+15551234567",
      deliveryAddress: "123 Synthetic Test Street",
    });

    const items = await db().select().from(orderItem);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productName: "A One",
      unitPrice: "11.00",
      quantity: 2,
      lineTotal: "22.00",
    });
    expect(items[0].productSnapshot).toMatchObject({
      name: "A One",
      description: "First A product",
      categoryId: fixture.categoryAId,
      unitPrice: "11.00",
      currency: "SAR",
    });

    const reservations = await db().select().from(inventoryReservation);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      orderId: result.orderId,
      productId: fixture.productA1Id,
      quantity: 2,
      status: "reserved",
      storeId: fixture.storeAId,
    });

    const [converted] = await db()
      .select({ status: cart.status })
      .from(cart)
      .where(eq(cart.id, cartId));
    expect(converted.status).toBe("converted");
    expect(
      await readCartForBuyer(asAppDb(db()), scopeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
      }),
    ).toBeNull();

    const merchantA = await listMerchantOrders(asAppDb(db()), scopeA);
    expect(merchantA).toHaveLength(1);
    expect(merchantA[0].reference).toBe(result.reference);
    expect(merchantA[0].items[0].name).toBe("A One");

    const scopeB = await scope(fixture.storeBId);
    expect(await listMerchantOrders(asAppDb(db()), scopeB)).toEqual([]);
  });

  it("never reserves stock for a cart or an abandoned checkout", async () => {
    const scopeA = await scope(fixture.storeAId);
    const added = await addToCart(tx(), scopeA, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 3,
    });
    expect(added.status).toBe("added");

    let [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.reserved).toBe(0);

    if (added.status === "added") {
      await startCheckout(tx(), scopeA, {
        cartId: added.cart.id,
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        profileName: "Buyer One",
      });
    }

    [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.reserved).toBe(0);
    expect(inventory.onHand).toBe(5);
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);
  });

  it("returns the same reference on duplicate confirmation and reserves only once", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 2,
    });

    const first = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    const second = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(first.status).toBe("placed");
    expect(second.status).toBe("already_placed");
    if (first.status !== "placed" || second.status !== "already_placed") return;

    expect(second.reference).toBe(first.reference);
    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.reserved).toBe(2);
  });

  it("allows exactly one concurrent checkout for the last unit", async () => {
    const [reviewA, reviewB] = await Promise.all([
      prepareReviewedOrder({
        storeId: fixture.storeAId,
        connectionId: fixture.connectionAId,
        buyerId: BUYER_A,
        productId: fixture.productA1Id,
        quantity: 1,
      }),
      prepareReviewedOrder({
        storeId: fixture.storeAId,
        connectionId: fixture.connectionAId,
        buyerId: BUYER_B,
        productId: fixture.productA1Id,
        quantity: 1,
      }),
    ]);

    await db()
      .update(productInventory)
      .set({ onHand: 1, reserved: 0 })
      .where(eq(productInventory.productId, fixture.productA1Id));

    // The reviews used the previous availability (5); the confirmation must
    // recheck the locked stock row and let only one buyer win.
    const results = await Promise.all([
      confirmCodOrder(tx(), reviewA.scope, {
        cartId: reviewA.cartId,
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        expectedQuoteVersion: reviewA.review.quoteVersion,
      }),
      confirmCodOrder(tx(), reviewB.scope, {
        cartId: reviewB.cartId,
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
        telegramChatId: BUYER_B,
        expectedQuoteVersion: reviewB.review.quoteVersion,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "insufficient_stock",
      "placed",
    ]);
    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.onHand).toBe(1);
    expect(inventory.reserved).toBe(1);
  });

  it("rechecks stock during confirmation and prevents overselling", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 2,
    });

    await db()
      .update(productInventory)
      .set({ onHand: 1, reserved: 0 })
      .where(eq(productInventory.productId, fixture.productA1Id));

    const result = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(result.status).toBe("insufficient_stock");
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productA1Id));
    expect(inventory.reserved).toBe(0);
  });

  it("refuses a stale quote and shows the revised review before creating an order", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 2,
    });

    await db()
      .update(product)
      .set({ price: "13.50" })
      .where(eq(product.id, fixture.productA1Id));
    await db()
      .update(storeCommerceSetting)
      .set({ deliveryFee: "17.00" })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const stale = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(stale.status).toBe("stale_quote");
    if (stale.status !== "stale_quote") return;

    expect(stale.review.subtotal).toBe("27.00");
    expect(stale.review.deliveryFee).toBe("17.00");
    expect(stale.review.total).toBe("44.00");
    expect(stale.review.quoteVersion).toBe(review.quoteVersion + 1);
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);

    const confirmed = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: stale.review.quoteVersion,
    });

    expect(confirmed.status).toBe("placed");
    if (confirmed.status !== "placed") return;
    expect(confirmed.total).toBe("44.00");
  });

  it("treats a catalog item change as a stale quote even when the totals match", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
    });

    await db()
      .update(productTranslation)
      .set({ name: "Renamed Before Confirmation" })
      .where(eq(productTranslation.productId, fixture.productA1Id));

    const stale = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(stale.status).toBe("stale_quote");
    if (stale.status !== "stale_quote") return;
    expect(stale.review.lines[0].name).toBe("Renamed Before Confirmation");
    expect(stale.review.total).toBe("26.00");
    expect(await db().select().from(order)).toHaveLength(0);

    const placed = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: stale.review.quoteVersion,
    });
    expect(placed.status).toBe("placed");
    const [item] = await db().select().from(orderItem);
    expect(item.productName).toBe("Renamed Before Confirmation");
  });

  it("refuses confirmation without a delivery address", async () => {
    const scopeA = await scope(fixture.storeAId);
    const added = await addToCart(tx(), scopeA, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 1,
    });
    if (added.status !== "added") throw new Error("add failed");

    await startCheckout(tx(), scopeA, {
      cartId: added.cart.id,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      profileName: "Buyer One",
    });
    await savePhone(tx(), scopeA, {
      cartId: added.cart.id,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      phone: "+15551234567",
    });
    const review = await refreshReview(tx(), scopeA, {
      cartId: added.cart.id,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
    });
    if (review.status !== "review") throw new Error("review failed");

    const result = await confirmCodOrder(tx(), scopeA, {
      cartId: added.cart.id,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.review.quoteVersion,
    });

    expect(result).toEqual({ status: "missing_details", missing: "address" });
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);
  });

  it("does not let another buyer in the same store read or confirm the cart", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
    });

    expect(
      await readCartForBuyer(asAppDb(db()), scopeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
      }),
    ).toBeNull();

    const foreign = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_B,
      telegramChatId: BUYER_B,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(foreign.status).toBe("not_found");
    expect(await db().select().from(order)).toHaveLength(0);

    const own = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(own.status).toBe("placed");
  });

  it("does not let another store read, add to, or confirm the order", async () => {
    const { cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
    });
    const scopeB = await scope(fixture.storeBId);

    expect(
      await confirmCodOrder(tx(), scopeB, {
        cartId,
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        expectedQuoteVersion: review.quoteVersion,
      }),
    ).toEqual({ status: "not_found" });

    expect(
      await addToCart(tx(), scopeB, {
        connectionId: fixture.connectionBId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        productId: fixture.productA1Id,
        quantity: 1,
      }),
    ).toEqual({ status: "unavailable" });

    expect(await db().select().from(order)).toHaveLength(0);
    expect(await listMerchantOrders(asAppDb(db()), scopeB)).toEqual([]);
  });

  it("preserves the confirmed snapshot when the catalog changes later", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
      quantity: 2,
    });

    const placed = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    if (placed.status !== "placed") throw new Error("order failed");

    await db()
      .update(product)
      .set({ price: "99.00", isActive: false })
      .where(eq(product.id, fixture.productA1Id));
    await db()
      .update(productTranslation)
      .set({ name: "Renamed After Order", description: "Changed later" })
      .where(eq(productTranslation.productId, fixture.productA1Id));

    const orders = await listMerchantOrders(asAppDb(db()), scopeA);
    expect(orders).toHaveLength(1);
    expect(orders[0].reference).toBe(placed.reference);
    expect(orders[0].total).toBe("37.00");
    expect(orders[0].items[0]).toMatchObject({
      name: "A One",
      unitPrice: "11.00",
      quantity: 2,
      lineTotal: "22.00",
    });
    expect(orders[0].items[0].snapshot).toMatchObject({
      name: "A One",
      description: "First A product",
      unitPrice: "11.00",
    });

    const [storedItem] = await db().select().from(orderItem);
    expect(storedItem.productName).toBe("A One");
    expect(storedItem.unitPrice).toBe("11.00");
  });

  it("rejects invalid quantities and does not expose COD when the gate is off", async () => {
    const scopeA = await scope(fixture.storeAId);

    expect(
      await addToCart(tx(), scopeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        productId: fixture.productA1Id,
        quantity: 0,
      }),
    ).toEqual({ status: "invalid_quantity" });

    expect(
      await addToCart(tx(), scopeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        productId: fixture.productA1Id,
        quantity: 100,
      }),
    ).toEqual({ status: "invalid_quantity" });

    const previous = process.env.RABET_COD_ORDERS_ENABLED;

    try {
      process.env.RABET_COD_ORDERS_ENABLED = "false";
      expect(await isCodAvailable(asAppDb(db()), scopeA)).toEqual({
        enabled: false,
        setting: null,
      });
      expect(
        await addToCart(tx(), scopeA, {
          connectionId: fixture.connectionAId,
          telegramUserId: BUYER_A,
          telegramChatId: BUYER_A,
          productId: fixture.productA1Id,
          quantity: 1,
        }),
      ).toEqual({ status: "cod_unavailable" });
    } finally {
      if (previous === undefined) {
        delete process.env.RABET_COD_ORDERS_ENABLED;
      } else {
        process.env.RABET_COD_ORDERS_ENABLED = previous;
      }
    }

    await db()
      .update(storeCommerceSetting)
      .set({ codEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    expect((await isCodAvailable(asAppDb(db()), scopeA)).enabled).toBe(false);
    expect(await db().select().from(cart)).toHaveLength(0);
  });

  it("enforces immutable order snapshots and stock invariants in the database", async () => {
    const { scope: scopeA, cartId, review } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productA1Id,
    });
    const placed = await confirmCodOrder(tx(), scopeA, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    if (placed.status !== "placed") throw new Error("order failed");

    await expect(
      db().execute(
        sql`update "order" set total = 1.00 where id = ${placed.orderId}`,
      ),
    ).rejects.toBeTruthy();
    expect(pgErrorCode(await captureError(() =>
      db().execute(sql`update "order" set total = 1.00 where id = ${placed.orderId}`),
    ))).toBe("P0001");

    const itemError = await captureError(() =>
      db().execute(sql`update "order_item" set unit_price = 1.00`),
    );
    expect(pgErrorCode(itemError)).toBe("P0001");

    const stockError = await captureError(() =>
      db()
        .update(productInventory)
        .set({ reserved: 99 })
        .where(eq(productInventory.productId, fixture.productA1Id)),
    );
    expect(pgErrorCode(stockError)).toBe("23514");
  });
});

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}
