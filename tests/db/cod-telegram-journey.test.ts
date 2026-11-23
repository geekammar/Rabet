import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  appUser,
  cart,
  category,
  categoryTranslation,
  inventoryReservation,
  language,
  order,
  product,
  productInventory,
  productTranslation,
  store,
  storeCommerceSetting,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
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
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let updateId = 5000;

type Fixture = {
  storeAId: string;
  storeBId: string;
  categoryAId: string;
  categoryBId: string;
  productAId: string;
  productBId: string;
  connectionAId: string;
  connectionBId: string;
  languageId: string;
};

let fixture: Fixture;

const BUYER_A = 92001;
const BUYER_B = 92002;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.RABET_COD_ORDERS_ENABLED = "true";
  testDb = await createTestDatabase("cod_telegram_journey");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({ name: "Bot COD Store A", slug: "bot-cod-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Bot COD Store B", slug: "bot-cod-store-b", status: "active" })
    .returning();

  const [userA] = await db
    .insert(appUser)
    .values({ email: "botcod.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "botcod.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "bot-cod-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "bot-cod-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "Bot A Root" },
    { categoryId: categoryB.id, languageId: english.id, name: "Bot B Root" },
  ]);

  const [productA] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "bot-cod-a-product",
      price: "11.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();
  const [productB] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "bot-cod-b-product",
      price: "30.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: productA.id,
      languageId: english.id,
      name: "Bot A One",
      description: "Bot A description",
    },
    {
      productId: productB.id,
      languageId: english.id,
      name: "Bot B One",
      description: "Bot B description",
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
    { productId: productA.id, storeId: storeA.id, onHand: 5, reserved: 0 },
    { productId: productB.id, storeId: storeB.id, onHand: 5, reserved: 0 },
  ]);

  const [connectionA] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeA.id,
      botId: 990001,
      botUsername: "BotCodAStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("bot-secret-a"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/bot-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 990002,
      botUsername: "BotCodBStoreBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret("bot-secret-b"),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/bot-b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    categoryAId: categoryA.id,
    categoryBId: categoryB.id,
    productAId: productA.id,
    productBId: productB.id,
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
  updateId = 5000;
  const db = testDb.db;

  await db.execute(sql`
    truncate table
      "inventory_reservation",
      "order_item",
      "order",
      "cart_item",
      "cart",
      "telegram_managed_update"
    restart identity cascade
  `);

  await db
    .update(product)
    .set({ price: "11.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productAId));
  await db
    .update(product)
    .set({ price: "30.00", isActive: true, deletedAt: null })
    .where(eq(product.id, fixture.productBId));

  await db.execute(sql`
    update "product_inventory" set on_hand = 5, reserved = 0
  `);

  await db
    .update(storeCommerceSetting)
    .set({ deliveryFee: "15.00", codEnabled: true })
    .where(eq(storeCommerceSetting.storeId, fixture.storeAId));
});

function db() {
  return testDb!.db;
}

function nextUpdateId(): number {
  updateId += 1;
  return updateId;
}

function webhookRequest(body: unknown, secret = "bot-secret-a"): Request {
  return new Request("https://app.example.test/api/telegram/webhook/managed/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

function messageUpdate(
  buyerId: number,
  text: string,
  extra: Record<string, unknown> = {},
  languageCode?: string,
) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
      chat: { id: buyerId, type: "private" },
      date: 1,
      text,
      ...extra,
    },
  };
}

function contactUpdate(
  buyerId: number,
  phoneNumber: string,
  languageCode?: string,
) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
      chat: { id: buyerId, type: "private" },
      date: 1,
      contact: {
        phone_number: phoneNumber,
        first_name: "Buyer",
        user_id: buyerId,
      },
    },
  };
}

function callbackUpdate(
  buyerId: number,
  data: string,
  languageCode?: string,
) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `callback-${nextUpdateId()}`,
      from: {
        id: buyerId,
        is_bot: false,
        first_name: "Buyer",
        ...(languageCode ? { language_code: languageCode } : {}),
      },
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
  secret = "bot-secret-a",
): Promise<{ status: number; transport: FakeTelegramTransport }> {
  const transport = createFakeTelegramTransport();
  const response = await handleManagedTelegramWebhookRequest(
    webhookRequest(body, secret),
    connectionId,
    {
      db: asAppDb(db()),
      commerceDb: db() as unknown as TransactionDatabase,
      transport,
    },
  );

  return { status: response.status, transport };
}

function inlineButtons(message: {
  replyMarkup?: unknown;
}): Array<{ text: string; callback_data?: string }> {
  const markup = message.replyMarkup as
    | { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }
    | undefined;

  return markup?.inline_keyboard?.flat() ?? [];
}

function lastButton(
  transport: FakeTelegramTransport,
  prefix: string,
): { text: string; callback_data?: string } | undefined {
  const messages = [...transport.sentMessages, ...transport.editedMessages];
  for (const message of messages.slice().reverse()) {
    const button = inlineButtons(message).find((entry) =>
      entry.callback_data?.startsWith(prefix),
    );
    if (button) return button;
  }
  return undefined;
}

function lastText(transport: FakeTelegramTransport): string {
  return (
    transport.editedMessages.at(-1)?.text ??
    transport.sentMessages.at(-1)?.text ??
    ""
  );
}

async function startProductFlow(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<FakeTelegramTransport> {
  const start = await call(
    connectionId,
    messageUpdate(buyerId, "/start"),
    secret,
  );
  expect(start.status).toBe(200);

  const product = await call(
    connectionId,
    callbackUpdate(buyerId, `p:${fixture.productAId}`),
    secret,
  );
  expect(product.status).toBe(200);
  return product.transport;
}

async function addAndCheckout(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<{ cartId: string; transport: FakeTelegramTransport }> {
  const productTransport = await startProductFlow(buyerId, connectionId, secret);
  const productMessage = productTransport.editedMessages.at(-1);
  expect(productMessage?.text).toContain("Bot A One");

  const addUpdate = callbackUpdate(
    buyerId,
    `ca:${fixture.productAId}:2`,
  );
  const added = await call(connectionId, addUpdate, secret);
  expect(added.status).toBe(200);
  expect(lastText(added.transport)).toContain("Subtotal: 22.00 SAR");

  const checkoutButton = lastButton(added.transport, "co:");
  expect(checkoutButton?.callback_data).toBeDefined();
  const checkout = await call(
    connectionId,
    callbackUpdate(buyerId, checkoutButton!.callback_data!),
    secret,
  );
  expect(checkout.status).toBe(200);
  expect(
    checkout.transport.sentMessages.some((message) =>
      message.text.includes("Send your phone number"),
    ),
  ).toBe(true);

  const cartId = checkoutButton!.callback_data!.slice(3);
  return { cartId, transport: checkout.transport };
}

async function completeReview(
  buyerId = BUYER_A,
  connectionId = fixture.connectionAId,
  secret = "bot-secret-a",
): Promise<{
  cartId: string;
  confirmData: string;
  transport: FakeTelegramTransport;
}> {
  const { cartId } = await addAndCheckout(buyerId, connectionId, secret);

  const phone = await call(
    connectionId,
    contactUpdate(buyerId, "+15551234567"),
    secret,
  );
  expect(phone.status).toBe(200);
  expect(
    phone.transport.sentMessages.some((message) =>
      message.text.includes("delivery address"),
    ),
  ).toBe(true);

  const reviewed = await call(
    connectionId,
    messageUpdate(buyerId, "123 Synthetic Telegram Street"),
    secret,
  );
  expect(reviewed.status).toBe(200);
  const reviewMessage = reviewed.transport.sentMessages.at(-1);
  expect(reviewMessage?.text).toContain("Review your order");
  expect(reviewMessage?.text).toContain("Subtotal: 22.00 SAR");
  expect(reviewMessage?.text).toContain("Delivery fee: 15.00 SAR");
  expect(reviewMessage?.text).toContain("Total: 37.00 SAR");
  expect(reviewMessage?.text).toContain("Payment: Cash on delivery");

  const confirm = inlineButtons(reviewMessage!).find((button) =>
    button.callback_data?.startsWith("cc:"),
  );
  expect(confirm?.callback_data).toBeDefined();

  return {
    cartId,
    confirmData: confirm!.callback_data!,
    transport: reviewed.transport,
  };
}

describe.skipIf(!shouldRun)("COD managed Telegram journey", () => {
  it("keeps catalog browsing unchanged when the COD gate is off", async () => {
    const previous = process.env.RABET_COD_ORDERS_ENABLED;

    try {
      process.env.RABET_COD_ORDERS_ENABLED = "false";

      const start = await call(
        fixture.connectionAId,
        messageUpdate(BUYER_A, "/start"),
      );
      expect(start.status).toBe(200);
      expect(lastText(start.transport)).not.toContain("Cart");

      const product = await call(
        fixture.connectionAId,
        callbackUpdate(BUYER_A, `p:${fixture.productAId}`),
      );
      expect(product.status).toBe(200);
      const productText = product.transport.editedMessages.at(-1)?.text ?? "";
      expect(productText).toContain("Bot A One");
      expect(productText).not.toContain("Add 1");
      expect(
        inlineButtons(product.transport.editedMessages.at(-1)!).some((button) =>
          button.callback_data?.startsWith("ca:"),
        ),
      ).toBe(false);
      expect(await db().select().from(cart)).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        delete process.env.RABET_COD_ORDERS_ENABLED;
      } else {
        process.env.RABET_COD_ORDERS_ENABLED = previous;
      }
    }
  });

  it("places one COD order from product to contact, address, review and confirmation", async () => {
    const { cartId, confirmData } = await completeReview();

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );

    expect(confirmed.status).toBe(200);
    const text = lastText(confirmed.transport);
    expect(text).toContain("placed");
    expect(text).toContain("awaiting collection");
    expect(text).toContain("Total: 37.00 SAR");

    const reference = /Order (ORD-[A-HJ-NP-Z2-9]{6}) placed/.exec(text)?.[1];
    expect(reference).toBeDefined();

    const orders = await db().select().from(order);
    expect(orders).toHaveLength(1);
    expect(orders[0].reference).toBe(reference);
    expect(orders[0].paymentStatus).toBe("awaiting_collection");

    const reservations = await db().select().from(inventoryReservation);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(2);

    const [inventory] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productAId));
    expect(inventory.reserved).toBe(2);
    expect(inventory.onHand).toBe(5);

    // A second tap is a separate Telegram update. It must return the same
    // reference and must not reserve stock again.
    const duplicate = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );
    expect(duplicate.status).toBe(200);
    expect(lastText(duplicate.transport)).toContain(`Order ${reference} placed`);

    expect(await db().select().from(order)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);

    const [after] = await db()
      .select()
      .from(productInventory)
      .where(eq(productInventory.productId, fixture.productAId));
    expect(after.reserved).toBe(2);

    const [cartRow] = await db()
      .select()
      .from(cart)
      .where(eq(cart.id, cartId));
    expect(cartRow.status).toBe("converted");
  });

  it("returns a revised review instead of placing an order when the quote changed", async () => {
    const { confirmData } = await completeReview();

    await db()
      .update(product)
      .set({ price: "13.50" })
      .where(eq(product.id, fixture.productAId));
    await db()
      .update(storeCommerceSetting)
      .set({ deliveryFee: "17.00" })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const stale = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );

    expect(stale.status).toBe(200);
    const revised = lastText(stale.transport);
    expect(revised).toContain("Review your order");
    expect(revised).toContain("Subtotal: 27.00 SAR");
    expect(revised).toContain("Delivery fee: 17.00 SAR");
    expect(revised).toContain("Total: 44.00 SAR");
    expect(await db().select().from(order)).toHaveLength(0);
    expect(await db().select().from(inventoryReservation)).toHaveLength(0);

    const confirm = inlineButtons(
      stale.transport.editedMessages.at(-1)!,
    ).find((button) => button.callback_data?.startsWith("cc:"));
    expect(confirm?.callback_data).toBeDefined();
    expect(confirm!.callback_data).not.toBe(confirmData);

    const placed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirm!.callback_data!),
    );
    expect(placed.status).toBe(200);
    expect(lastText(placed.transport)).toContain("placed");
    expect(lastText(placed.transport)).toContain("Total: 44.00 SAR");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("does not let another buyer in the same store confirm the cart", async () => {
    const { confirmData } = await completeReview();

    const foreign = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_B, confirmData),
    );
    expect(foreign.status).toBe(200);
    expect(lastText(foreign.transport)).toContain("This cart is not available");
    expect(await db().select().from(order)).toHaveLength(0);

    const own = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );
    expect(own.status).toBe(200);
    expect(lastText(own.transport)).toContain("placed");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("does not let the other store confirm or order the cart", async () => {
    const { confirmData } = await completeReview();

    const foreign = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_B, confirmData),
      "bot-secret-b",
    );
    expect(foreign.status).toBe(200);
    expect(lastText(foreign.transport)).toContain("This cart is not available");
    expect(await db().select().from(order)).toHaveLength(0);

    const foreignProduct = await call(
      fixture.connectionBId,
      callbackUpdate(BUYER_B, `ca:${fixture.productAId}:1`),
      "bot-secret-b",
    );
    expect(foreignProduct.status).toBe(200);
    expect(lastText(foreignProduct.transport)).toContain(
      "not available in this store",
    );

    const own = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirmData),
    );
    expect(own.status).toBe(200);
    expect(lastText(own.transport)).toContain("placed");
    expect(await db().select().from(order)).toHaveLength(1);
  });

  it("localizes the Arabic COD flow and normalizes Arabic-Indic phone digits", async () => {
    const start = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "/start", {}, "ar"),
    );
    expect(start.status).toBe(200);
    expect(
      inlineButtons(start.transport.sentMessages.at(-1)!).some(
        (button) => button.text === "السلة",
      ),
    ).toBe(true);

    const product = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `p:${fixture.productAId}`, "ar"),
    );
    expect(product.status).toBe(200);
    expect(
      inlineButtons(product.transport.editedMessages.at(-1)!).some(
        (button) => button.text === "أضف 1",
      ),
    ).toBe(true);

    const added = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `ca:${fixture.productAId}:2`, "ar"),
    );
    expect(added.status).toBe(200);
    expect(lastText(added.transport)).toContain("السلة");
    expect(lastText(added.transport)).toContain("المجموع الفرعي: 22.00 SAR");
    expect(lastText(added.transport)).toContain("رسوم التوصيل: 15.00 SAR");
    expect(lastText(added.transport)).toContain("الإجمالي: 37.00 SAR");
    expect(lastText(added.transport)).toContain("الدفع عند الاستلام");
    const checkoutButton = lastButton(added.transport, "co:");
    expect(checkoutButton?.text).toBe("إتمام الطلب");

    const checkout = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, checkoutButton!.callback_data!, "ar"),
    );
    expect(checkout.status).toBe(200);
    const phonePrompt = checkout.transport.sentMessages.at(-1)!;
    expect(phonePrompt.text).toContain("إتمام الطلب");
    expect(phonePrompt.text).toContain("مشاركة الهاتف");
    expect(
      (phonePrompt.replyMarkup as { keyboard?: Array<Array<{ text: string }>> })
        ?.keyboard?.[0]?.[0]?.text,
    ).toBe("مشاركة الهاتف");

    // Typed fallback with Arabic-Indic digits. The stored value is normalized.
    const phone = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "+٩٦٦ ٥٥٥ ١٢٣ ٤٥٦", {}, "ar"),
    );
    expect(phone.status).toBe(200);
    expect(
      phone.transport.sentMessages.some((message) =>
        message.text.includes("عنوان التوصيل"),
      ),
    ).toBe(true);

    const reviewed = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "١٢٣ شارع الاختبار الاصطناعي", {}, "ar"),
    );
    expect(reviewed.status).toBe(200);
    const reviewMessage = reviewed.transport.sentMessages.at(-1);
    expect(reviewMessage?.text).toContain("راجع طلبك");
    expect(reviewMessage?.text).toContain("المجموع الفرعي: 22.00 SAR");
    expect(reviewMessage?.text).toContain("الدفع عند الاستلام");
    expect(reviewMessage?.text).toContain("+966555123456");
    const confirm = inlineButtons(reviewMessage!).find((button) =>
      button.callback_data?.startsWith("cc:"),
    );
    expect(confirm?.text).toBe("تأكيد الطلب — الدفع عند الاستلام");

    const confirmed = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, confirm!.callback_data!, "ar"),
    );
    expect(confirmed.status).toBe(200);
    expect(lastText(confirmed.transport)).toContain("تم تسجيل الطلب");
    expect(lastText(confirmed.transport)).toContain("بانتظار التحصيل");

    const [orderRow] = await db().select().from(order);
    expect(orderRow.customerPhone).toBe("+966555123456");
    expect(orderRow.deliveryAddress).toBe("١٢٣ شارع الاختبار الاصطناعي");
    expect(orderRow.paymentStatus).toBe("awaiting_collection");
  });

  it("re-asks for a valid address and refuses confirmation before checkout is complete", async () => {
    const { cartId } = await addAndCheckout();

    const phone = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "+15551234567"),
    );
    expect(phone.status).toBe(200);

    const forged = await call(
      fixture.connectionAId,
      callbackUpdate(BUYER_A, `cc:${cartId}:1`),
    );
    expect(forged.status).toBe(200);
    expect(await db().select().from(order)).toHaveLength(0);

    const invalid = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "no"),
    );
    expect(invalid.status).toBe(200);
    expect(
      invalid.transport.sentMessages.some((message) =>
        message.text.includes("That address is invalid"),
      ),
    ).toBe(true);
    expect(await db().select().from(order)).toHaveLength(0);

    const valid = await call(
      fixture.connectionAId,
      messageUpdate(BUYER_A, "123 Synthetic Telegram Street"),
    );
    expect(valid.status).toBe(200);
    expect(
      valid.transport.sentMessages.some((message) =>
        message.text.includes("Review your order"),
      ),
    ).toBe(true);
    expect(await db().select().from(order)).toHaveLength(0);
  });
});
