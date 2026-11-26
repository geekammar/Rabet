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
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  addToCart,
  acceptMerchantOrder,
  cancelMerchantOrder,
  collectMerchantOrderPayment,
  confirmCodOrder,
  confirmVodafoneCashOrder,
  handMerchantOrderToShipping,
  listBuyerOutstandingVodafoneTransfers,
  listMerchantOrders,
  markMerchantOrderDelivered,
  prepareMerchantOrder,
  bindVodafoneCashTransferPromptMessage,
  readCheckoutAvailability,
  readVodafoneCashOrderByPromptReply,
  readVodafoneCashOrderState,
  rejectVodafoneCashTransfer,
  requestVodafoneCashTransferReference,
  saveAddressAndPrepareReview,
  savePhone,
  startCheckout,
  submitVodafoneCashTransferClaim,
  verifyVodafoneCashTransfer,
} from "@/lib/commerce/orders";
import { isTransferAwaitingReview } from "@/lib/commerce/order-state";
import {
  readVodafoneCashSetting,
  saveMerchantVodafoneCash,
} from "@/lib/merchant/store-vodafone-cash";
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

type Fixture = {
  storeAId: string;
  storeBId: string;
  ownerAId: string;
  ownerBId: string;
  productAId: string;
  productBId: string;
  connectionAId: string;
  connectionBId: string;
  languageId: string;
};

let fixture: Fixture;

const BUYER_A = 92001;
const BUYER_B = 92002;
const VODAFONE_REFERENCE = "VC-2026-0001";

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("manual_vodafone_cash");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({ name: "Vodafone Store A", slug: "vodafone-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Vodafone Store B", slug: "vodafone-store-b", status: "active" })
    .returning();

  const [ownerA] = await db
    .insert(appUser)
    .values({ email: "vodafone.owner.a@example.test" })
    .returning();
  const [ownerB] = await db
    .insert(appUser)
    .values({ email: "vodafone.owner.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: ownerA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: ownerB.id, role: "owner", status: "active" },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "vodafone-store-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "vodafone-store-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "A Root" },
    { categoryId: categoryB.id, languageId: english.id, name: "B Root" },
  ]);

  const [productA] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "vodafone-a-one",
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
      slug: "vodafone-b-one",
      price: "30.00",
      isActive: true,
      sortOrder: nextOrder(),
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: productA.id,
      languageId: english.id,
      name: "A One",
      description: "First A product",
    },
    {
      productId: productB.id,
      languageId: english.id,
      name: "B One",
      description: "First B product",
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
      botId: 893001,
      botUsername: "VodafoneStoreABot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "f".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/vf-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();
  const [connectionB] = await db
    .insert(telegramConnection)
    .values({
      storeId: storeB.id,
      botId: 893002,
      botUsername: "VodafoneStoreBBot",
      tokenCiphertext: "synthetic-ciphertext",
      tokenKeyId: "v1",
      webhookSecretHash: "e".repeat(64),
      webhookUrl: "https://app.example.test/api/telegram/webhook/managed/vf-b",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  await db.insert(storeCommerceSetting).values([
    {
      storeId: storeA.id,
      currency: "SAR",
      deliveryFee: "15.00",
      codEnabled: true,
      vodafoneCashEnabled: true,
      vodafoneCashNumber: "+201000000001",
      vodafoneCashAccountName: "Synthetic Merchant A",
      vodafoneCashInstructionsAr: "حوّل المبلغ ثم أرسل المرجع.",
      vodafoneCashInstructionsEn: "Transfer the exact amount, then submit the reference.",
    },
    {
      storeId: storeB.id,
      currency: "USD",
      deliveryFee: "7.00",
      codEnabled: true,
      vodafoneCashEnabled: false,
    },
  ]);

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    ownerAId: ownerA.id,
    ownerBId: ownerB.id,
    productAId: productA.id,
    productBId: productB.id,
    connectionAId: connectionA.id,
    connectionBId: connectionB.id,
    languageId: english.id,
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

  await testDb.db.execute(sql`
    update "product_inventory"
    set on_hand = 5, reserved = 0
  `);

  await testDb.db
    .update(storeCommerceSetting)
    .set({
      codEnabled: true,
      vodafoneCashEnabled: true,
      vodafoneCashNumber: "+201000000001",
      vodafoneCashAccountName: "Synthetic Merchant A",
      vodafoneCashInstructionsAr: "حوّل المبلغ ثم أرسل المرجع.",
      vodafoneCashInstructionsEn:
        "Transfer the exact amount, then submit the reference.",
      deliveryFee: "15.00",
    })
    .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

  await testDb.db
    .update(storeCommerceSetting)
    .set({
      codEnabled: true,
      vodafoneCashEnabled: false,
      deliveryFee: "7.00",
    })
    .where(eq(storeCommerceSetting.storeId, fixture.storeBId));

  await testDb.db
    .update(store)
    .set({ status: "active" })
    .where(eq(store.id, fixture.storeAId));
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
    profileName: "Synthetic Buyer",
  });
  expect(started.status).toBe("ready");

  const phone = await savePhone(tx(), storeScope, {
    cartId: added.cart.id,
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    phone: "+15551234567",
  });
  expect(phone.status).toBe("saved");

  const reviewed = await saveAddressAndPrepareReview(tx(), storeScope, {
    cartId: added.cart.id,
    connectionId: input.connectionId,
    telegramUserId: input.buyerId,
    address: "123 Synthetic Test Street",
  });
  expect(reviewed.status).toBe("review");
  if (reviewed.status !== "review") throw new Error("review failed");

  return { scope: storeScope, cartId: added.cart.id, review: reviewed.review };
}

async function placeVodafoneOrder(input?: { quantity?: number; buyerId?: number }) {
  const prepared = await prepareReviewedOrder({
    storeId: fixture.storeAId,
    connectionId: fixture.connectionAId,
    buyerId: input?.buyerId ?? BUYER_A,
    productId: fixture.productAId,
    quantity: input?.quantity ?? 2,
  });

  const placed = await confirmVodafoneCashOrder(tx(), prepared.scope, {
    cartId: prepared.cartId,
    connectionId: fixture.connectionAId,
    telegramUserId: input?.buyerId ?? BUYER_A,
    telegramChatId: input?.buyerId ?? BUYER_A,
    expectedQuoteVersion: prepared.review.quoteVersion,
  });

  expect(placed.status).toBe("placed");
  if (placed.status !== "placed") throw new Error("order failed");

  return { ...prepared, placed };
}

let promptMessageSequence = 50000;

async function submitClaim(
  orderId: string,
  reference = VODAFONE_REFERENCE,
  options?: {
    buyerId?: number;
    telegramChatId?: number;
    promptMessageId?: number;
  },
) {
  const storeScope = await scope(fixture.storeAId);
  const buyerId = options?.buyerId ?? BUYER_A;
  const telegramChatId = options?.telegramChatId ?? buyerId;
  let promptMessageId = options?.promptMessageId;

  if (!promptMessageId) {
    const existing = await readVodafoneCashOrderState(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: buyerId,
      orderId,
    });
    promptMessageId = existing?.transferPromptMessageId ?? undefined;

    if (!promptMessageId) {
      const requested = await requestVodafoneCashTransferReference(
        tx(),
        storeScope,
        {
          connectionId: fixture.connectionAId,
          telegramUserId: buyerId,
          orderId,
        },
      );
      if (requested.status !== "prompted") {
        throw new Error(`Prompt failed: ${requested.status}`);
      }

      promptMessageId = ++promptMessageSequence;
      expect(
        await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
          connectionId: fixture.connectionAId,
          telegramUserId: buyerId,
          orderId,
          messageId: promptMessageId,
          promptToken: requested.promptToken,
        }),
      ).toBe(true);
    }
  }

  return submitVodafoneCashTransferClaim(tx(), storeScope, {
    connectionId: fixture.connectionAId,
    telegramUserId: buyerId,
    telegramChatId,
    orderId,
    promptMessageId,
    reference,
  });
}

async function inventoryFor(productId: string) {
  const [row] = await db()
    .select()
    .from(productInventory)
    .where(eq(productInventory.productId, productId));
  return row;
}

async function orderRow(orderId: string) {
  const [row] = await db().select().from(order).where(eq(order.id, orderId));
  return row;
}

async function claimRow(orderId: string) {
  const [row] = await db()
    .select()
    .from(orderPaymentClaim)
    .where(eq(orderPaymentClaim.orderId, orderId));
  return row;
}

function merchantAccess(storeId: string, userId: string, readOnly = false): MerchantAccess {
  return {
    userId,
    email: "synthetic.owner@example.test",
    sessionVersion: 0,
    role: "owner",
    store: {
      id: storeId,
      name: "Synthetic Store",
      slug: "synthetic-store",
      status: "active",
    },
    scope: {
      storeId,
    } as MerchantAccess["scope"],
    readOnly,
  };
}

describe.skipIf(!shouldRun)("manual Vodafone Cash transfers", () => {
  it("advertises the method only when deployment, store switch and configuration are present", async () => {
    const storeScope = await scope(fixture.storeAId);
    const enabled = await readCheckoutAvailability(tx(), storeScope);
    expect(enabled).toMatchObject({
      enabled: true,
      codEnabled: true,
      vodafoneCashEnabled: true,
    });
    expect(enabled.setting?.vodafoneCashInstructionsEn).toContain("Transfer");

    const storeBScope = await scope(fixture.storeBId);
    const storeB = await readCheckoutAvailability(tx(), storeBScope);
    expect(storeB.vodafoneCashEnabled).toBe(false);

    delete process.env.RABET_MANUAL_TRANSFER_ENABLED;
    const deploymentOff = await readCheckoutAvailability(tx(), storeScope);
    expect(deploymentOff.vodafoneCashEnabled).toBe(false);
    expect(deploymentOff.codEnabled).toBe(true);

    process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";
    const readOnlyAccess = merchantAccess(
      fixture.storeAId,
      fixture.ownerAId,
      true,
    );
    const denied = await saveMerchantVodafoneCash(tx(), readOnlyAccess, {
      enabled: true,
      number: "+201000000009",
      accountName: "Synthetic Merchant A",
      instructionsAr: "حوّل المبلغ.",
      instructionsEn: "Transfer the amount.",
    });
    expect(denied).toEqual({ ok: false, error: "DENIED" });
  });

  it("saves store-scoped merchant configuration and rejects incomplete enablement", async () => {
    const access = merchantAccess(fixture.storeAId, fixture.ownerAId);
    const saved = await saveMerchantVodafoneCash(tx(), access, {
      enabled: true,
      number: "+201000000002",
      accountName: "Updated Merchant",
      instructionsAr: "تعليمات محدثة",
      instructionsEn: "Updated instructions",
    });
    expect(saved).toMatchObject({
      ok: true,
      setting: {
        enabled: true,
        number: "+201000000002",
        accountName: "Updated Merchant",
      },
    });

    const stored = await readVodafoneCashSetting(db(), access.scope);
    expect(stored).toMatchObject({
      enabled: true,
      number: "+201000000002",
      instructionsEn: "Updated instructions",
    });

    const invalid = await saveMerchantVodafoneCash(tx(), access, {
      enabled: true,
      number: "",
      accountName: "Updated Merchant",
      instructionsAr: "تعليمات",
      instructionsEn: "",
    });
    expect(invalid).toEqual({ ok: false, error: "INVALID_CONFIG" });

    const mismatched = await saveMerchantVodafoneCash(
      tx(),
      merchantAccess(fixture.storeAId, fixture.ownerBId),
      {
        enabled: true,
        number: "+201000000002",
        accountName: "Updated Merchant",
        instructionsAr: "تعليمات",
        instructionsEn: "",
      },
    );
    expect(mismatched).toEqual({ ok: false, error: "DENIED" });
  });

  it("records a buyer claim idempotently without marking the order paid or changing stock", async () => {
    const { placed } = await placeVodafoneOrder();

    expect(placed.paymentMethod).toBe("vodafone_cash");
    const initialOrder = await orderRow(placed.orderId);
    expect(initialOrder).toMatchObject({
      paymentMethod: "vodafone_cash",
      paymentStatus: "awaiting_transfer",
    });
    expect(await claimRow(placed.orderId)).toBeUndefined();
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });

    const storeScope = await scope(fixture.storeAId);
    const requested = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(requested).toMatchObject({
      status: "prompted",
      orderId: placed.orderId,
      transferSnapshot: {
        number: "+201000000001",
        accountName: "Synthetic Merchant A",
      },
    });

    expect(
      await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
        messageId: 9001,
        promptToken: requested.promptToken,
      }),
    ).toBe(true);

    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9001,
      }),
    ).toMatchObject({
      orderId: placed.orderId,
      paymentStatus: "awaiting_transfer",
      transferPromptMessageId: 9001,
      transferSnapshot: {
        number: "+201000000001",
        accountName: "Synthetic Merchant A",
        instructionsEn: "Transfer the exact amount, then submit the reference.",
      },
    });

    const claim = await submitClaim(placed.orderId);
    expect(claim).toMatchObject({
      status: "submitted",
      claimStatus: "pending",
      paymentStatus: "transfer_awaiting_review",
    });

    const claimedOrder = await orderRow(placed.orderId);
    expect(claimedOrder.paymentStatus).toBe("transfer_awaiting_review");
    expect(isTransferAwaitingReview(claimedOrder.paymentStatus)).toBe(true);

    const storedClaim = await claimRow(placed.orderId);
    expect(storedClaim).toMatchObject({
      reference: VODAFONE_REFERENCE,
      status: "pending",
      decidedAt: null,
      decidedBy: null,
    });

    const retry = await submitClaim(placed.orderId);
    expect(retry.status).toBe("already_submitted");
    const claims = await db()
      .select()
      .from(orderPaymentClaim)
      .where(eq(orderPaymentClaim.orderId, placed.orderId));
    expect(claims).toHaveLength(1);
    expect((await orderRow(placed.orderId)).paymentStatus).toBe(
      "transfer_awaiting_review",
    );
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9001,
      }),
    ).toMatchObject({
      orderId: placed.orderId,
      paymentStatus: "transfer_awaiting_review",
      claim: { status: "pending", reference: VODAFONE_REFERENCE },
    });
  });

  it("snapshots transfer instructions at placement across settings changes and replays", async () => {
    const { placed, cartId, review, scope: storeScope } = await placeVodafoneOrder();

    expect(placed.transferSnapshot).toMatchObject({
      number: "+201000000001",
      accountName: "Synthetic Merchant A",
      instructionsEn: "Transfer the exact amount, then submit the reference.",
    });

    await db()
      .update(storeCommerceSetting)
      .set({
        vodafoneCashNumber: "+201999999999",
        vodafoneCashAccountName: "Changed Merchant",
        vodafoneCashInstructionsEn: "Changed instructions",
      })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const replay = await confirmVodafoneCashOrder(tx(), storeScope, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });

    expect(replay.status).toBe("already_placed");
    if (replay.status !== "already_placed") return;
    expect(replay.transferSnapshot).toMatchObject({
      number: "+201000000001",
      accountName: "Synthetic Merchant A",
      instructionsEn: "Transfer the exact amount, then submit the reference.",
    });

    const beforeClaim = await readVodafoneCashOrderState(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      orderId: placed.orderId,
    });
    expect(beforeClaim?.transferSnapshot).toMatchObject({
      number: "+201000000001",
      accountName: "Synthetic Merchant A",
    });

    const requested = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(requested.status).toBe("prompted");
    await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      orderId: placed.orderId,
      messageId: 9101,
      promptToken: requested.promptToken,
    });

    await submitClaim(placed.orderId, "SNAPSHOT-CLAIM-REF");

    const reviewed = await readVodafoneCashOrderByPromptReply(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9101,
      },
    );
    expect(reviewed).toMatchObject({
      paymentStatus: "transfer_awaiting_review",
      transferSnapshot: {
        number: "+201000000001",
        accountName: "Synthetic Merchant A",
      },
      claim: { status: "pending", reference: "SNAPSHOT-CLAIM-REF" },
    });

    await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });

    await db()
      .update(storeCommerceSetting)
      .set({
        vodafoneCashNumber: "+201888888888",
        vodafoneCashInstructionsEn: "Even newer instructions",
      })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const verified = await readVodafoneCashOrderByPromptReply(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9101,
      },
    );
    expect(verified).toMatchObject({
      paymentStatus: "transfer_verified",
      transferSnapshot: {
        number: "+201000000001",
        accountName: "Synthetic Merchant A",
        instructionsEn: "Transfer the exact amount, then submit the reference.",
      },
      claim: { status: "approved" },
    });
  });

  it("binds each prompt reply to its exact order and rejects ordinary or foreign contexts", async () => {
    const first = await placeVodafoneOrder({ quantity: 1 });
    const second = await placeVodafoneOrder({ quantity: 1 });
    const storeScope = await scope(fixture.storeAId);

    for (const [orderId, messageId] of [
      [first.placed.orderId, 9201],
      [second.placed.orderId, 9202],
    ] as const) {
      const requested = await requestVodafoneCashTransferReference(
        tx(),
        storeScope,
        {
          connectionId: fixture.connectionAId,
          telegramUserId: BUYER_A,
          orderId,
        },
      );
      expect(requested.status).toBe("prompted");
      if (requested.status !== "prompted") return;
      expect(
        await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
          connectionId: fixture.connectionAId,
          telegramUserId: BUYER_A,
          orderId,
          messageId,
          promptToken: requested.promptToken,
        }),
      ).toBe(true);
    }

    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9202,
      }),
    ).toMatchObject({ orderId: second.placed.orderId });
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9201,
      }),
    ).toMatchObject({ orderId: first.placed.orderId });

    const secondClaim = await submitVodafoneCashTransferClaim(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        orderId: second.placed.orderId,
        promptMessageId: 9202,
        reference: "SECOND-ORDER-REF",
      },
    );
    expect(secondClaim.status).toBe("submitted");

    const firstClaim = await submitVodafoneCashTransferClaim(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        orderId: first.placed.orderId,
        promptMessageId: 9201,
        reference: "FIRST-ORDER-REF",
      },
    );
    expect(firstClaim.status).toBe("submitted");

    const repeatFirst = await submitVodafoneCashTransferClaim(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        orderId: first.placed.orderId,
        promptMessageId: 9201,
        reference: "FIRST-ORDER-REF",
      },
    );
    expect(repeatFirst.status).toBe("already_submitted");

    expect(await claimRow(first.placed.orderId)).toMatchObject({
      reference: "FIRST-ORDER-REF",
    });
    expect(await claimRow(second.placed.orderId)).toMatchObject({
      reference: "SECOND-ORDER-REF",
    });

    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
        telegramChatId: BUYER_B,
        promptMessageId: 9201,
      }),
    ).toBeNull();
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_B,
        promptMessageId: 9201,
      }),
    ).toBeNull();
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9299,
      }),
    ).toBeNull();
  });

  it("rejects a reply whose prompt was replaced between lookup and claim write", async () => {
    const { placed } = await placeVodafoneOrder();
    const storeScope = await scope(fixture.storeAId);

    const firstPrompt = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(firstPrompt.status).toBe("prompted");
    if (firstPrompt.status !== "prompted") return;

    expect(
      await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
        messageId: 9401,
        promptToken: firstPrompt.promptToken,
      }),
    ).toBe(true);

    // This is the webhook's initial lookup. The prompt is replaced after it.
    const lookedUp = await readVodafoneCashOrderByPromptReply(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9401,
      },
    );
    expect(lookedUp).toMatchObject({ orderId: placed.orderId });

    const secondPrompt = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(secondPrompt.status).toBe("prompted");
    if (secondPrompt.status !== "prompted") return;
    expect(secondPrompt.promptToken).not.toBe(firstPrompt.promptToken);

    expect(
      await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
        messageId: 9402,
        promptToken: secondPrompt.promptToken,
      }),
    ).toBe(true);

    const superseded = await submitVodafoneCashTransferClaim(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        orderId: placed.orderId,
        promptMessageId: 9401,
        reference: "SUPERSEDED-REF",
      },
    );
    expect(superseded.status).toBe("prompt_superseded");
    expect(await claimRow(placed.orderId)).toBeUndefined();
    expect((await orderRow(placed.orderId)).paymentStatus).toBe(
      "awaiting_transfer",
    );
    expect((await orderRow(placed.orderId)).transferPromptMessageId).toBe(9402);
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });

    const current = await submitVodafoneCashTransferClaim(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      orderId: placed.orderId,
      promptMessageId: 9402,
      reference: "CURRENT-REF",
    });
    expect(current.status).toBe("submitted");

    const repeatedOldReply = await submitVodafoneCashTransferClaim(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        orderId: placed.orderId,
        promptMessageId: 9401,
        reference: "SUPERSEDED-REF",
      },
    );
    expect(repeatedOldReply.status).toBe("already_submitted");
    expect(await claimRow(placed.orderId)).toMatchObject({
      reference: "CURRENT-REF",
      status: "pending",
    });
    const claims = await db()
      .select()
      .from(orderPaymentClaim)
      .where(eq(orderPaymentClaim.orderId, placed.orderId));
    expect(claims).toHaveLength(1);
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
  });

  it("does not let a delayed older prompt binding replace the newer one", async () => {
    const { placed } = await placeVodafoneOrder();
    const storeScope = await scope(fixture.storeAId);

    const older = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    const newer = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(older.status).toBe("prompted");
    expect(newer.status).toBe("prompted");
    if (older.status !== "prompted" || newer.status !== "prompted") return;

    // The newer send completes first.
    expect(
      await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
        messageId: 9502,
        promptToken: newer.promptToken,
      }),
    ).toBe(true);

    // The older send completes later and must not overwrite the binding.
    expect(
      await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
        messageId: 9501,
        promptToken: older.promptToken,
      }),
    ).toBe(false);

    expect((await orderRow(placed.orderId)).transferPromptMessageId).toBe(9502);
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9501,
      }),
    ).toBeNull();

    const stale = await submitVodafoneCashTransferClaim(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      orderId: placed.orderId,
      promptMessageId: 9501,
      reference: "DELAYED-OLD-REF",
    });
    expect(stale.status).toBe("prompt_superseded");
    expect(await claimRow(placed.orderId)).toBeUndefined();
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });

    const accepted = await submitVodafoneCashTransferClaim(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      orderId: placed.orderId,
      promptMessageId: 9502,
      reference: "DELAYED-NEW-REF",
    });
    expect(accepted.status).toBe("submitted");
  });

  it("verifies a transfer once, records the actor and time, and leaves stock reserved", async () => {
    const { placed } = await placeVodafoneOrder();
    await submitClaim(placed.orderId);
    const storeScope = await scope(fixture.storeAId);

    const decidedAtBefore = Date.now();
    const verified = await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
      note: "Matched the wallet transfer.",
    });
    expect(verified).toMatchObject({
      status: "verified",
      paymentStatus: "transfer_verified",
      fulfillmentStatus: "unfulfilled",
      claimStatus: "approved",
      releasedQuantity: 0,
    });

    const storedClaim = await claimRow(placed.orderId);
    expect(storedClaim.status).toBe("approved");
    expect(storedClaim.decidedBy).toBe(fixture.ownerAId);
    expect(storedClaim.decisionNote).toBe("Matched the wallet transfer.");
    expect(storedClaim.decidedAt?.getTime()).toBeGreaterThanOrEqual(
      decidedAtBefore,
    );

    const verifiedOrder = await orderRow(placed.orderId);
    expect(verifiedOrder).toMatchObject({
      status: "placed",
      paymentStatus: "transfer_verified",
      fulfillmentStatus: "unfulfilled",
    });
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });

    const retry = await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });
    expect(retry.status).toBe("already_applied");

    const competing = await rejectVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });
    expect(competing.status).toBe("invalid_transition");
    expect(await claimRow(placed.orderId)).toMatchObject({
      status: "approved",
      decidedBy: fixture.ownerAId,
    });
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 2,
    });
  });

  it("rejects a claim once, records the decision and releases the reservation", async () => {
    const { placed } = await placeVodafoneOrder();
    const storeScope = await scope(fixture.storeAId);
    const requested = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(requested.status).toBe("prompted");
    if (requested.status !== "prompted") return;

    await bindVodafoneCashTransferPromptMessage(tx(), storeScope, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      orderId: placed.orderId,
      messageId: 9301,
      promptToken: requested.promptToken,
    });
    await submitClaim(placed.orderId);

    const rejected = await rejectVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
      note: "No matching transfer in the wallet.",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      orderStatus: "cancelled",
      paymentStatus: "transfer_rejected",
      fulfillmentStatus: "cancelled",
      claimStatus: "rejected",
      releasedQuantity: 2,
    });

    const storedClaim = await claimRow(placed.orderId);
    expect(storedClaim).toMatchObject({
      status: "rejected",
      decidedBy: fixture.ownerAId,
      decisionNote: "No matching transfer in the wallet.",
    });
    const cancelledOrder = await orderRow(placed.orderId);
    expect(cancelledOrder).toMatchObject({
      status: "cancelled",
      paymentStatus: "transfer_rejected",
      fulfillmentStatus: "cancelled",
      cancellationReason: "transfer_rejected",
    });
    expect(cancelledOrder.cancelledAt).toBeInstanceOf(Date);
    expect(
      await readVodafoneCashOrderByPromptReply(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
        promptMessageId: 9301,
      }),
    ).toMatchObject({
      orderStatus: "cancelled",
      paymentStatus: "transfer_rejected",
      claim: { status: "rejected" },
      transferSnapshot: { number: "+201000000001" },
    });
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });

    const reservations = await db()
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, placed.orderId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      status: "released",
      releaseReason: "transfer_rejected",
    });

    const retry = await rejectVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });
    expect(retry.status).toBe("already_applied");

    const competing = await verifyVodafoneCashTransfer(tx(), storeScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });
    expect(competing.status).toBe("invalid_transition");
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
  });

  it("serializes competing verify and reject decisions into one payment and stock effect", async () => {
    const { placed } = await placeVodafoneOrder();
    await submitClaim(placed.orderId);
    const storeScope = await scope(fixture.storeAId);

    const [verified, rejected] = await Promise.all([
      verifyVodafoneCashTransfer(tx(), storeScope, {
        orderId: placed.orderId,
        actorUserId: fixture.ownerAId,
      }),
      rejectVodafoneCashTransfer(tx(), storeScope, {
        orderId: placed.orderId,
        actorUserId: fixture.ownerAId,
      }),
    ]);

    const outcomes = [verified.status, rejected.status];
    expect(outcomes.filter((status) => status === "invalid_transition")).toHaveLength(1);
    expect(
      outcomes.filter(
        (status) => status === "verified" || status === "rejected",
      ),
    ).toHaveLength(1);

    const finalClaim = await claimRow(placed.orderId);
    const finalOrder = await orderRow(placed.orderId);
    const inventory = await inventoryFor(fixture.productAId);

    if (finalClaim.status === "approved") {
      expect(finalOrder.paymentStatus).toBe("transfer_verified");
      expect(finalOrder.status).toBe("placed");
      expect(inventory.reserved).toBe(2);
    } else {
      expect(finalClaim.status).toBe("rejected");
      expect(finalOrder.paymentStatus).toBe("transfer_rejected");
      expect(finalOrder.status).toBe("cancelled");
      expect(inventory.reserved).toBe(0);
    }

    expect(await db().select().from(orderPaymentClaim)).toHaveLength(1);
    expect(await db().select().from(inventoryReservation)).toHaveLength(1);
    expect(inventory.onHand).toBe(5);
  });

  it("keeps every decision and listing strictly inside the owning store", async () => {
    const { placed } = await placeVodafoneOrder();
    await submitClaim(placed.orderId);

    const storeBScope = await scope(fixture.storeBId);
    const crossVerify = await verifyVodafoneCashTransfer(tx(), storeBScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerBId,
    });
    expect(crossVerify.status).toBe("not_found");

    const crossReject = await rejectVodafoneCashTransfer(tx(), storeBScope, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerBId,
    });
    expect(crossReject.status).toBe("not_found");

    await db()
      .update(storeCommerceSetting)
      .set({
        vodafoneCashEnabled: true,
        vodafoneCashNumber: "+201000000099",
        vodafoneCashAccountName: "Synthetic Merchant B",
        vodafoneCashInstructionsEn: "Transfer to store B.",
      })
      .where(eq(storeCommerceSetting.storeId, fixture.storeBId));

    const crossClaim = await submitVodafoneCashTransferClaim(
      tx(),
      storeBScope,
      {
        connectionId: fixture.connectionBId,
        telegramUserId: BUYER_B,
        telegramChatId: BUYER_B,
        orderId: placed.orderId,
        promptMessageId: 1,
        reference: "CROSS-STORE-REF",
      },
    );
    expect(crossClaim.status).toBe("not_found");

    expect(await listMerchantOrders(asAppDb(db()), storeBScope)).toHaveLength(0);

    const merchantA = await listMerchantOrders(asAppDb(db()), await scope(fixture.storeAId));
    expect(merchantA).toHaveLength(1);
    expect(merchantA[0]).toMatchObject({
      paymentMethod: "vodafone_cash",
      paymentStatus: "transfer_awaiting_review",
      transferAwaitingReview: true,
      transferClaim: { status: "pending", reference: VODAFONE_REFERENCE },
    });
  });

  it("lists outstanding buyer transfers only inside the authorized store, connection, buyer and chat", async () => {
    const { placed } = await placeVodafoneOrder({ quantity: 1 });
    const storeA = await scope(fixture.storeAId);
    const storeB = await scope(fixture.storeBId);

    const own = await listBuyerOutstandingVodafoneTransfers(tx(), storeA, {
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
    });
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      orderId: placed.orderId,
      paymentStatus: "awaiting_transfer",
    });

    expect(
      await listBuyerOutstandingVodafoneTransfers(tx(), storeB, {
        connectionId: fixture.connectionBId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
      }),
    ).toHaveLength(0);

    expect(
      await listBuyerOutstandingVodafoneTransfers(tx(), storeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
        telegramChatId: BUYER_B,
      }),
    ).toHaveLength(0);

    expect(
      await listBuyerOutstandingVodafoneTransfers(tx(), storeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_B,
      }),
    ).toHaveLength(0);

    await submitClaim(placed.orderId);
    const stillOutstanding = await listBuyerOutstandingVodafoneTransfers(
      tx(),
      storeA,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
      },
    );
    expect(stillOutstanding).toHaveLength(1);
    expect(stillOutstanding[0].paymentStatus).toBe("transfer_awaiting_review");

    await verifyVodafoneCashTransfer(tx(), storeA, {
      orderId: placed.orderId,
      actorUserId: fixture.ownerAId,
    });
    expect(
      await listBuyerOutstandingVodafoneTransfers(tx(), storeA, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        telegramChatId: BUYER_A,
      }),
    ).toHaveLength(0);
  });

  it("cannot buy or claim with the method when deployment or store enablement is off", async () => {
    const { cartId, review, scope: storeScope } = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_A,
      productId: fixture.productAId,
      quantity: 1,
    });

    delete process.env.RABET_MANUAL_TRANSFER_ENABLED;
    const deploymentOff = await confirmVodafoneCashOrder(tx(), storeScope, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(deploymentOff.status).toBe("transfer_unavailable");

    process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";
    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const storeOff = await confirmVodafoneCashOrder(tx(), storeScope, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(storeOff.status).toBe("transfer_unavailable");

    await db()
      .update(storeCommerceSetting)
      .set({ codEnabled: false, vodafoneCashEnabled: true })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const codOff = await confirmCodOrder(tx(), storeScope, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(codOff.status).toBe("cod_unavailable");

    const placed = await confirmVodafoneCashOrder(tx(), storeScope, {
      cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_A,
      telegramChatId: BUYER_A,
      expectedQuoteVersion: review.quoteVersion,
    });
    expect(placed.status).toBe("placed");
    if (placed.status !== "placed") return;

    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: false })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const promptAfterStoreDisable = await requestVodafoneCashTransferReference(
      tx(),
      storeScope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_A,
        orderId: placed.orderId,
      },
    );
    expect(promptAfterStoreDisable.status).toBe("prompted");

    const claimAfterStoreDisable = await submitClaim(
      placed.orderId,
      "STORE-DISABLED-REF",
      { buyerId: BUYER_A },
    );
    expect(claimAfterStoreDisable).toMatchObject({
      status: "submitted",
      paymentStatus: "transfer_awaiting_review",
    });

    await db()
      .update(storeCommerceSetting)
      .set({ vodafoneCashEnabled: true })
      .where(eq(storeCommerceSetting.storeId, fixture.storeAId));

    const second = await placeVodafoneOrder({
      buyerId: BUYER_B,
      quantity: 1,
    });

    delete process.env.RABET_MANUAL_TRANSFER_ENABLED;

    const promptAfterDeploymentDisable =
      await requestVodafoneCashTransferReference(tx(), storeScope, {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
        orderId: second.placed.orderId,
      });
    expect(promptAfterDeploymentDisable.status).toBe("prompted");

    const claimAfterDeploymentDisable = await submitClaim(
      second.placed.orderId,
      "DEPLOYMENT-DISABLED-REF",
      { buyerId: BUYER_B },
    );
    expect(claimAfterDeploymentDisable).toMatchObject({
      status: "submitted",
      paymentStatus: "transfer_awaiting_review",
    });

    process.env.RABET_MANUAL_TRANSFER_ENABLED = "true";
  });

  it("rejects the same transfer reference on a second order in the store", async () => {
    const first = await placeVodafoneOrder({ quantity: 1 });
    await submitClaim(first.placed.orderId, "SAME-TRANSFER-REF");

    const second = await placeVodafoneOrder({ quantity: 1 });
    const conflict = await submitClaim(second.placed.orderId, "SAME-TRANSFER-REF");
    expect(conflict.status).toBe("reference_conflict");
    expect(await claimRow(second.placed.orderId)).toBeUndefined();

    const secondOrder = await orderRow(second.placed.orderId);
    expect(secondOrder.paymentStatus).toBe("awaiting_transfer");
  });

  it("commits a verified transfer reservation exactly once at shipping and keeps COD unchanged", async () => {
    const { placed } = await placeVodafoneOrder();
    await submitClaim(placed.orderId);
    const storeScope = await scope(fixture.storeAId);

    expect((await acceptMerchantOrder(tx(), storeScope, placed.orderId)).status).toBe(
      "accepted",
    );
    expect(
      (await prepareMerchantOrder(tx(), storeScope, placed.orderId)).status,
    ).toBe("preparing");

    const prematureHandoff = await handMerchantOrderToShipping(
      tx(),
      storeScope,
      placed.orderId,
    );
    if (prematureHandoff.status !== "handed_to_shipping") {
      expect(prematureHandoff.status).toBe("invalid_transition");
      await verifyVodafoneCashTransfer(tx(), storeScope, {
        orderId: placed.orderId,
        actorUserId: fixture.ownerAId,
      });
    }

    const handed = await handMerchantOrderToShipping(
      tx(),
      storeScope,
      placed.orderId,
    );
    expect(handed.status).toBe("handed_to_shipping");
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 3,
      reserved: 0,
    });
    const reservations = await db()
      .select()
      .from(inventoryReservation)
      .where(eq(inventoryReservation.orderId, placed.orderId));
    expect(reservations[0].status).toBe("committed");

    const handoffRetry = await handMerchantOrderToShipping(
      tx(),
      storeScope,
      placed.orderId,
    );
    expect(handoffRetry.status).toBe("already_applied");
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 3,
      reserved: 0,
    });

    const collectTransfer = await collectMerchantOrderPayment(
      tx(),
      storeScope,
      placed.orderId,
    );
    expect(collectTransfer.status).toBe("invalid_transition");

    const codPrepared = await prepareReviewedOrder({
      storeId: fixture.storeAId,
      connectionId: fixture.connectionAId,
      buyerId: BUYER_B,
      productId: fixture.productAId,
      quantity: 1,
    });
    const codPlaced = await confirmCodOrder(tx(), codPrepared.scope, {
      cartId: codPrepared.cartId,
      connectionId: fixture.connectionAId,
      telegramUserId: BUYER_B,
      telegramChatId: BUYER_B,
      expectedQuoteVersion: codPrepared.review.quoteVersion,
    });
    expect(codPlaced.status).toBe("placed");
    if (codPlaced.status !== "placed") return;

    const codClaim = await submitVodafoneCashTransferClaim(
      tx(),
      codPrepared.scope,
      {
        connectionId: fixture.connectionAId,
        telegramUserId: BUYER_B,
        telegramChatId: BUYER_B,
        orderId: codPlaced.orderId,
        promptMessageId: 1,
        reference: "COD-NOT-A-TRANSFER",
      },
    );
    expect(codClaim.status).toBe("not_found");

    expect((await acceptMerchantOrder(tx(), codPrepared.scope, codPlaced.orderId)).status).toBe(
      "accepted",
    );
    expect(
      (await prepareMerchantOrder(tx(), codPrepared.scope, codPlaced.orderId)).status,
    ).toBe("preparing");
    expect(
      (
        await handMerchantOrderToShipping(
          tx(),
          codPrepared.scope,
          codPlaced.orderId,
        )
      ).status,
    ).toBe("handed_to_shipping");
    expect(
      (
        await markMerchantOrderDelivered(
          tx(),
          codPrepared.scope,
          codPlaced.orderId,
        )
      ).status,
    ).toBe("delivered");
    expect(
      (
        await collectMerchantOrderPayment(
          tx(),
          codPrepared.scope,
          codPlaced.orderId,
        )
      ).status,
    ).toBe("collected");
    expect((await orderRow(codPlaced.orderId)).paymentStatus).toBe("collected");
  });

  it("keeps cancellation able to close a pending claim without touching on-hand stock", async () => {
    const { placed } = await placeVodafoneOrder();
    await submitClaim(placed.orderId);
    const storeScope = await scope(fixture.storeAId);

    const cancelled = await cancelMerchantOrder(tx(), storeScope, {
      orderId: placed.orderId,
      reason: "buyer requested cancellation",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.releasedQuantity).toBe(2);
    expect(await inventoryFor(fixture.productAId)).toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    expect(await claimRow(placed.orderId)).toMatchObject({
      status: "cancelled",
      decidedBy: null,
    });
    expect((await orderRow(placed.orderId)).paymentStatus).toBe(
      "transfer_awaiting_review",
    );
  });
});
