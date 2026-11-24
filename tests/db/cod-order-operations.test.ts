import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  category,
  inventoryReservation,
  order,
  orderItem,
  product,
  productInventory,
  store,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  acceptMerchantOrder,
  cancelMerchantOrder,
  listMerchantOrders,
  prepareMerchantOrder,
} from "@/lib/commerce/orders";
import {
  CANCELLATION_REASON_MAX_LENGTH,
  normalizeCancellationReason,
} from "@/lib/commerce/order-state";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  pgErrorMessage,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

type Fixture = {
  storeAId: string;
  storeBId: string;
  productA1Id: string;
  productA2Id: string;
  productB1Id: string;
  connectionAId: string;
  connectionBId: string;
};

let fixture: Fixture;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("cod_order_operations");
  const db = testDb.db;

  const [storeA] = await db
    .insert(store)
    .values({ name: "Operations Store A", slug: "ops-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Operations Store B", slug: "ops-store-b", status: "active" })
    .returning();

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "ops-store-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "ops-store-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  const [productA1] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "ops-a-one",
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
      slug: "ops-a-two",
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
      slug: "ops-b-one",
      price: "30.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productInventory).values([
    { productId: productA1.id, storeId: storeA.id, onHand: 5, reserved: 0 },
    { productId: productA2.id, storeId: storeA.id, onHand: 10, reserved: 0 },
    { productId: productB1.id, storeId: storeB.id, onHand: 5, reserved: 0 },
  ]);

  const [connectionA] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeA.id,
      botId: 892001,
      botUsername: "OpsStoreABot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "d".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/ops-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 892002,
      botUsername: "OpsStoreBBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "e".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/ops-b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    productA1Id: productA1.id,
    productA2Id: productA2.id,
    productB1Id: productB1.id,
    connectionAId: connectionA.id,
    connectionBId: connectionB.id,
  };
});

afterAll(async () => {
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
      "order"
    restart identity cascade
  `);

  await db
    .update(productInventory)
    .set({ onHand: 5, reserved: 0 })
    .where(eq(productInventory.productId, fixture.productA1Id));
  await db
    .update(productInventory)
    .set({ onHand: 10, reserved: 0 })
    .where(eq(productInventory.productId, fixture.productA2Id));
  await db
    .update(productInventory)
    .set({ onHand: 5, reserved: 0 })
    .where(eq(productInventory.productId, fixture.productB1Id));
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

function money(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

type SeedItem = {
  productId: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
};

async function seedOrder(input: {
  storeId: string;
  connectionId: string;
  reference: string;
  items: SeedItem[];
  telegramUserId?: number;
}): Promise<string> {
  const subtotalCents = input.items.reduce(
    (total, item) => total + item.unitPriceCents * item.quantity,
    0,
  );
  const deliveryFeeCents = 1500;

  const [row] = await db()
    .insert(order)
    .values({
      storeId: input.storeId,
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId ?? 92001,
      telegramChatId: input.telegramUserId ?? 92001,
      reference: input.reference,
      checkoutKey: crypto.randomUUID(),
      status: "placed",
      paymentMethod: "cod",
      paymentStatus: "awaiting_collection",
      fulfillmentStatus: "unfulfilled",
      currency: "SAR",
      subtotal: money(subtotalCents),
      deliveryFee: money(deliveryFeeCents),
      total: money(subtotalCents + deliveryFeeCents),
      customerName: "Synthetic Buyer",
      customerPhone: "+15550000000",
      deliveryAddress: "123 Synthetic Operations Street",
    })
    .returning();

  const itemRows = await db()
    .insert(orderItem)
    .values(
      input.items.map((item) => ({
        orderId: row.id,
        productId: item.productId,
        productName: item.productName,
        unitPrice: money(item.unitPriceCents),
        quantity: item.quantity,
        lineTotal: money(item.unitPriceCents * item.quantity),
        productSnapshot: {
          name: item.productName,
          currency: "SAR",
          unitPrice: money(item.unitPriceCents),
        },
      })),
    )
    .returning({ id: orderItem.id, productId: orderItem.productId });

  const itemByProduct = new Map(
    itemRows.map((itemRow) => [itemRow.productId, itemRow.id]),
  );

  await db()
    .insert(inventoryReservation)
    .values(
      input.items.map((item) => ({
        orderId: row.id,
        orderItemId: itemByProduct.get(item.productId)!,
        productId: item.productId,
        storeId: input.storeId,
        quantity: item.quantity,
        status: "reserved",
      })),
    );

  for (const item of input.items) {
    await db()
      .update(productInventory)
      .set({ reserved: sql`${productInventory.reserved} + ${item.quantity}` })
      .where(eq(productInventory.productId, item.productId));
  }

  return row.id;
}

function standardItems(): SeedItem[] {
  return [
    {
      productId: fixture.productA1Id,
      productName: "Ops A One",
      unitPriceCents: 1100,
      quantity: 2,
    },
    {
      productId: fixture.productA2Id,
      productName: "Ops A Two",
      unitPriceCents: 2000,
      quantity: 1,
    },
  ];
}

async function inventory(productId: string) {
  const [row] = await db()
    .select()
    .from(productInventory)
    .where(eq(productInventory.productId, productId));
  return row;
}

async function reservationsFor(orderId: string) {
  return db()
    .select()
    .from(inventoryReservation)
    .where(eq(inventoryReservation.orderId, orderId))
    .orderBy(inventoryReservation.productId);
}

describe.skipIf(!shouldRun)("merchant COD order operations", () => {
  it("accepts then prepares, and retries both steps without changing state", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABC234",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);

    const accepted = await acceptMerchantOrder(tx(), scopeA, orderId);
    expect(accepted).toMatchObject({
      status: "accepted",
      orderId,
      orderStatus: "accepted",
      fulfillmentStatus: "unfulfilled",
      releasedQuantity: 0,
    });

    const [afterAccept] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(afterAccept.acceptedAt).not.toBeNull();
    expect(afterAccept.preparingAt).toBeNull();
    expect(afterAccept.cancelledAt).toBeNull();

    const acceptedAgain = await acceptMerchantOrder(tx(), scopeA, orderId);
    expect(acceptedAgain.status).toBe("already_applied");

    const [afterAcceptRetry] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(afterAcceptRetry.acceptedAt).toEqual(afterAccept.acceptedAt);
    expect(afterAcceptRetry.status).toBe("accepted");

    const prepared = await prepareMerchantOrder(tx(), scopeA, orderId);
    expect(prepared).toMatchObject({
      status: "preparing",
      orderId,
      orderStatus: "preparing",
      fulfillmentStatus: "unfulfilled",
      releasedQuantity: 0,
    });

    const [afterPrepare] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(afterPrepare.preparingAt).not.toBeNull();
    expect(afterPrepare.acceptedAt).toEqual(afterAccept.acceptedAt);

    const preparedAgain = await prepareMerchantOrder(tx(), scopeA, orderId);
    expect(preparedAgain.status).toBe("already_applied");

    const [afterPrepareRetry] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(afterPrepareRetry.preparingAt).toEqual(afterPrepare.preparingAt);

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 1,
    });

    const merchantOrders = await listMerchantOrders(
      asAppDb(db()),
      scopeA,
      100,
    );
    expect(merchantOrders).toHaveLength(1);
    expect(merchantOrders[0]).toMatchObject({
      id: orderId,
      status: "preparing",
      fulfillmentStatus: "unfulfilled",
      cancellationReason: null,
    });
    expect(merchantOrders[0].acceptedAt).toBeInstanceOf(Date);
    expect(merchantOrders[0].preparingAt).toBeInstanceOf(Date);
    expect(merchantOrders[0].reservationStatuses.sort()).toEqual([
      "reserved",
      "reserved",
    ]);
  });

  it("refuses preparation before acceptance and any action after cancellation", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABD345",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);

    const premature = await prepareMerchantOrder(tx(), scopeA, orderId);
    expect(premature).toMatchObject({
      status: "invalid_transition",
      currentStatus: "placed",
    });

    await acceptMerchantOrder(tx(), scopeA, orderId);
    const cancelled = await cancelMerchantOrder(tx(), scopeA, {
      orderId,
      reason: "Buyer asked to cancel",
    });
    expect(cancelled.status).toBe("cancelled");

    expect(await acceptMerchantOrder(tx(), scopeA, orderId)).toMatchObject({
      status: "invalid_transition",
      currentStatus: "cancelled",
    });
    expect(await prepareMerchantOrder(tx(), scopeA, orderId)).toMatchObject({
      status: "invalid_transition",
      currentStatus: "cancelled",
    });
  });

  it("cancels before shipment, releases each reservation once, and preserves on-hand stock", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABE456",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);

    await acceptMerchantOrder(tx(), scopeA, orderId);
    await prepareMerchantOrder(tx(), scopeA, orderId);

    const result = await cancelMerchantOrder(tx(), scopeA, {
      orderId,
      reason: "Customer requested cancellation",
    });
    expect(result).toMatchObject({
      status: "cancelled",
      orderId,
      orderStatus: "cancelled",
      fulfillmentStatus: "cancelled",
      cancellationReason: "Customer requested cancellation",
      releasedQuantity: 3,
    });

    const [cancelledOrder] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(cancelledOrder.status).toBe("cancelled");
    expect(cancelledOrder.fulfillmentStatus).toBe("cancelled");
    expect(cancelledOrder.cancellationReason).toBe(
      "Customer requested cancellation",
    );
    expect(cancelledOrder.cancelledAt).not.toBeNull();
    expect(cancelledOrder.acceptedAt).not.toBeNull();
    expect(cancelledOrder.preparingAt).not.toBeNull();

    const reservations = await reservationsFor(orderId);
    expect(reservations).toHaveLength(2);
    for (const reservation of reservations) {
      expect(reservation.status).toBe("released");
      expect(reservation.releaseReason).toBe("Customer requested cancellation");
      expect(reservation.releasedAt).not.toBeNull();
    }

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 0,
    });

    const retry = await cancelMerchantOrder(tx(), scopeA, {
      orderId,
      reason: "A different retry reason",
    });
    expect(retry).toMatchObject({
      status: "already_applied",
      orderId,
      orderStatus: "cancelled",
      cancellationReason: "Customer requested cancellation",
      releasedQuantity: 0,
    });

    const [afterRetry] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(afterRetry.cancellationReason).toBe(
      "Customer requested cancellation",
    );
    expect(afterRetry.cancelledAt).toEqual(cancelledOrder.cancelledAt);

    const reservationsAfterRetry = await reservationsFor(orderId);
    expect(reservationsAfterRetry).toHaveLength(2);
    for (const reservation of reservationsAfterRetry) {
      expect(reservation.status).toBe("released");
      expect(reservation.releasedAt).toEqual(
        reservations.find((row) => row.id === reservation.id)?.releasedAt,
      );
    }

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 0,
    });
  });

  it("allows cancellation from placed but refuses it after the order is handed to shipping", async () => {
    const placedOrderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABF567",
      items: standardItems(),
      telegramUserId: 92002,
    });
    const shippingOrderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABG678",
      items: standardItems(),
      telegramUserId: 92003,
    });
    const scopeA = await scope(fixture.storeAId);

    const directCancel = await cancelMerchantOrder(tx(), scopeA, {
      orderId: placedOrderId,
      reason: "Out of stock before packing",
    });
    expect(directCancel.status).toBe("cancelled");

    await db()
      .update(order)
      .set({ fulfillmentStatus: "handed_to_shipping" })
      .where(eq(order.id, shippingOrderId));

    const tooLate = await cancelMerchantOrder(tx(), scopeA, {
      orderId: shippingOrderId,
      reason: "Too late to cancel",
    });
    expect(tooLate).toMatchObject({
      status: "invalid_transition",
      currentStatus: "placed",
      fulfillmentStatus: "handed_to_shipping",
    });

    expect(await acceptMerchantOrder(tx(), scopeA, shippingOrderId)).toMatchObject(
      {
        status: "invalid_transition",
        currentStatus: "placed",
        fulfillmentStatus: "handed_to_shipping",
      },
    );
    expect(
      await prepareMerchantOrder(tx(), scopeA, shippingOrderId),
    ).toMatchObject({
      status: "invalid_transition",
      currentStatus: "placed",
      fulfillmentStatus: "handed_to_shipping",
    });

    expect(await reservationsFor(shippingOrderId)).toHaveLength(2);
    for (const reservation of await reservationsFor(shippingOrderId)) {
      expect(reservation.status).toBe("reserved");
    }

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 1,
    });
  });

  it("serializes concurrent cancellation retries so stock is released exactly once", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABH789",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);

    const results = await Promise.all([
      cancelMerchantOrder(tx(), scopeA, {
        orderId,
        reason: "Concurrent cancellation A",
      }),
      cancelMerchantOrder(tx(), scopeA, {
        orderId,
        reason: "Concurrent cancellation B",
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_applied",
      "cancelled",
    ]);

    const reservations = await reservationsFor(orderId);
    expect(reservations).toHaveLength(2);
    for (const reservation of reservations) {
      expect(reservation.status).toBe("released");
      expect(reservation.releasedAt).not.toBeNull();
    }

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 0,
    });

    const [cancelledOrder] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(cancelledOrder.status).toBe("cancelled");
    expect([
      "Concurrent cancellation A",
      "Concurrent cancellation B",
    ]).toContain(cancelledOrder.cancellationReason);
  });

  it("rejects cross-store actions and invalid cancellation reasons without writes", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABJ892",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);
    const scopeB = await scope(fixture.storeBId);

    expect(await acceptMerchantOrder(tx(), scopeB, orderId)).toEqual({
      status: "not_found",
    });
    expect(await prepareMerchantOrder(tx(), scopeB, orderId)).toEqual({
      status: "not_found",
    });
    expect(
      await cancelMerchantOrder(tx(), scopeB, {
        orderId,
        reason: "Cross-store cancellation attempt",
      }),
    ).toEqual({ status: "not_found" });

    for (const reason of [
      "",
      "   ",
      "no",
      "x".repeat(CANCELLATION_REASON_MAX_LENGTH + 1),
      null,
    ]) {
      expect(
        await cancelMerchantOrder(tx(), scopeA, { orderId, reason }),
      ).toEqual({ status: "invalid_reason" });
    }

    const [unchanged] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(unchanged.status).toBe("placed");
    expect(unchanged.cancellationReason).toBeNull();
    expect(unchanged.cancelledAt).toBeNull();
    expect(unchanged.acceptedAt).toBeNull();

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 1,
    });
    expect(
      (await reservationsFor(orderId)).every(
        (reservation) => reservation.status === "reserved",
      ),
    ).toBe(true);

    expect(await listMerchantOrders(asAppDb(db()), scopeB)).toEqual([]);
    const ownOrders = await listMerchantOrders(asAppDb(db()), scopeA);
    expect(ownOrders.map((merchantOrder) => merchantOrder.id)).toEqual([
      orderId,
    ]);
  });

  it("rolls back released reservations when the cancellation transaction fails", async () => {
    const orderId = await seedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      reference: "ORD-ABK923",
      items: standardItems(),
    });
    const scopeA = await scope(fixture.storeAId);

    await db().execute(sql`
      create or replace function reject_order_cancellation()
      returns trigger language plpgsql as $$
      begin
        if new.status = 'cancelled' then
          raise exception 'cancellation blocked by acceptance fixture';
        end if;
        return new;
      end;
      $$
    `);
    await db().execute(sql`
      create trigger reject_order_cancellation_trigger
      before update on "order"
      for each row execute function reject_order_cancellation()
    `);

    let cancellationError: unknown = null;

    try {
      await cancelMerchantOrder(tx(), scopeA, {
        orderId,
        reason: "Cancellation must roll back",
      });
    } catch (error) {
      cancellationError = error;
    } finally {
      await db().execute(
        sql`drop trigger if exists reject_order_cancellation_trigger on "order"`,
      );
      await db().execute(
        sql`drop function if exists reject_order_cancellation()`,
      );
    }

    expect(pgErrorMessage(cancellationError)).toContain(
      "cancellation blocked by acceptance fixture",
    );

    const [unchangedOrder] = await db()
      .select()
      .from(order)
      .where(eq(order.id, orderId));
    expect(unchangedOrder.status).toBe("placed");
    expect(unchangedOrder.cancellationReason).toBeNull();
    expect(unchangedOrder.cancelledAt).toBeNull();

    const reservations = await reservationsFor(orderId);
    expect(
      reservations.every((reservation) => reservation.status === "reserved"),
    ).toBe(true);
    expect(
      reservations.every(
        (reservation) =>
          reservation.releasedAt === null &&
          reservation.releaseReason === null,
      ),
    ).toBe(true);

    expect(await inventory(fixture.productA1Id)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(await inventory(fixture.productA2Id)).toMatchObject({
      onHand: 10,
      reserved: 1,
    });
  });
});

describe("merchant order reason normalisation", () => {
  it("trims a bounded reason and rejects empty or oversized values", () => {
    expect(normalizeCancellationReason("  Customer changed mind  ")).toBe(
      "Customer changed mind",
    );
    expect(normalizeCancellationReason("سبب واضح للإلغاء")).toBe(
      "سبب واضح للإلغاء",
    );
    expect(normalizeCancellationReason("no")).toBeNull();
    expect(normalizeCancellationReason("   ")).toBeNull();
    expect(
      normalizeCancellationReason(
        "x".repeat(CANCELLATION_REASON_MAX_LENGTH + 1),
      ),
    ).toBeNull();
  });
});
