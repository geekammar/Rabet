import fs from "node:fs";

import { eq } from "drizzle-orm";

import {
  appUser,
  cart,
  inventoryReservation,
  language,
  merchantCredential,
  order,
  orderItem,
  product,
  productInventory,
  productTranslation,
  category,
  categoryTranslation,
  store,
  storeCommerceSetting,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import {
  addToCart,
  confirmCodOrder,
  readCartForBuyer,
  saveAddressAndPrepareReview,
  savePhone,
  startCheckout,
} from "@/lib/commerce/orders";
import { createStoreScopeForExistingStore } from "@/lib/data/store-scope";
import { createTransactionClient } from "@/db/transaction-client";

const databaseUrl = process.env.SEED_DATABASE_URL;
const hashA = process.env.SEED_MERCHANT_A_PASSWORD_HASH;
const hashB = process.env.SEED_MERCHANT_B_PASSWORD_HASH;
const outputPath = process.env.SEED_OUTPUT;

if (!databaseUrl || !hashA || !hashB || !outputPath) {
  throw new Error(
    "SEED_DATABASE_URL, SEED_MERCHANT_A_PASSWORD_HASH, SEED_MERCHANT_B_PASSWORD_HASH and SEED_OUTPUT are required.",
  );
}

const client = createTransactionClient(databaseUrl);
const db = client.db;

async function main() {
  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  const [arabic] = await db
    .insert(language)
    .values({
      code: "ar",
      label: "العربية",
      textDirection: "rtl",
      isEnabled: true,
    })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({
      name: "COD PR56 Store A",
      slug: "cod-pr56-store-a",
      status: "active",
    })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({
      name: "COD PR56 Store B",
      slug: "cod-pr56-store-b",
      status: "active",
    })
    .returning();

  const [merchantA] = await db
    .insert(appUser)
    .values({ email: "cod-pr56.a@example.test" })
    .returning();
  const [merchantB] = await db
    .insert(appUser)
    .values({ email: "cod-pr56.b@example.test" })
    .returning();

  await db.insert(merchantCredential).values([
    { userId: merchantA.id, passwordHash: hashA },
    { userId: merchantB.id, passwordHash: hashB },
  ]);

  await db.insert(storeMembership).values([
    {
      storeId: storeA.id,
      userId: merchantA.id,
      role: "owner",
      status: "active",
    },
    {
      storeId: storeB.id,
      userId: merchantB.id,
      role: "owner",
      status: "active",
    },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "cod-pr56-store-a-root",
      sortOrder: 1,
      isActive: true,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "cod-pr56-store-b-root",
      sortOrder: 2,
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "Store A Root" },
    { categoryId: categoryA.id, languageId: arabic.id, name: "جذر المتجر أ" },
    { categoryId: categoryB.id, languageId: english.id, name: "Store B Root" },
    { categoryId: categoryB.id, languageId: arabic.id, name: "جذر المتجر ب" },
  ]);

  const [productA] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "cod-pr56-store-a-product",
      price: "11.00",
      isActive: true,
      sortOrder: 1,
    })
    .returning();
  const [productB] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "cod-pr56-store-b-product",
      price: "30.00",
      isActive: true,
      sortOrder: 1,
    })
    .returning();

  await db.insert(productTranslation).values([
    {
      productId: productA.id,
      languageId: english.id,
      name: "COD Test Product A",
      description: "Synthetic COD acceptance product A",
    },
    {
      productId: productA.id,
      languageId: arabic.id,
      name: "منتج الدفع عند الاستلام أ",
      description: "منتج اختبار اصطناعي أ",
    },
    {
      productId: productB.id,
      languageId: english.id,
      name: "COD Test Product B",
      description: "Synthetic COD acceptance product B",
    },
    {
      productId: productB.id,
      languageId: arabic.id,
      name: "منتج الدفع عند الاستلام ب",
      description: "منتج اختبار اصطناعي ب",
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
      currency: "SAR",
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
      botId: 991001,
      botUsername: "cod_pr56_store_a_bot",
      tokenCiphertext: "synthetic-cod-staging-token",
      tokenKeyId: "synthetic-v1",
      webhookSecretHash: "a".repeat(64),
      webhookUrl: "https://nokmel-cod-staging.onrender.com/api/telegram/webhook/managed/synthetic-a",
      status: "ready",
      verifiedAt: new Date(),
    })
    .returning();

  const scopeA = await createStoreScopeForExistingStore(db, storeA.id);
  const buyerId = 96001;

  const added = await addToCart(client.db, scopeA, {
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    telegramChatId: buyerId,
    productId: productA.id,
    quantity: 2,
  });
  if (added.status !== "added") {
    throw new Error(`Seed add failed: ${added.status}`);
  }

  const started = await startCheckout(client.db, scopeA, {
    cartId: added.cart.id,
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    profileName: "Synthetic Buyer A",
  });
  if (started.status !== "ready") {
    throw new Error(`Seed checkout failed: ${started.status}`);
  }

  const phone = await savePhone(client.db, scopeA, {
    cartId: added.cart.id,
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    phone: "+٩٦٦ ٥٥٥ ٠٠٠ ٠٠١",
  });
  if (phone.status !== "saved") {
    throw new Error(`Seed phone failed: ${phone.status}`);
  }

  const reviewed = await saveAddressAndPrepareReview(client.db, scopeA, {
    cartId: added.cart.id,
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    address: "١٢٣ شارع الاختبار الاصطناعي",
  });
  if (reviewed.status !== "review") {
    throw new Error(`Seed address/review failed: ${reviewed.status}`);
  }

  const placed = await confirmCodOrder(client.db, scopeA, {
    cartId: added.cart.id,
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    telegramChatId: buyerId,
    expectedQuoteVersion: reviewed.review.quoteVersion,
  });
  if (placed.status !== "placed") {
    throw new Error(`Seed confirm failed: ${placed.status}`);
  }

  const duplicate = await confirmCodOrder(client.db, scopeA, {
    cartId: added.cart.id,
    connectionId: connectionA.id,
    telegramUserId: buyerId,
    telegramChatId: buyerId,
    expectedQuoteVersion: reviewed.review.quoteVersion,
  });
  if (
    duplicate.status !== "already_placed" ||
    duplicate.reference !== placed.reference
  ) {
    throw new Error("Seed duplicate confirmation did not return the same reference");
  }

  // Hide the synthetic connection from the merchant setup UI. The order and
  // reservation remain valid and readable.
  await db
    .update(telegramConnection)
    .set({ status: "revoked", activationAttemptId: null })
    .where(eq(telegramConnection.id, connectionA.id));

  const [inventory] = await db
    .select()
    .from(productInventory)
    .where(eq(productInventory.productId, productA.id));
  const orders = await db.select().from(order);
  const reservations = await db.select().from(inventoryReservation);
  const items = await db.select().from(orderItem);
  const carts = await db.select().from(cart);

  if (
    orders.length !== 1 ||
    reservations.length !== 1 ||
    items.length !== 1 ||
    carts.length !== 1 ||
    inventory.reserved !== 2 ||
    inventory.onHand !== 5
  ) {
    throw new Error("Seed invariants failed");
  }

  const summary = {
    stores: {
      a: { id: storeA.id, name: storeA.name, slug: storeA.slug },
      b: { id: storeB.id, name: storeB.name, slug: storeB.slug },
    },
    merchants: {
      a: {
        userId: merchantA.id,
        email: merchantA.email,
        sessionVersion: merchantA.sessionVersion,
      },
      b: {
        userId: merchantB.id,
        email: merchantB.email,
        sessionVersion: merchantB.sessionVersion,
      },
    },
    order: {
      id: placed.orderId,
      reference: placed.reference,
      subtotal: placed.subtotal,
      deliveryFee: placed.deliveryFee,
      total: placed.total,
      currency: placed.currency,
      paymentStatus: "awaiting_collection",
      fulfillmentStatus: "unfulfilled",
    },
    duplicateReferenceMatched: true,
    inventory: { onHand: inventory.onHand, reserved: inventory.reserved },
    counts: {
      orders: orders.length,
      reservations: reservations.length,
      items: items.length,
      carts: carts.length,
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(
      `[cod-staging-seed:FAIL] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
