import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  category,
  categoryTranslation,
  language,
  product,
  productInventory,
  productTranslation,
  store,
  storeCommerceSetting,
  storeMembership,
  telegramConnection,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import { readManagedProduct } from "@/lib/catalog/managed-storefront";
import {
  publishMerchantCatalogProduct,
  readMerchantProductPreview,
  readMerchantProductReadiness,
  type MerchantProductReadinessReason,
} from "@/lib/merchant/product-publish";
import {
  createMerchantCatalogProduct,
  resolveMerchantCatalogLanguage,
  type MerchantCatalogLanguage,
} from "@/lib/merchant/product-create";
import { updateMerchantCatalogProductDraft } from "@/lib/merchant/product-edit";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let englishLanguageId = "";
let merchantLanguage: MerchantCatalogLanguage;
let telegramSequence = 700_000;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_product_publish");

  const [english] = await testDb.db
    .insert(language)
    .values({
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    })
    .returning({ id: language.id });
  englishLanguageId = english.id;
  merchantLanguage = (await resolveMerchantCatalogLanguage(asAppDb(testDb.db)))!;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from product_inventory`);
  await testDb.db.execute(sql`delete from product_translation`);
  await testDb.db.execute(sql`delete from product`);
  await testDb.db.execute(sql`delete from category_translation`);
  await testDb.db.execute(sql`delete from category`);
  await testDb.db.execute(sql`delete from store_commerce_setting`);
  await testDb.db.execute(sql`delete from telegram_connection`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);

  vi.stubEnv("RABET_COD_ORDERS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function db() {
  return testDb!.db;
}

function appDb() {
  return asAppDb(db());
}

async function seedMerchant(storeStatus: "onboarding" | "active" | "suspended" = "active") {
  const [user] = await db()
    .insert(appUser)
    .values({ email: `publish-${crypto.randomUUID()}@example.test` })
    .returning({ id: appUser.id });
  const [row] = await db()
    .insert(store)
    .values({
      name: "Publish Store",
      slug: `publish-store-${crypto.randomUUID()}`,
      status: storeStatus,
    })
    .returning({ id: store.id });

  await db().insert(storeMembership).values({
    storeId: row.id,
    userId: user.id,
    role: "owner",
    status: "active",
  });

  const access = await resolveMerchantAccess(db(), {
    userId: user.id,
    sessionVersion: 0,
  });

  if (!access) throw new Error("expected merchant access");

  return { access, storeId: row.id, userId: user.id };
}

async function seedCategory(storeId: string, isActive = true) {
  const [row] = await db()
    .insert(category)
    .values({
      storeId,
      slug: `publish-category-${crypto.randomUUID()}`,
      sortOrder: nextOrder(),
      isActive,
    })
    .returning({ id: category.id });

  await db().insert(categoryTranslation).values({
    categoryId: row.id,
    languageId: englishLanguageId,
    name: "Publish category",
  });

  return row.id;
}

async function seedProduct(
  storeId: string,
  categoryId: string,
  input: {
    name?: string;
    price?: string;
    isActive?: boolean;
    inventory?: { onHand: number; reserved: number } | null;
  } = {},
) {
  const [row] = await db()
    .insert(product)
    .values({
      storeId,
      categoryId,
      slug: `publish-product-${crypto.randomUUID()}`,
      price: input.price ?? "25.00",
      isActive: input.isActive ?? false,
      sortOrder: nextOrder(),
    })
    .returning({ id: product.id });

  await db().insert(productTranslation).values({
    productId: row.id,
    languageId: englishLanguageId,
    name: input.name ?? "Publish product",
    description: "Publish description",
  });

  if (input.inventory !== null) {
    await db().insert(productInventory).values({
      productId: row.id,
      storeId,
      onHand: input.inventory?.onHand ?? 0,
      reserved: input.inventory?.reserved ?? 0,
    });
  }

  return row.id;
}

async function seedCommerce(
  storeId: string,
  input: {
    deliveryFee: string;
    deliveryFeeConfigured: boolean;
    codEnabled?: boolean;
    vodafoneCashEnabled?: boolean;
  },
) {
  await db().insert(storeCommerceSetting).values({
    storeId,
    currency: "EGP",
    deliveryFee: input.deliveryFee,
    deliveryFeeConfigured: input.deliveryFeeConfigured,
    codEnabled: input.codEnabled ?? true,
    vodafoneCashEnabled: input.vodafoneCashEnabled ?? false,
  });
}

async function seedReadyConnection(storeId: string) {
  telegramSequence += 1;

  await db().insert(telegramConnection).values({
    storeId,
    botId: telegramSequence,
    botUsername: "ReadyStoreBot",
    botName: "Ready Store Bot",
    tokenCiphertext: "test-ciphertext",
    tokenKeyId: "test-key",
    webhookSecretHash: "a".repeat(64),
    webhookUrl: "https://app.example.test/api/telegram/webhook/managed/ready",
    status: "ready",
    verifiedAt: new Date(),
  });
}

async function seedReadyMerchant(options: { inventory?: { onHand: number; reserved: number } | null } = {}) {
  const merchant = await seedMerchant();
  const categoryId = await seedCategory(merchant.storeId);
  const productId = await seedProduct(merchant.storeId, categoryId, {
    inventory: options.inventory === undefined ? { onHand: 2, reserved: 0 } : options.inventory,
  });
  await seedCommerce(merchant.storeId, {
    deliveryFee: "0.00",
    deliveryFeeConfigured: true,
  });
  await seedReadyConnection(merchant.storeId);

  return { ...merchant, categoryId, productId };
}

async function readProductRow(productId: string) {
  const [row] = await db()
    .select({
      isActive: product.isActive,
      price: product.price,
      imageUrl: product.imageUrl,
    })
    .from(product)
    .where(eq(product.id, productId));

  return row;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function waitForLockWaitOnInventory(deadlineMs = 4000) {
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    const rows = await db().execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like '%product_inventory%'
    `);

    if (Number(rows[0]?.waiting ?? 0) > 0) return true;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return false;
}

describe.skipIf(!shouldRun)("merchant product publish readiness", () => {
  it("returns actionable reasons when stock, payment, delivery and bot are missing", async () => {
    const merchant = await seedMerchant();
    const categoryId = await seedCategory(merchant.storeId);
    const productId = await seedProduct(merchant.storeId, categoryId, {
      inventory: null,
    });

    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      productId,
    );

    expect(readiness).toMatchObject({
      ready: false,
      isActive: false,
      availability: { available: 0, inStock: false },
    });
    expect(new Set(readiness?.reasons)).toEqual(
      new Set<MerchantProductReadinessReason>([
        "OUT_OF_STOCK",
        "NO_PAYMENT_METHOD",
        "DELIVERY_FEE_NOT_CONFIGURED",
        "STORE_BOT_NOT_CONNECTED",
      ]),
    );
  });

  it("accepts an explicitly free delivery fee and becomes ready", async () => {
    const merchant = await seedReadyMerchant();

    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    expect(readiness).toMatchObject({ ready: true, reasons: [] });
  });

  it("keeps a stored zero fee unconfigured when the merchant never set it", async () => {
    const merchant = await seedReadyMerchant();
    await db()
      .update(storeCommerceSetting)
      .set({
        deliveryFee: "0.00",
        deliveryFeeConfigured: false,
      })
      .where(eq(storeCommerceSetting.storeId, merchant.storeId));

    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    expect(readiness?.reasons).toContain("DELIVERY_FEE_NOT_CONFIGURED");
  });

  it("rejects publishing a draft that is not ready and leaves it inactive", async () => {
    const merchant = await seedMerchant();
    const categoryId = await seedCategory(merchant.storeId);
    const productId = await seedProduct(merchant.storeId, categoryId, {
      inventory: null,
    });

    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      productId,
    );

    const result = await publishMerchantCatalogProduct(db(), merchant.access, {
      productId,
      revision: readiness!.revision,
    });

    expect(result).toEqual({
      ok: false,
      error: "NOT_READY",
      reasons: readiness!.reasons,
    });
    expect(await readProductRow(productId)).toMatchObject({ isActive: false });
  });

  it("publishes a ready product and makes it visible to the buyer reader", async () => {
    const merchant = await seedReadyMerchant();
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    const result = await publishMerchantCatalogProduct(db(), merchant.access, {
      productId: merchant.productId,
      revision: before!.revision,
    });

    expect(result).toMatchObject({
      ok: true,
      productId: merchant.productId,
      isActive: true,
    });
    expect(await readProductRow(merchant.productId)).toMatchObject({
      isActive: true,
    });

    const buyerProduct = await readManagedProduct(
      appDb(),
      merchant.access.scope,
      merchant.productId,
    );
    expect(buyerProduct).toMatchObject({
      id: merchant.productId,
      availability: { available: 2, inStock: true },
    });
  });

  it("does not activate when commerce readiness changes after a ready read", async () => {
    const merchant = await seedReadyMerchant();
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    expect(before).toMatchObject({ ready: true, isActive: false });

    await db()
      .update(storeCommerceSetting)
      .set({ codEnabled: false, deliveryFeeConfigured: false })
      .where(eq(storeCommerceSetting.storeId, merchant.storeId));

    const result = await publishMerchantCatalogProduct(db(), merchant.access, {
      productId: merchant.productId,
      revision: before!.revision,
    });

    expect(result).toMatchObject({ ok: false, error: "NOT_READY" });
    if (!result.ok && result.error === "NOT_READY") {
      expect(new Set(result.reasons)).toEqual(
        new Set<MerchantProductReadinessReason>([
          "NO_PAYMENT_METHOD",
          "DELIVERY_FEE_NOT_CONFIGURED",
        ]),
      );
    }
    expect(await readProductRow(merchant.productId)).toMatchObject({
      isActive: false,
    });
  });

  it("does not activate when inventory is drained by a concurrent transaction after a ready read", async () => {
    const merchant = await seedReadyMerchant();
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    expect(before).toMatchObject({ ready: true, isActive: false });

    const rival = postgres(testDb!.url, { max: 1 });
    const drained = deferred();
    const releaseDrain = deferred();

    const rivalTransaction = rival.begin(async (tx) => {
      await tx`
        update product_inventory
        set on_hand = 0
        where product_id = ${merchant.productId}::uuid
          and store_id = ${merchant.storeId}::uuid
      `;
      drained.resolve();
      await releaseDrain.promise;
    });

    try {
      await drained.promise;

      const publishPromise = publishMerchantCatalogProduct(
        db(),
        merchant.access,
        { productId: merchant.productId, revision: before!.revision },
      );

      expect(await waitForLockWaitOnInventory()).toBe(true);

      releaseDrain.resolve();
      await rivalTransaction;

      const result = await publishPromise;

      expect(result).toMatchObject({ ok: false, error: "NOT_READY" });
      if (!result.ok && result.error === "NOT_READY") {
        expect(result.reasons).toContain("OUT_OF_STOCK");
      }
      expect(await readProductRow(merchant.productId)).toMatchObject({
        isActive: false,
      });
    } finally {
      releaseDrain.resolve();
      await rivalTransaction.catch(() => {});
      await rival.end();
    }
  });

  it("denies a cross-store product without disclosing it", async () => {
    const storeA = await seedReadyMerchant();
    const storeB = await seedMerchant();
    const categoryB = await seedCategory(storeB.storeId);
    const productB = await seedProduct(storeB.storeId, categoryB, {
      inventory: { onHand: 3, reserved: 0 },
    });

    const readinessA = await readMerchantProductReadiness(
      appDb(),
      storeB.access,
      productB,
    );

    const result = await publishMerchantCatalogProduct(
      db(),
      storeA.access,
      { productId: productB, revision: readinessA!.revision },
    );

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await readProductRow(productB)).toMatchObject({ isActive: false });
    expect(
      await readMerchantProductPreview(appDb(), storeA.access, productB),
    ).toBeNull();
  });

  it("keeps an already-published product published when readiness is incomplete", async () => {
    const merchant = await seedMerchant();
    const categoryId = await seedCategory(merchant.storeId);
    const productId = await seedProduct(merchant.storeId, categoryId, {
      isActive: true,
      inventory: null,
    });

    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      productId,
    );

    expect(readiness?.ready).toBe(false);

    const result = await publishMerchantCatalogProduct(db(), merchant.access, {
      productId,
      revision: readiness!.revision,
    });

    expect(result).toMatchObject({ ok: true, isActive: true });
    expect(await readProductRow(productId)).toMatchObject({ isActive: true });
  });

  it("surfaces the last sold unit as out of stock while the product stays visible", async () => {
    const merchant = await seedReadyMerchant({
      inventory: { onHand: 1, reserved: 1 },
    });
    const readiness = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    expect(readiness).toMatchObject({
      availability: { available: 0, inStock: false },
    });
    expect(readiness?.reasons).toContain("OUT_OF_STOCK");

    await db()
      .update(product)
      .set({ isActive: true })
      .where(eq(product.id, merchant.productId));

    const visible = await readManagedProduct(
      appDb(),
      merchant.access.scope,
      merchant.productId,
    );
    expect(visible).toMatchObject({
      availability: { available: 0, inStock: false },
    });
  });
});

describe.skipIf(!shouldRun)("merchant product draft details", () => {
  it("writes description, one image reference and initial stock on create", async () => {
    const merchant = await seedMerchant();
    const categoryId = await seedCategory(merchant.storeId);

    const result = await createMerchantCatalogProduct(
      db(),
      merchant.access,
      merchantLanguage,
      {
        name: "Draft with details",
        price: "19.9",
        categoryId,
        description: "A detailed draft description",
        imageUrl: "https://cdn.example.test/draft.jpg",
        stock: "8",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected create to succeed");

    const [saved] = await db()
      .select({
        imageUrl: product.imageUrl,
        isActive: product.isActive,
        description: productTranslation.description,
        onHand: productInventory.onHand,
        reserved: productInventory.reserved,
      })
      .from(product)
      .innerJoin(
        productTranslation,
        eq(productTranslation.productId, product.id),
      )
      .innerJoin(
        productInventory,
        eq(productInventory.productId, product.id),
      )
      .where(eq(product.id, result.productId));

    expect(saved).toEqual({
      imageUrl: "https://cdn.example.test/draft.jpg",
      isActive: false,
      description: "A detailed draft description",
      onHand: 8,
      reserved: 0,
    });
  });

  it("updates description, image and stock on edit without resetting reserved units", async () => {
    const merchant = await seedReadyMerchant({
      inventory: { onHand: 5, reserved: 2 },
    });
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    const result = await updateMerchantCatalogProductDraft(
      db(),
      merchant.access,
      merchantLanguage,
      {
        productId: merchant.productId,
        revision: before!.revision,
        description: "Edited description",
        imageUrl: "https://cdn.example.test/edited.jpg",
        stock: "9",
      },
    );

    expect(result).toMatchObject({ ok: true, productId: merchant.productId });

    const [saved] = await db()
      .select({
        imageUrl: product.imageUrl,
        description: productTranslation.description,
        onHand: productInventory.onHand,
        reserved: productInventory.reserved,
      })
      .from(product)
      .innerJoin(
        productTranslation,
        eq(productTranslation.productId, product.id),
      )
      .innerJoin(
        productInventory,
        eq(productInventory.productId, product.id),
      )
      .where(eq(product.id, merchant.productId));

    expect(saved).toEqual({
      imageUrl: "https://cdn.example.test/edited.jpg",
      description: "Edited description",
      onHand: 9,
      reserved: 2,
    });
  });

  it("refuses to lower stock below the existing reservation", async () => {
    const merchant = await seedReadyMerchant({
      inventory: { onHand: 5, reserved: 3 },
    });
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    const result = await updateMerchantCatalogProductDraft(
      db(),
      merchant.access,
      merchantLanguage,
      {
        productId: merchant.productId,
        revision: before!.revision,
        description: "Attempted edit",
        imageUrl: "",
        stock: "2",
      },
    );

    expect(result).toEqual({ ok: false, error: "STOCK_BELOW_RESERVED" });

    const [saved] = await db()
      .select({
        onHand: productInventory.onHand,
        reserved: productInventory.reserved,
      })
      .from(productInventory)
      .where(eq(productInventory.productId, merchant.productId));

    expect(saved).toEqual({ onHand: 5, reserved: 3 });
  });

  it("rejects an unsafe image scheme before writing anything", async () => {
    const merchant = await seedReadyMerchant();
    const before = await readMerchantProductReadiness(
      appDb(),
      merchant.access,
      merchant.productId,
    );

    const result = await updateMerchantCatalogProductDraft(
      db(),
      merchant.access,
      merchantLanguage,
      {
        productId: merchant.productId,
        revision: before!.revision,
        description: "Edited description",
        imageUrl: "javascript:alert(1)",
        stock: "2",
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "INVALID_INPUT",
      fields: { imageUrl: true },
    });
  });
});
