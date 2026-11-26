import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  appUser,
  category,
  categoryTranslation,
  inventoryReservation,
  language,
  order,
  orderPaymentClaim,
  product,
  productInventory,
  productTranslation,
  store,
  storeCommerceSetting,
  storeLanguageSetting,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import { rejectVodafoneCashTransfer, verifyVodafoneCashTransfer } from "@/lib/commerce/orders";
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
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let updateId = 9000;

type Fixture = {
  storeId: string;
  ownerId: string;
  productId: string;
  connectionId: string;
};

let fixture: Fixture;

const BUYER_A = 94001;
const BUYER_B = 94002;
const BUYER_C = 94003;
const SECRET = "vodafone-telegram-secret";

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.RABET_COD_ORDERS_ENABLED = "true";
  process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";

  testDb = await createTestDatabase("vodafone_telegram");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();

  const [storeRow] = await db
    .insert(store)
    .values({ name: "Vodafone Bot Store", slug: "vodafone-bot-store", status: "active" })
    .returning();

  const [owner] = await db
    .insert(appUser)
    .values({ email: "vodafone.bot.owner@example.test" })
    .returning();

  await db.insert(storeMembership).values({
    storeId: storeRow.id,
    userId: owner.id,
    role: "owner",
    status: "active",
  });

  const [categoryRow] = await db
    .insert(category)
    .values({
      storeId: storeRow.id,
      slug: "vodafone-bot-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values({
    categoryId: categoryRow.id,
    languageId: english.id,
    name: "Root",
  });

  const [productRow] = await db
    .insert(product)
    .values({
      storeId: storeRow.id,
      categoryId: categoryRow.id,
      slug: "vodafone-bot-product",
      price: "11.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values({
    productId: productRow.id,
    languageId: english.id,
    name: "Bot A One",
    description: "Synthetic product",
  });

  await db.insert(productInventory).values({
    productId: productRow.id,
    storeId: storeRow.id,
    onHand: 20,
    reserved: 0,
  });

  const [connection] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeRow.id,
      botId: 894001,
      botUsername: "VodafoneBotStore",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: hashWebhookSecret(SECRET),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/vf-bot",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  await db.insert(storeCommerceSetting).values({
    storeId: storeRow.id,
    currency: "SAR",
    deliveryFee: "15.00",
    codEnabled: true,
    vodafoneCashEnabled: true,
    vodafoneCashNumber: "+201000000001",
    vodafoneCashAccountName: "Synthetic Merchant A",
    vodafoneCashInstructionsAr: "حوّل المبلغ ثم أرسل المرجع.",
    vodafoneCashInstructionsEn: "Transfer the exact amount, then submit the reference.",
  });

  fixture = {
    storeId: storeRow.id,
    ownerId: owner.id,
    productId: productRow.id,
    connectionId: connection.id,
  };
});

afterAll(async () => {
  delete process.env.RABET_COD_ORDERS_ENABLED;
  delete process.env.RABET_MANUAL_TRANSFER_ENABLED;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  process.env.RABET_COD_ORDERS_ENABLED = "true";
  process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";

  await testDb.db.execute(sql`
    truncate table
      "order_payment_claim",
      "inventory_reservation",
      "order_item",
      "order",
      "cart_item",
      "cart"
    restart identity cascade
  `);

  await testDb.db.execute(sql`update "product_inventory" set on_hand = 20, reserved = 0`);
  await testDb.db
    .update(store)
    .set({ status: "active" })
    .where(eq(store.id, fixture.storeId));
  await testDb.db
    .insert(storeLanguageSetting)
    .values({ storeId: fixture.storeId, locale: "en" })
    .onConflictDoUpdate({
      target: storeLanguageSetting.storeId,
      set: { locale: "en", updatedAt: new Date() },
    });

  await testDb.db
    .update(storeCommerceSetting)
    .set({
      codEnabled: true,
      vodafoneCashEnabled: true,
      vodafoneCashNumber: "+201000000001",
      vodafoneCashAccountName: "Synthetic Merchant A",
      vodafoneCashInstructionsEn:
        "Transfer the exact amount, then submit the reference.",
    })
    .where(eq(storeCommerceSetting.storeId, fixture.storeId));
});

function db() {
  return testDb!.db;
}

function tx(): TransactionDatabase {
  return testDb!.db as unknown as TransactionDatabase;
}

async function scope() {
  return readStoreScopeForFixture(db(), fixture.storeId);
}

function nextUpdateId() {
  updateId += 1;
  return updateId;
}

function webhookRequest(body: unknown): Request {
  return new Request("https://app.example.test/api/telegram/webhook/managed/vf-bot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify(body),
  });
}

function messageUpdate(
  buyerId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      chat: { id: buyerId, type: "private" },
      date: 1,
      text,
      ...extra,
    },
  };
}

function contactUpdate(buyerId: number, phone: string) {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextUpdateId(),
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      chat: { id: buyerId, type: "private" },
      date: 1,
      contact: { phone_number: phone, first_name: "Buyer", user_id: buyerId },
    },
  };
}

function callbackUpdate(buyerId: number, data: string, messageId?: number) {
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `callback-${nextUpdateId()}`,
      from: { id: buyerId, is_bot: false, first_name: "Buyer" },
      message: {
        message_id: messageId ?? 7000 + updateId,
        chat: { id: buyerId, type: "private" },
        date: 1,
      },
      data,
    },
  };
}

async function call(
  body: unknown,
  transport: FakeTelegramTransport = createFakeTelegramTransport(),
) {
  const response = await handleManagedTelegramWebhookRequest(
    webhookRequest(body),
    fixture.connectionId,
    {
      db: asAppDb(db()),
      commerceDb: tx(),
      transport,
    },
  );

  return { status: response.status, transport };
}

function inlineButtons(message: { replyMarkup?: unknown }) {
  const markup = message.replyMarkup as
    | {
        inline_keyboard?: Array<
          Array<{ text: string; callback_data?: string; url?: string }>
        >;
      }
    | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}

function lastButton(transport: FakeTelegramTransport, prefix: string) {
  const messages = [...transport.sentMessages, ...transport.editedMessages];
  for (const message of messages.slice().reverse()) {
    const button = inlineButtons(message).find((entry) =>
      entry.callback_data?.startsWith(prefix),
    );
    if (button) return button;
  }
  return undefined;
}

function lastMessageButtons(transport: FakeTelegramTransport) {
  const message =
    transport.editedMessages.at(-1) ?? transport.sentMessages.at(-1);
  return message ? inlineButtons(message) : [];
}

function lastSentButtons(transport: FakeTelegramTransport) {
  const message = transport.sentMessages.at(-1);
  return message ? inlineButtons(message) : [];
}

function lastText(transport: FakeTelegramTransport) {
  return (
    transport.editedMessages.at(-1)?.text ??
    transport.sentMessages.at(-1)?.text ??
    ""
  );
}

function lastSentText(transport: FakeTelegramTransport) {
  return transport.sentMessages.at(-1)?.text ?? "";
}

async function reviewCart(
  buyerId: number,
  transport = createFakeTelegramTransport(),
) {
  const start = await call(messageUpdate(buyerId, "/start"), transport);
  expect(start.status).toBe(200);

  const product = await call(
    callbackUpdate(buyerId, `p:${fixture.productId}`),
    transport,
  );
  expect(product.status).toBe(200);

  const added = await call(
    callbackUpdate(buyerId, `ca:${fixture.productId}:1`),
    transport,
  );
  expect(added.status).toBe(200);

  const checkoutButton = lastButton(added.transport, "co:");
  expect(checkoutButton?.callback_data).toBeDefined();

  const checkout = await call(
    callbackUpdate(buyerId, checkoutButton!.callback_data!),
    transport,
  );
  expect(checkout.status).toBe(200);

  const phone = await call(contactUpdate(buyerId, "+15551234567"), transport);
  expect(phone.status).toBe(200);

  const reviewed = await call(
    messageUpdate(buyerId, "123 Synthetic Telegram Street"),
    transport,
  );
  expect(reviewed.status).toBe(200);

  const reviewMessage = reviewed.transport.sentMessages.at(-1);
  const vodafoneButton = inlineButtons(reviewMessage!).find((button) =>
    button.callback_data?.startsWith("cv:"),
  );

  return {
    transport: reviewed.transport,
    reviewMessage,
    vodafoneButton,
    cartId: checkoutButton!.callback_data!.slice(3),
  };
}

async function placeVodafoneOrder(
  buyerId: number,
  transport = createFakeTelegramTransport(),
) {
  const reviewed = await reviewCart(buyerId, transport);
  expect(reviewed.vodafoneButton?.callback_data).toBeDefined();

  const placed = await call(
    callbackUpdate(buyerId, reviewed.vodafoneButton!.callback_data!),
    reviewed.transport,
  );
  expect(placed.status).toBe(200);

  const instructions = lastText(placed.transport);
  const instructionsMessageId =
    placed.transport.editedMessages.at(-1)?.messageId ?? null;
  expect(instructionsMessageId).toBeGreaterThan(0);

  const referenceButton = lastButton(placed.transport, "tr:");
  expect(referenceButton?.callback_data).toBeDefined();
  const orderId = referenceButton!.callback_data!.slice(3);

  const prompt = await call(
    callbackUpdate(buyerId, referenceButton!.callback_data!),
    placed.transport,
  );
  expect(prompt.status).toBe(200);

  const promptMessage = prompt.transport.sentMessages.at(-1);
  expect(promptMessage?.replyMarkup).toMatchObject({ force_reply: true });
  expect(promptMessage?.messageId).toBeGreaterThan(0);

  return {
    orderId,
    cartId: reviewed.cartId,
    promptMessageId: promptMessage!.messageId,
    transport: prompt.transport,
    instructions,
    instructionsMessageId: instructionsMessageId!,
  };
}

async function placeVodafoneOrderWithoutPrompt(
  buyerId: number,
  transport = createFakeTelegramTransport(),
) {
  const reviewed = await reviewCart(buyerId, transport);
  expect(reviewed.vodafoneButton?.callback_data).toBeDefined();

  const placed = await call(
    callbackUpdate(buyerId, reviewed.vodafoneButton!.callback_data!),
    reviewed.transport,
  );
  expect(placed.status).toBe(200);

  const instructions = lastText(placed.transport);
  const instructionsMessageId =
    placed.transport.editedMessages.at(-1)?.messageId ?? null;
  expect(instructionsMessageId).toBeGreaterThan(0);
  const referenceButton = lastButton(placed.transport, "tr:");
  expect(referenceButton?.callback_data).toBeDefined();

  return {
    orderId: referenceButton!.callback_data!.slice(3),
    instructions,
    instructionsMessageId: instructionsMessageId!,
    transport: placed.transport,
  };
}

async function replyToPrompt(
  buyerId: number,
  promptMessageId: number,
  reference: string,
  transport: FakeTelegramTransport,
) {
  return call(
    messageUpdate(buyerId, reference, {
      reply_to_message: {
        message_id: promptMessageId,
        chat: { id: buyerId, type: "private" },
      },
    }),
    transport,
  );
}

async function orderByReference(reference: string) {
  const [row] = await db()
    .select()
    .from(order)
    .where(eq(order.reference, reference));
  return row;
}

async function claimFor(orderId: string) {
  const [row] = await db()
    .select()
    .from(orderPaymentClaim)
    .where(eq(orderPaymentClaim.orderId, orderId));
  return row;
}

describe.skipIf(!shouldRun)("Vodafone Cash managed Telegram journey", () => {
  it("uses the placement snapshot for replays and still services an existing order after disablement", async () => {
    const first = await placeVodafoneOrder(BUYER_A);
    expect(first.instructions).toContain("+201000000001");
    expect(first.instructions).toContain("Synthetic Merchant A");
    expect(first.instructions).toContain(
      "Tap “I have transferred — submit reference” below, then reply to the next message with the reference from your receipt.",
    );

    const firstOrder = await orderByReference(
      first.instructions.match(/ORD-[A-Z2-9]{6}/)![0],
    );
    expect(firstOrder.transferSnapshot).toMatchObject({
      number: "+201000000001",
      accountName: "Synthetic Merchant A",
    });

    await db()
      .update(storeCommerceSetting)
      .set({
        vodafoneCashNumber: "+201999999999",
        vodafoneCashAccountName: "Changed Merchant",
        vodafoneCashInstructionsEn: "Changed instructions",
      })
      .where(eq(storeCommerceSetting.storeId, fixture.storeId));

    const replay = await call(
      callbackUpdate(BUYER_A, `cv:${first.cartId}:1`),
      first.transport,
    );
    const replayText = lastText(replay.transport);
    expect(replayText).toContain("+201000000001");
    expect(replayText).not.toContain("+201999999999");

    const second = await placeVodafoneOrder(BUYER_B);
    expect(second.instructions).toContain("+201999999999");
    expect(second.instructions).toContain("Changed Merchant");

    await db()
      .update(storeCommerceSetting)
      .set({
        vodafoneCashNumber: "+201888888888",
        vodafoneCashAccountName: "Newest Merchant",
        vodafoneCashInstructionsEn: "Newest instructions",
      })
      .where(eq(storeCommerceSetting.storeId, fixture.storeId));

    const secondReplay = await call(
      callbackUpdate(BUYER_B, `cv:${second.cartId}:1`),
      second.transport,
    );
    const secondReplayText = lastText(secondReplay.transport);
    expect(secondReplayText).toContain("+201999999999");
    expect(secondReplayText).toContain("Changed Merchant");
    expect(secondReplayText).not.toContain("+201888888888");

    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeId));

    const buyerCReview = await reviewCart(BUYER_C);
    expect(buyerCReview.vodafoneButton).toBeUndefined();

    const storeDisabledReply = await replyToPrompt(
      BUYER_A,
      first.promptMessageId,
      "STORE-OFF-REF",
      first.transport,
    );
    expect(storeDisabledReply.status).toBe(200);
    expect(lastSentText(storeDisabledReply.transport)).toContain(
      "Awaiting merchant verification",
    );
    expect(await claimFor(first.orderId)).toMatchObject({
      reference: "STORE-OFF-REF",
      status: "pending",
    });

    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: true })
      .where(eq(storeCommerceSetting.storeId, fixture.storeId));

    delete process.env.RABET_MANUAL_TRANSFER_ENABLED;
    const buyerDReview = await reviewCart(94004);
    expect(buyerDReview.vodafoneButton).toBeUndefined();

    delete process.env.RABET_COD_ORDERS_ENABLED;

    const deploymentDisabledReply = await replyToPrompt(
      BUYER_B,
      second.promptMessageId,
      "DEPLOYMENT-OFF-REF",
      second.transport,
    );
    expect(deploymentDisabledReply.status).toBe(200);
    expect(lastSentText(deploymentDisabledReply.transport)).toContain(
      "Awaiting merchant verification",
    );
    expect(await claimFor(second.orderId)).toMatchObject({
      reference: "DEPLOYMENT-OFF-REF",
      status: "pending",
    });

    process.env.RABET_COD_ORDERS_ENABLED = "true";
    process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";
  });

  it("shows the system guidance in Arabic instructions", async () => {
    await db()
      .insert(storeLanguageSetting)
      .values({ storeId: fixture.storeId, locale: "ar" })
      .onConflictDoUpdate({
        target: storeLanguageSetting.storeId,
        set: { locale: "ar", updatedAt: new Date() },
      });

    const placed = await placeVodafoneOrder(BUYER_A);
    expect(placed.instructions).toContain("تحويل فودافون كاش");
    expect(placed.instructions).toContain(
      "اضغط «لقد حوّلت — إرسال المرجع» بالأسفل، ثم أرسل ردًا على الرسالة التالية يحتوي المرجع الموجود في الإيصال.",
    );
    const referenceButton = lastButton(placed.transport, "tr:");
    expect(referenceButton?.text).toBe("لقد حوّلت — إرسال المرجع");
  });

  it("does not turn a reply to the instructions message into a claim", async () => {
    const placed = await placeVodafoneOrderWithoutPrompt(BUYER_A);

    const instructionsReply = await call(
      messageUpdate(BUYER_A, "INSTRUCTIONS-REPLY-REF", {
        reply_to_message: {
          message_id: placed.instructionsMessageId,
          chat: { id: BUYER_A, type: "private" },
        },
      }),
      placed.transport,
    );

    expect(instructionsReply.status).toBe(200);
    expect(lastSentText(instructionsReply.transport)).toContain(
      "Welcome to Vodafone Bot Store.",
    );
    expect(await claimFor(placed.orderId)).toBeUndefined();
    const orderRow = await orderByReference(
      placed.instructions.match(/ORD-[A-Z2-9]{6}/)![0],
    );
    expect(orderRow.paymentStatus).toBe("awaiting_transfer");
    expect(orderRow.status).toBe("placed");
  });

  it("keeps the same Vodafone order across EN -> AR -> EN language switches", async () => {
    const placed = await placeVodafoneOrder(BUYER_A);
    const reference = placed.instructions.match(/ORD-[A-Z2-9]{6}/)![0];

    const languageButton = lastMessageButtons(placed.transport).find((button) =>
      button.callback_data?.startsWith("langs:to:"),
    );
    expect(languageButton?.callback_data).toBeDefined();

    const menu = await call(
      callbackUpdate(
        BUYER_A,
        languageButton!.callback_data!,
        placed.instructionsMessageId,
      ),
      placed.transport,
    );
    const arabicButton = lastMessageButtons(menu.transport).find((button) =>
      button.callback_data?.startsWith("lang:ar:to:"),
    );
    expect(arabicButton?.callback_data).toBeDefined();

    const arabic = await call(
      callbackUpdate(
        BUYER_A,
        arabicButton!.callback_data!,
        placed.instructionsMessageId,
      ),
      menu.transport,
    );
    expect(lastText(arabic.transport)).toContain("تحويل فودافون كاش");
    expect(lastText(arabic.transport)).toContain(reference);
    expect(lastText(arabic.transport)).toContain(
      "اضغط «لقد حوّلت — إرسال المرجع» بالأسفل، ثم أرسل ردًا على الرسالة التالية يحتوي المرجع الموجود في الإيصال.",
    );
    expect(
      lastMessageButtons(arabic.transport).some(
        (button) => button.callback_data === `tr:${placed.orderId}`,
      ),
    ).toBe(true);

    const arabicLanguageButton = lastMessageButtons(arabic.transport).find(
      (button) => button.callback_data?.startsWith("langs:to:"),
    );
    expect(arabicLanguageButton?.callback_data).toBeDefined();
    const secondMenu = await call(
      callbackUpdate(
        BUYER_A,
        arabicLanguageButton!.callback_data!,
        placed.instructionsMessageId,
      ),
      arabic.transport,
    );
    const englishButton = lastMessageButtons(secondMenu.transport).find(
      (button) => button.callback_data?.startsWith("lang:en:to:"),
    );
    expect(englishButton?.callback_data).toBeDefined();

    const english = await call(
      callbackUpdate(
        BUYER_A,
        englishButton!.callback_data!,
        placed.instructionsMessageId,
      ),
      secondMenu.transport,
    );
    expect(lastText(english.transport)).toContain(reference);
    expect(lastText(english.transport)).toContain(
      "Tap “I have transferred — submit reference” below, then reply to the next message with the reference from your receipt.",
    );
    expect(
      lastMessageButtons(english.transport).some(
        (button) => button.callback_data === `tr:${placed.orderId}`,
      ),
    ).toBe(true);
    expect(await claimFor(placed.orderId)).toBeUndefined();
  });

  it("recovers the order after Home/Cart overwrites the instructions and selects between two pending orders", async () => {
    const first = await placeVodafoneOrder(BUYER_A);
    const second = await placeVodafoneOrder(BUYER_A, first.transport);
    const firstReference = first.instructions.match(/ORD-[A-Z2-9]{6}/)![0];
    const secondReference = second.instructions.match(/ORD-[A-Z2-9]{6}/)![0];

    // Cart then Home overwrites the only instructions message.
    const cartButton = lastMessageButtons(second.transport).find(
      (button) => button.callback_data === "cart",
    );
    expect(cartButton?.callback_data).toBeDefined();
    const cart = await call(
      callbackUpdate(BUYER_A, "cart", second.instructionsMessageId),
      second.transport,
    );
    const homeButton = lastMessageButtons(cart.transport).find(
      (button) =>
        button.callback_data === "home" || button.callback_data === "home:new",
    );
    expect(homeButton?.callback_data).toBeDefined();
    const home = await call(
      callbackUpdate(
        BUYER_A,
        homeButton!.callback_data!,
        second.instructionsMessageId,
      ),
      cart.transport,
    );

    const recoveryButton = lastMessageButtons(home.transport).find(
      (button) => button.callback_data === "tfl",
    );
    expect(recoveryButton?.callback_data).toBeDefined();

    const list = await call(
      callbackUpdate(
        BUYER_A,
        recoveryButton!.callback_data!,
        second.instructionsMessageId,
      ),
      home.transport,
    );
    const listedButtons = lastMessageButtons(list.transport);
    expect(listedButtons.some((button) => button.text.includes(firstReference))).toBe(
      true,
    );
    expect(
      listedButtons.some((button) => button.text.includes(secondReference)),
    ).toBe(true);

    const firstOrderButton = lastMessageButtons(list.transport).find(
      (button) => button.callback_data === `tfo:${first.orderId}`,
    );
    expect(firstOrderButton?.callback_data).toBeDefined();
    const reopened = await call(
      callbackUpdate(
        BUYER_A,
        firstOrderButton!.callback_data!,
        second.instructionsMessageId,
      ),
      list.transport,
    );
    expect(lastText(reopened.transport)).toContain(firstReference);
    expect(lastText(reopened.transport)).not.toContain(secondReference);
    expect(
      lastMessageButtons(reopened.transport).some(
        (button) => button.callback_data === `tr:${first.orderId}`,
      ),
    ).toBe(true);

    // Submitted and verified states never reopen as a new transfer prompt.
    const claim = await replyToPrompt(
      BUYER_A,
      first.promptMessageId,
      "RECOVERY-CLAIM-REF",
      reopened.transport,
    );
    expect(lastSentText(claim.transport)).toContain(
      "Awaiting merchant verification",
    );
    const submitted = await call(
      callbackUpdate(
        BUYER_A,
        `tfo:${first.orderId}`,
        second.instructionsMessageId,
      ),
      claim.transport,
    );
    expect(lastText(submitted.transport)).toContain("Transfer reference received");
    expect(lastText(submitted.transport)).not.toContain(
      "Tap “I have transferred",
    );

    const storeScope = await scope();
    await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: first.orderId,
      actorUserId: fixture.ownerId,
    });
    const verified = await call(
      callbackUpdate(
        BUYER_A,
        `tfo:${first.orderId}`,
        second.instructionsMessageId,
      ),
      submitted.transport,
    );
    expect(lastText(verified.transport)).toContain("Transfer verified");
    expect(lastText(verified.transport)).not.toContain(
      "Tap “I have transferred",
    );

    // /start still surfaces the remaining outstanding order.
    const start = await call(messageUpdate(BUYER_A, "/start"), verified.transport);
    expect(
      lastSentButtons(start.transport).some(
        (button) => button.callback_data === "tfl",
      ),
    ).toBe(true);
  });

  it("keeps recovery scoped to the authorized buyer and chat", async () => {
    const placed = await placeVodafoneOrder(BUYER_A);
    const buyerBStart = await call(
      messageUpdate(BUYER_B, "/start"),
      placed.transport,
    );
    expect(
      lastSentButtons(buyerBStart.transport).some(
        (button) => button.callback_data === "tfl",
      ),
    ).toBe(false);

    const foreign = await call(
      callbackUpdate(BUYER_B, `tfo:${placed.orderId}`),
      placed.transport,
    );
    expect(lastText(foreign.transport)).toContain("This cart is not available.");
    expect(
      lastMessageButtons(foreign.transport).some((button) =>
        button.callback_data?.startsWith("tr:"),
      ),
    ).toBe(false);
    expect(await claimFor(placed.orderId)).toBeUndefined();
    expect(
      (
        await orderByReference(
          placed.instructions.match(/ORD-[A-Z2-9]{6}/)![0],
        )
      ).paymentStatus,
    ).toBe("awaiting_transfer");
  });

  it("keeps recovery available when new Vodafone checkouts are disabled", async () => {
    const placed = await placeVodafoneOrder(BUYER_A);
    const reference = placed.instructions.match(/ORD-[A-Z2-9]{6}/)![0];

    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeId));

    const start = await call(messageUpdate(BUYER_A, "/start"), placed.transport);
    const recoveryButton = lastSentButtons(start.transport).find(
      (button) => button.callback_data === "tfl",
    );
    expect(recoveryButton?.callback_data).toBeDefined();

    const list = await call(
      callbackUpdate(BUYER_A, recoveryButton!.callback_data!),
      start.transport,
    );
    expect(
      lastMessageButtons(list.transport).some((button) =>
        button.text.includes(reference),
      ),
    ).toBe(true);
    const orderButton = lastMessageButtons(list.transport).find(
      (button) => button.callback_data === `tfo:${placed.orderId}`,
    );
    expect(orderButton?.callback_data).toBeDefined();
    const reopened = await call(
      callbackUpdate(BUYER_A, orderButton!.callback_data!),
      list.transport,
    );
    expect(lastText(reopened.transport)).toContain(reference);
    expect(
      lastMessageButtons(reopened.transport).some(
        (button) => button.callback_data === `tr:${placed.orderId}`,
      ),
    ).toBe(true);
  });

  it("routes out-of-order replies to the exact order and keeps stale prompts state-aware", async () => {
    const first = await placeVodafoneOrder(BUYER_A);
    const second = await placeVodafoneOrder(BUYER_A, first.transport);

    const secondReply = await replyToPrompt(
      BUYER_A,
      second.promptMessageId,
      "SECOND-ORDER-REF",
      second.transport,
    );
    expect(lastSentText(secondReply.transport)).toContain(
      "Awaiting merchant verification",
    );

    const firstReply = await replyToPrompt(
      BUYER_A,
      first.promptMessageId,
      "FIRST-ORDER-REF",
      first.transport,
    );
    expect(lastSentText(firstReply.transport)).toContain(
      "Awaiting merchant verification",
    );

    expect(await claimFor(first.orderId)).toMatchObject({
      reference: "FIRST-ORDER-REF",
    });
    expect(await claimFor(second.orderId)).toMatchObject({
      reference: "SECOND-ORDER-REF",
    });

    const repeated = await replyToPrompt(
      BUYER_A,
      first.promptMessageId,
      "FIRST-ORDER-REF",
      first.transport,
    );
    expect(lastSentText(repeated.transport)).toContain(
      "Awaiting merchant verification",
    );
    expect(await claimFor(first.orderId)).toMatchObject({
      reference: "FIRST-ORDER-REF",
    });
    expect(await claimFor(second.orderId)).toMatchObject({
      reference: "SECOND-ORDER-REF",
    });

    const foreign = await replyToPrompt(
      BUYER_B,
      first.promptMessageId,
      "FOREIGN-BUYER-REF",
      first.transport,
    );
    expect(foreign.status).toBe(200);
    expect(await claimFor(first.orderId)).toMatchObject({
      reference: "FIRST-ORDER-REF",
    });

    const storeScope = await scope();
    await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: second.orderId,
      actorUserId: fixture.ownerId,
    });

    const staleVerified = await call(
      callbackUpdate(BUYER_A, `tr:${second.orderId}`),
      second.transport,
    );
    expect(lastText(staleVerified.transport)).toContain("Transfer verified");
    expect(lastText(staleVerified.transport)).not.toContain(
      "Reply to this message",
    );

    await rejectVodafoneCashTransfer(tx(), storeScope, {
      orderId: first.orderId,
      actorUserId: fixture.ownerId,
    });

    const staleRejected = await call(
      callbackUpdate(BUYER_A, `tr:${first.orderId}`),
      first.transport,
    );
    expect(lastText(staleRejected.transport)).toContain("Transfer rejected");
    expect(lastText(staleRejected.transport)).not.toContain(
      "Reply to this message",
    );

    expect(await claimFor(first.orderId)).toMatchObject({ status: "rejected" });
    expect(await claimFor(second.orderId)).toMatchObject({ status: "approved" });
    expect(
      await db()
        .select()
        .from(inventoryReservation)
        .where(eq(inventoryReservation.orderId, first.orderId)),
    ).toMatchObject([{ status: "released" }]);
  });
});
