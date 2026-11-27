import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  botSetting,
  cart,
  inventoryReservation,
  language,
  order,
  productInventory,
  store,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  readCatalogCategoryAvailabilityForMerchant,
  updateCatalogCategoryAvailabilityForMerchant,
} from "@/lib/data/catalog";
import {
  publishMerchantCatalogProduct,
  readMerchantProductReadiness,
} from "@/lib/merchant/product-publish";
import {
  createMerchantCatalogProduct,
  resolveMerchantCatalogLanguage,
  type MerchantCatalogLanguage,
} from "@/lib/merchant/product-create";
import { listMerchantOrders } from "@/lib/commerce/orders";
import { saveMerchantCommerceSetting } from "@/lib/merchant/store-commerce";
import { hashWebhookSecret } from "@/lib/telegram/connection-secrets";
import { handleManagedTelegramWebhookRequest } from "@/lib/telegram/managed-webhook";
import {
  createFakeTelegramTransport,
  type FakeTelegramTransport,
} from "@/lib/telegram/transport";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let merchantLanguage: MerchantCatalogLanguage;
let updateId = 8000;

type Fixture = {
  storeAId: string;
  storeBId: string;
  userAId: string;
  userBId: string;
  connectionAId: string;
  connectionBId: string;
  languageId: string;
};

let fixture: Fixture;

const BUYER = 96001;

beforeAll(async () => {
  if (!shouldRun) return;
  process.env.RABET_COD_ORDERS_ENABLED = "true";
  testDb = await createTestDatabase("batch01_acceptance");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", textDirection: "ltr", isEnabled: true })
    .returning({ id: language.id });

  const [storeA] = await db
    .insert(store)
    .values({ name: "Batch A", slug: "batch-a", status: "active" })
    .returning({ id: store.id });
  const [storeB] = await db
    .insert(store)
    .values({ name: "Batch B", slug: "batch-b", status: "active" })
    .returning({ id: store.id });

  const [userA] = await db
    .insert(appUser)
    .values({ email: "batch.a@example.test" })
    .returning({ id: appUser.id });
  const [userB] = await db
    .insert(appUser)
    .values({ email: "batch.b@example.test" })
    .returning({ id: appUser.id });

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  // Only provisioning needed to configure commerce and reach the Store Bot.
  await db.insert(botSetting).values({
    id: 1,
    storeId: storeA.id,
    defaultLanguageId: english.id,
    currency: "EGP",
    displayName: "Batch A",
  });

  const [connectionA] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeA.id,
      botId: 991001,
      botUsername: "BatchAStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("batch-secret-a"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/batch-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning({ id: telegramConnection.id });
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 991002,
      botUsername: "BatchBStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("batch-secret-b"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/batch-b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning({ id: telegramConnection.id });

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    userAId: userA.id,
    userBId: userB.id,
    connectionAId: connectionA.id,
    connectionBId: connectionB.id,
    languageId: english.id,
  };

  merchantLanguage = (await resolveMerchantCatalogLanguage(asAppDb(db)))!;
});

afterAll(async () => {
  delete process.env.RABET_COD_ORDERS_ENABLED;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  updateId = 8000;
  await testDb.db.execute(sql`
    truncate table
      "inventory_reservation",
      "order_item",
      "order",
      "cart_item",
      "cart",
      "telegram_managed_update"
    restart identity cascade
  `);
  await testDb.db.execute(sql`delete from product_inventory`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category_translation`);
  await testDb.db.execute(sql`delete from category`);
  await testDb.db.execute(sql`delete from store_commerce_setting`);
});

function db() {
  return testDb!.db;
}
function appDb() {
  return asAppDb(db());
}
function identity() {
  return { userId: fixture.userAId, sessionVersion: 0 };
}

function nextUpdateId() {
  updateId += 1;
  return updateId;
}

function messageUpdate(buyerId: number, text: string) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      chat: { id: buyerId, type: "private" },
      date: 1,
      text,
    },
  };
}

function contactUpdate(buyerId: number, phoneNumber: string) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      chat: { id: buyerId, type: "private" },
      date: 1,
      contact: { phone_number: phoneNumber, first_name: "Buyer", user_id: buyerId },
    },
  };
}

function callbackUpdate(buyerId: number, data: string) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `callback-${nextUpdateId()}`,
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      message: {
        message_id: 7000 + updateId,
        chat: { id: buyerId, type: "private" },
        date: 1,
      },
      data,
    },
  };
}

async function call(
  connectionId: string,
  body: unknown,
  secret = "batch-secret-a",
  transport: FakeTelegramTransport = createFakeTelegramTransport(),
): Promise<{ status: number; transport: FakeTelegramTransport }> {
  const req = new Request(
    "https://app.example.test/api/telegram/webhook/managed/x",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(body),
    },
  );
  const response = await handleManagedTelegramWebhookRequest(req, connectionId, {
    db: appDb(),
    commerceDb: db() as unknown as TransactionDatabase,
    transport,
  });
  return { status: response.status, transport };
}

type AnyMessage = { text?: string; caption?: string; replyMarkup?: unknown };

function allMessages(transport: FakeTelegramTransport): AnyMessage[] {
  return [
    ...transport.sentMessages,
    ...transport.sentPhotos,
    ...transport.editedMessages,
    ...transport.editedMedia,
  ] as unknown as AnyMessage[];
}

function allText(transport: FakeTelegramTransport): string {
  return allMessages(transport)
    .map((m) => `${m.text ?? ""}\n${m.caption ?? ""}`)
    .join("\n");
}

function inlineButtons(message: AnyMessage) {
  const markup = message.replyMarkup as
    | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}

async function createAndPublishProduct() {
  const access = await resolveMerchantAccess(db(), identity());
  if (!access) throw new Error("expected merchant access");

  const created = await createMerchantCatalogProduct(db(), access, merchantLanguage, {
    name: "Handmade Lantern",
    price: "49.00",
    newCategoryName: "Batch 01 Home",
    description: "A brass lantern made for the Batch 01 proof.",
    imageUrl: "https://example.test/lantern.png",
    stock: 3,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error}`);

  const categoryState = await readCatalogCategoryAvailabilityForMerchant(
    appDb(),
    access.scope,
    identity(),
    created.categoryId,
  );
  if (!categoryState) throw new Error("expected category state");
  const activated = await updateCatalogCategoryAvailabilityForMerchant(
    appDb(),
    access.scope,
    identity(),
    created.categoryId,
    true,
    categoryState.revision,
  );
  if (!activated) throw new Error("category activation failed");

  const commerce = await saveMerchantCommerceSetting(db(), access, {
    codEnabled: true,
    deliveryFee: "12.50",
  });
  if (!commerce.ok) throw new Error(`commerce failed: ${commerce.error}`);

  const readiness = await readMerchantProductReadiness(
    appDb(),
    access,
    created.productId,
  );
  if (!readiness) throw new Error("expected readiness");
  expect(readiness.ready).toBe(true);

  const published = await publishMerchantCatalogProduct(appDb(), access, {
    productId: created.productId,
    revision: readiness.revision,
  });
  expect(published).toMatchObject({ ok: true, isActive: true });

  return { access, productId: created.productId };
}

describe.skipIf(!shouldRun)("Batch 01 merchant-to-buyer acceptance", () => {
  it("lets a merchant create, configure and publish a product that a buyer then buys once by COD", async () => {
    const { access, productId } = await createAndPublishProduct();

    // Buyer lands in the existing managed storefront and opens the product.
    const started = await call(fixture.connectionAId, messageUpdate(BUYER, "/start"));
    expect(started.status).toBe(200);

    const cardTransport = started.transport;
    const card = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER, `p:${productId}`),
      "batch-secret-a",
      cardTransport,
    );
    expect(card.status).toBe(200);

    const cardText = allText(card.transport);
    expect(cardText).toContain("Handmade Lantern");
    expect(cardText).toContain("A brass lantern made for the Batch 01 proof.");
    expect(cardText).toContain("49.00");
    expect(cardText).toContain("In stock");

    // Add the product and follow the existing COD checkout.
    const added = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER, `ca:${productId}:1`),
      "batch-secret-a",
      card.transport,
    );
    expect(added.status).toBe(200);
    expect(allText(added.transport)).toContain("49.00 EGP");

    const [cartRow] = await db()
      .select({ id: cart.id })
      .from(cart)
      .where(eq(cart.storeId, fixture.storeAId))
      .limit(1);
    expect(cartRow).toBeDefined();

    const checkout = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER, `co:${cartRow.id}`),
      "batch-secret-a",
      added.transport,
    );
    expect(checkout.status).toBe(200);

    const phone = await call(
      fixture.connectionAId,
      contactUpdate(BUYER, "+201000000000"),
      "batch-secret-a",
      checkout.transport,
    );
    expect(phone.status).toBe(200);

    const review = await call(
      fixture.connectionAId,
      messageUpdate(BUYER, "12 Batch Acceptance Street"),
      "batch-secret-a",
      phone.transport,
    );
    expect(review.status).toBe(200);
    const reviewText = allText(review.transport);
    expect(reviewText).toContain("Review your order");
    expect(reviewText).toContain("Subtotal: 49.00 EGP");
    expect(reviewText).toContain("Delivery fee: 12.50 EGP");
    expect(reviewText).toContain("Total: 61.50 EGP");

    const reviewMessage = [...review.transport.sentMessages].reverse()[0];
    const confirm = inlineButtons(reviewMessage).find((b) =>
      b.callback_data?.startsWith("cc:"),
    );
    expect(confirm?.callback_data).toBeDefined();

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER, confirm!.callback_data!),
      "batch-secret-a",
      review.transport,
    );
    expect(confirmed.status).toBe(200);

    const receipt = [...confirmed.transport.sentMessages]
      .reverse()
      .find((m) => /placed/.test(m.text));
    expect(receipt).toBeDefined();
    expect(receipt!.text).toContain("awaiting collection");
    expect(receipt!.text).toContain("61.50 EGP");
    const reference = /Order (ORD-[A-HJ-NP-Z2-9]{6}) placed/.exec(receipt!.text)?.[1];
    expect(reference).toBeDefined();

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      storeId: fixture.storeAId,
      reference,
      paymentStatus: "awaiting_collection",
      total: "61.50",
    });
    const reservations = await db().select().from(inventoryReservation);
    expect(reservations).toHaveLength(1);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, productId));
    expect(inventory).toMatchObject({ onHand: 3, reserved: 1 });

    // Replay the confirmation: no second order or reservation.
    const replay = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER, confirm!.callback_data!),
      "batch-secret-a",
      confirmed.transport,
    );
    expect(replay.status).toBe(200);
    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    // Only the owning merchant sees the order; the other store sees none.
    const merchantOrders = await listMerchantOrders(appDb(), access.scope);
    expect(merchantOrders.map((o) => o.reference)).toEqual([reference]);
    const otherAccess = await resolveMerchantAccess(db(), {
      userId: fixture.userBId,
      sessionVersion: 0,
    });
    expect(otherAccess).not.toBeNull();
    expect(await listMerchantOrders(appDb(), otherAccess!.scope)).toHaveLength(0);

    // The other store's bot cannot resolve this product.
    const crossStore = await call(
      fixture.connectionBId,
      callbackUpdate(96002, `p:${productId}`),
      "batch-secret-b",
    );
    expect(crossStore.status).toBe(200);
    expect(allText(crossStore.transport)).not.toContain("Handmade Lantern");
  });
});
