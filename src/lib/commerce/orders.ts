import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  cart,
  cartItem,
  inventoryReservation,
  order as orderTable,
  orderItem,
  productInventory,
  store,
  storeCommerceSetting,
  telegramConnection,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  readManagedProduct,
  type ManagedCatalogContentPlan,
} from "@/lib/catalog/managed-storefront";
import {
  assertStoreScope,
  type StoreScope,
} from "@/lib/data/store-scope";
import { lockConnectionStoreShared } from "@/lib/telegram/connection-locks";
import { isCodOrdersDeploymentEnabled } from "./feature";
import {
  canCancelMerchantOrder,
  canHandMerchantOrderToShipping,
  canMarkMerchantOrderDelivered,
  canRecordMerchantOrderCollection,
  normalizeCancellationReason,
} from "./order-state";

/**
 * Scoped cash-on-delivery commerce for one verified managed Store Bot.
 *
 * Every operation takes a server-minted `StoreScope` and the verified
 * connection + Telegram buyer identity. A callback's cart, product or order id
 * is never an authorization input: it is only a locator inside those trusted
 * constraints.
 *
 * Confirmations run in one interactive PostgreSQL transaction: the cart row is
 * locked, the quote is revalidated, inventory rows are locked in deterministic
 * product order, stock is checked, and the order, line snapshots and
 * reservations are written together. A cart never reserves stock.
 */

type CommerceTransaction = Parameters<
  Parameters<TransactionDatabase["transaction"]>[0]
>[0];

export type CommerceQueryDatabase = Database | CommerceTransaction;

const ORDER_REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_LINE_QUANTITY = 99;
const ACTIVE_CART_STATUSES = ["open", "checkout"] as const;

export type CommerceSetting = {
  storeId: string;
  currency: string;
  deliveryFee: string;
  codEnabled: boolean;
};

export type CartLine = {
  productId: string;
  name: string;
  description: string | null;
  categoryId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  available: boolean;
};

export type CartView = {
  id: string;
  status: "open" | "checkout" | "converted" | "abandoned";
  checkoutState: "cart" | "awaiting_phone" | "awaiting_address" | "review";
  currency: string;
  itemCount: number;
  lines: CartLine[];
  subtotal: string;
  deliveryFee: string;
  total: string;
  unavailableCount: number;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  quoteVersion: number;
};

export type CheckoutReview = {
  cartId: string;
  quoteVersion: number;
  currency: string;
  lines: CartLine[];
  subtotal: string;
  deliveryFee: string;
  total: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
};

type OrderReceipt = {
  reference: string;
  orderId: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  currency: string;
};

export type ConfirmOrderResult =
  | ({ status: "placed" } & OrderReceipt)
  | ({ status: "already_placed" } & OrderReceipt)
  | { status: "connection_stale" }
  | { status: "stale_quote"; review: CheckoutReview }
  | { status: "insufficient_stock"; productId: string }
  | { status: "item_unavailable"; productId: string }
  | { status: "missing_details"; missing: "name" | "phone" | "address" }
  | { status: "invalid_state" }
  | { status: "not_found" }
  | { status: "cod_unavailable" };

export type MerchantOrderItem = {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  snapshot: unknown;
};

export type MerchantOrder = {
  id: string;
  reference: string;
  placedAt: Date;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotal: string;
  deliveryFee: string;
  total: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  acceptedAt: Date | null;
  preparingAt: Date | null;
  handedToShippingAt: Date | null;
  deliveredAt: Date | null;
  paymentCollectedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  items: MerchantOrderItem[];
  reservationStatuses: string[];
};

type MerchantOrderProgress = {
  orderId: string;
  reference: string;
  orderStatus: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  cancellationReason: string | null;
  releasedQuantity: number;
  shippedQuantity: number;
};

export type MerchantOrderMutationResult =
  | ({
      status:
        | "accepted"
        | "preparing"
        | "handed_to_shipping"
        | "delivered"
        | "collected"
        | "cancelled";
    } & MerchantOrderProgress)
  | ({ status: "already_applied" } & MerchantOrderProgress)
  | { status: "not_found" }
  | {
      status: "invalid_transition";
      currentStatus: string;
      fulfillmentStatus: string;
    }
  | { status: "invalid_reason" };

function queryBuilder(db: CommerceQueryDatabase): Database {
  return db as unknown as Database;
}

/**
 * Verifies the connection again at the transaction boundary and acquires the
 * same per-store lock used when a replacement connection is made ready.
 * Ingress verification alone is insufficient: the connection may have been
 * revoked while this request was in flight.
 */
async function connectionIsCurrent(
  db: CommerceTransaction,
  scope: StoreScope,
  connectionId: string,
): Promise<boolean> {
  assertStoreScope(scope);
  await lockConnectionStoreShared(db, scope.storeId);

  const [row] = await db
    .select({ id: telegramConnection.id })
    .from(telegramConnection)
    .innerJoin(store, eq(store.id, telegramConnection.storeId))
    .where(
      and(
        eq(telegramConnection.id, connectionId),
        eq(telegramConnection.storeId, scope.storeId),
        eq(telegramConnection.status, "ready"),
        eq(store.status, "active"),
      ),
    )
    .limit(1);

  return Boolean(row);
}

function centsFromMoney(value: string): number {
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error("Invalid stored money value");
  }

  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));

  return whole * 100 + fraction;
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function quoteSnapshotFor(lines: CartLine[]) {
  return lines.map((line) => ({
    productId: line.productId,
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
  }));
}

function quoteSnapshotMatches(saved: unknown, lines: CartLine[]): boolean {
  if (!Array.isArray(saved) || saved.length !== lines.length) return false;

  return saved.every((entry, index) => {
    if (typeof entry !== "object" || entry === null) return false;
    const row = entry as Record<string, unknown>;
    const line = lines[index];

    return (
      row.productId === line.productId &&
      row.name === line.name &&
      row.quantity === line.quantity &&
      row.unitPrice === line.unitPrice &&
      row.lineTotal === line.lineTotal
    );
  });
}

const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function normalizeDigits(value: string): string {
  let normalized = "";

  for (const character of value) {
    const arabicIndex = ARABIC_INDIC_DIGITS.indexOf(character);
    if (arabicIndex !== -1) {
      normalized += String(arabicIndex);
      continue;
    }

    const easternIndex = EASTERN_ARABIC_INDIC_DIGITS.indexOf(character);
    if (easternIndex !== -1) {
      normalized += String(easternIndex);
      continue;
    }

    normalized += character;
  }

  return normalized;
}

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = normalizeDigits(value.trim());
  if (!/^\+?[0-9][0-9 ()\-]{5,24}$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 300) return null;
  return trimmed;
}

export function normalizeCustomerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return null;
  return trimmed;
}

export function normalizeQuantity(value: unknown): number | null {
  const quantity =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]{1,2}$/.test(value)
        ? Number(value)
        : NaN;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    return null;
  }

  return quantity;
}

export function generateOrderReference(): string {
  const bytes = crypto.randomBytes(6);
  let reference = "ORD-";

  for (const byte of bytes) {
    reference += ORDER_REFERENCE_ALPHABET[byte % ORDER_REFERENCE_ALPHABET.length];
  }

  return reference;
}

export async function readCommerceSetting(
  db: CommerceQueryDatabase,
  scope: StoreScope,
): Promise<CommerceSetting | null> {
  assertStoreScope(scope);

  const rows = await queryBuilder(db)
    .select({
      storeId: storeCommerceSetting.storeId,
      currency: storeCommerceSetting.currency,
      deliveryFee: storeCommerceSetting.deliveryFee,
      codEnabled: storeCommerceSetting.codEnabled,
    })
    .from(storeCommerceSetting)
    .where(eq(storeCommerceSetting.storeId, scope.storeId))
    .limit(1);

  const row = rows[0];
  return row ? { ...row } : null;
}

export async function isCodAvailable(
  db: CommerceQueryDatabase,
  scope: StoreScope,
): Promise<{ enabled: boolean; setting: CommerceSetting | null }> {
  if (!isCodOrdersDeploymentEnabled()) {
    return { enabled: false, setting: null };
  }

  const setting = await readCommerceSetting(db, scope);

  return {
    enabled: Boolean(setting?.codEnabled),
    setting,
  };
}

type CartRow = typeof cart.$inferSelect;

async function findActiveCart(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    cartId?: string;
    forUpdate?: boolean;
  },
): Promise<CartRow | null> {
  assertStoreScope(scope);

  const conditions = [
    eq(cart.storeId, scope.storeId),
    eq(cart.connectionId, input.connectionId),
    eq(cart.telegramUserId, input.telegramUserId),
    inArray(cart.status, [...ACTIVE_CART_STATUSES]),
  ];

  if (input.cartId) {
    conditions.push(eq(cart.id, input.cartId));
  }

  const base = queryBuilder(db)
    .select()
    .from(cart)
    .where(and(...conditions))
    .orderBy(desc(cart.createdAt))
    .limit(1);

  const rows = input.forUpdate ? await base.for("update") : await base;
  return rows[0] ?? null;
}

/**
 * Finds the single active cart for a buyer inside the verified store scope,
 * independent of which verified managed connection created it.
 */
async function findActiveCartForBuyer(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  input: {
    telegramUserId: number;
    cartId?: string;
    forUpdate?: boolean;
  },
): Promise<CartRow | null> {
  assertStoreScope(scope);

  const conditions = [
    eq(cart.storeId, scope.storeId),
    eq(cart.telegramUserId, input.telegramUserId),
    inArray(cart.status, [...ACTIVE_CART_STATUSES]),
  ];

  if (input.cartId) {
    conditions.push(eq(cart.id, input.cartId));
  }

  const base = queryBuilder(db)
    .select()
    .from(cart)
    .where(and(...conditions))
    .orderBy(desc(cart.createdAt))
    .limit(1);

  const rows = input.forUpdate ? await base.for("update") : await base;
  return rows[0] ?? null;
}

/**
 * Serializes cart recovery per store + buyer inside the caller's transaction.
 * The advisory lock is released on commit/rollback, so a concurrent add/retry
 * cannot race the abandonment and re-creation of the active cart.
 */
async function lockCartScope(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  telegramUserId: number,
): Promise<void> {
  const key = `${scope.storeId}:${telegramUserId}`;
  await queryBuilder(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function getOrCreateActiveCart(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    telegramChatId: number;
  },
): Promise<CartRow> {
  assertStoreScope(scope);

  await lockCartScope(db, scope, input.telegramUserId);

  let existing = await findActiveCartForBuyer(db, scope, {
    telegramUserId: input.telegramUserId,
    forUpdate: true,
  });

  if (existing && existing.connectionId !== input.connectionId) {
    // A verified replacement managed connection is now serving this buyer.
    // Abandon the unconfirmed cart from the old connection without carrying
    // personal details, checkout keys or quotes into the new cart.
    await queryBuilder(db)
      .update(cart)
      .set({
        status: "abandoned",
        checkoutState: "cart",
        checkoutKey: null,
        customerName: null,
        customerPhone: null,
        deliveryAddress: null,
        quoteSubtotal: null,
        quoteDeliveryFee: null,
        quoteTotal: null,
        quoteCurrency: null,
        quoteSnapshot: null,
        quotedAt: null,
      })
      .where(eq(cart.id, existing.id));

    existing = null;
  }

  if (!existing) {
    await queryBuilder(db)
      .insert(cart)
      .values({
        storeId: scope.storeId,
        connectionId: input.connectionId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
      })
      .onConflictDoNothing();

    existing = await findActiveCartForBuyer(db, scope, {
      telegramUserId: input.telegramUserId,
      forUpdate: true,
    });
  }

  if (!existing || existing.connectionId !== input.connectionId) {
    throw new Error("Active cart could not be created");
  }

  return existing;
}

async function loadSettingOrFail(
  db: CommerceQueryDatabase,
  scope: StoreScope,
): Promise<CommerceSetting> {
  const setting = await readCommerceSetting(db, scope);

  if (!setting || !setting.codEnabled || !isCodOrdersDeploymentEnabled()) {
    throw new Error("COD is not enabled for this store");
  }

  return setting;
}

async function loadCartLines(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  cartRow: CartRow,
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<{
  lines: CartLine[];
  subtotalCents: number;
  unavailable: string[];
  inventoryAvailable: Map<string, number>;
}> {
  const items = await queryBuilder(db)
    .select({
      productId: cartItem.productId,
      quantity: cartItem.quantity,
    })
    .from(cartItem)
    .where(eq(cartItem.cartId, cartRow.id))
    .orderBy(cartItem.productId);

  const lines: CartLine[] = [];
  const unavailable: string[] = [];
  const inventoryAvailable = new Map<string, number>();
  let subtotalCents = 0;

  for (const item of items) {
    const product = await readManagedProduct(
      db as unknown as Database,
      scope,
      item.productId,
      catalogContentPlan,
    );

    if (!product) {
      unavailable.push(item.productId);
      lines.push({
        productId: item.productId,
        name: "Unavailable item",
        description: null,
        categoryId: "",
        quantity: item.quantity,
        unitPrice: "0.00",
        lineTotal: "0.00",
        available: false,
      });
      continue;
    }

    const inventoryRows = await queryBuilder(db)
      .select({
        onHand: productInventory.onHand,
        reserved: productInventory.reserved,
      })
      .from(productInventory)
      .where(
        and(
          eq(productInventory.productId, item.productId),
          eq(productInventory.storeId, scope.storeId),
        ),
      )
      .limit(1);

    const inventory = inventoryRows[0];

    if (!inventory) {
      unavailable.push(item.productId);
      lines.push({
        productId: item.productId,
        name: product.name,
        description: product.description,
        categoryId: product.categoryId,
        quantity: item.quantity,
        unitPrice: product.price,
        lineTotal: formatMoney(centsFromMoney(product.price) * item.quantity),
        available: false,
      });
      continue;
    }

    const available = inventory.onHand - inventory.reserved;
    inventoryAvailable.set(item.productId, available);

    const unitCents = centsFromMoney(product.price);
    const lineCents = unitCents * item.quantity;
    subtotalCents += lineCents;

    lines.push({
      productId: item.productId,
      name: product.name,
      description: product.description,
      categoryId: product.categoryId,
      quantity: item.quantity,
      unitPrice: product.price,
      lineTotal: formatMoney(lineCents),
      available: available >= item.quantity,
    });
  }

  return { lines, subtotalCents, unavailable, inventoryAvailable };
}

async function buildCartView(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  cartRow: CartRow,
): Promise<CartView> {
  const setting = await readCommerceSetting(db, scope);
  const { lines, subtotalCents } = await loadCartLines(db, scope, cartRow);
  const deliveryFee = setting?.deliveryFee ?? "0.00";

  return {
    id: cartRow.id,
    status: cartRow.status as CartView["status"],
    checkoutState: cartRow.checkoutState as CartView["checkoutState"],
    currency: setting?.currency ?? cartRow.quoteCurrency ?? "",
    itemCount: lines.reduce((total, line) => total + line.quantity, 0),
    lines,
    subtotal: formatMoney(subtotalCents),
    deliveryFee,
    total: formatMoney(subtotalCents + centsFromMoney(deliveryFee)),
    unavailableCount: lines.filter((line) => !line.available).length,
    customerName: cartRow.customerName,
    customerPhone: cartRow.customerPhone,
    deliveryAddress: cartRow.deliveryAddress,
    quoteVersion: cartRow.quoteVersion,
  };
}

async function quoteCart(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  cartRow: CartRow,
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<{
  review: CheckoutReview;
  nextVersion: number;
  setting: CommerceSetting;
  available: Map<string, number>;
}> {
  const setting = await loadSettingOrFail(db, scope);
  const { lines, subtotalCents, unavailable, inventoryAvailable } =
    await loadCartLines(db, scope, cartRow, catalogContentPlan);

  if (unavailable.length > 0) {
    throw new CartQuoteError("item_unavailable", unavailable[0]);
  }

  if (lines.length === 0) {
    throw new CartQuoteError("empty_cart");
  }

  const short = lines.find(
    (line) => (inventoryAvailable.get(line.productId) ?? 0) < line.quantity,
  );

  if (short) {
    throw new CartQuoteError("insufficient_stock", short.productId);
  }

  const deliveryFeeCents = centsFromMoney(setting.deliveryFee);
  const review: CheckoutReview = {
    cartId: cartRow.id,
    quoteVersion: cartRow.quoteVersion + 1,
    currency: setting.currency,
    lines,
    subtotal: formatMoney(subtotalCents),
    deliveryFee: setting.deliveryFee,
    total: formatMoney(subtotalCents + deliveryFeeCents),
    customerName: cartRow.customerName ?? "",
    customerPhone: cartRow.customerPhone ?? "",
    deliveryAddress: cartRow.deliveryAddress ?? "",
  };

  return {
    review,
    nextVersion: cartRow.quoteVersion + 1,
    setting,
    available: inventoryAvailable,
  };
}

export class CartQuoteError extends Error {
  readonly reason:
    | "empty_cart"
    | "item_unavailable"
    | "insufficient_stock"
    | "cod_unavailable";
  readonly productId?: string;

  constructor(
    reason:
      | "empty_cart"
      | "item_unavailable"
      | "insufficient_stock"
      | "cod_unavailable",
    productId?: string,
  ) {
    super(reason);
    this.name = "CartQuoteError";
    this.reason = reason;
    this.productId = productId;
  }
}

export type AddToCartResult =
  | { status: "added"; cart: CartView }
  | { status: "connection_stale" }
  | { status: "unavailable" }
  | { status: "out_of_stock" }
  | { status: "invalid_quantity" }
  | { status: "cod_unavailable" };

export async function addToCart(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    telegramChatId: number;
    productId: string;
    quantity: number;
  },
): Promise<AddToCartResult> {
  assertStoreScope(scope);

  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_LINE_QUANTITY
  ) {
    return { status: "invalid_quantity" };
  }

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "connection_stale" };
    }

    const setting = await readCommerceSetting(tx, scope);
    if (!setting?.codEnabled || !isCodOrdersDeploymentEnabled()) {
      return { status: "cod_unavailable" };
    }

    const product = await readManagedProduct(
      tx as unknown as Database,
      scope,
      input.productId,
    );

    if (!product) return { status: "unavailable" };

    const [inventory] = await tx
      .select()
      .from(productInventory)
      .where(
        and(
          eq(productInventory.productId, input.productId),
          eq(productInventory.storeId, scope.storeId),
        ),
      )
      .limit(1);

    if (!inventory) return { status: "unavailable" };
    if (inventory.onHand - inventory.reserved <= 0) {
      return { status: "out_of_stock" };
    }

    const activeCart = await getOrCreateActiveCart(tx, scope, input);

    if (activeCart.status === "checkout") {
      await tx
        .update(cart)
        .set({
          status: "open",
          checkoutState: "cart",
          checkoutKey: null,
          quoteSubtotal: null,
          quoteDeliveryFee: null,
          quoteTotal: null,
          quoteCurrency: null,
          quoteSnapshot: null,
          quotedAt: null,
          quoteVersion: sql`${cart.quoteVersion} + 1`,
        })
        .where(eq(cart.id, activeCart.id));
    }

    await tx
      .insert(cartItem)
      .values({
        cartId: activeCart.id,
        productId: input.productId,
        quantity: Math.min(input.quantity, MAX_LINE_QUANTITY),
      })
      .onConflictDoUpdate({
        target: [cartItem.cartId, cartItem.productId],
        set: {
          quantity: sql`least(${cartItem.quantity} + ${input.quantity}, ${MAX_LINE_QUANTITY})`,
          updatedAt: new Date(),
        },
      });

    const refreshed = await findActiveCart(tx, scope, input);
    if (!refreshed) throw new Error("Cart disappeared after update");

    return {
      status: "added",
      cart: await buildCartView(tx, scope, refreshed),
    };
  });
}

export type CartActionResult =
  | { status: "updated"; cart: CartView }
  | { status: "empty" }
  | { status: "not_found" }
  | { status: "invalid_quantity" };

export async function changeCartQuantity(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    productId: string;
    delta: number;
  },
): Promise<CartActionResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const activeCart = await findActiveCart(tx, scope, {
      ...input,
      forUpdate: true,
    });

    if (!activeCart) return { status: "not_found" };

    const [item] = await tx
      .select()
      .from(cartItem)
      .where(
        and(
          eq(cartItem.cartId, activeCart.id),
          eq(cartItem.productId, input.productId),
        ),
      )
      .limit(1);

    if (!item) return { status: "not_found" };

    const nextQuantity = item.quantity + input.delta;
    if (nextQuantity > MAX_LINE_QUANTITY) return { status: "invalid_quantity" };

    await resetCheckoutForEdit(tx, activeCart.id);

    if (nextQuantity <= 0) {
      await tx.delete(cartItem).where(eq(cartItem.id, item.id));
    } else {
      await tx
        .update(cartItem)
        .set({ quantity: nextQuantity, updatedAt: new Date() })
        .where(eq(cartItem.id, item.id));
    }

    const [remaining] = await tx
      .select({ id: cartItem.id })
      .from(cartItem)
      .where(eq(cartItem.cartId, activeCart.id))
      .limit(1);

    if (!remaining) {
      return { status: "empty" };
    }

    const refreshed = await findActiveCart(tx, scope, input);
    if (!refreshed) throw new Error("Cart disappeared after update");

    return { status: "updated", cart: await buildCartView(tx, scope, refreshed) };
  });
}

export async function removeCartItem(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    productId: string;
  },
): Promise<CartActionResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const activeCart = await findActiveCart(tx, scope, {
      ...input,
      forUpdate: true,
    });

    if (!activeCart) return { status: "not_found" };

    await resetCheckoutForEdit(tx, activeCart.id);
    await tx
      .delete(cartItem)
      .where(
        and(
          eq(cartItem.cartId, activeCart.id),
          eq(cartItem.productId, input.productId),
        ),
      );

    const [remaining] = await tx
      .select({ id: cartItem.id })
      .from(cartItem)
      .where(eq(cartItem.cartId, activeCart.id))
      .limit(1);

    if (!remaining) return { status: "empty" };

    const refreshed = await findActiveCart(tx, scope, input);
    if (!refreshed) throw new Error("Cart disappeared after update");

    return { status: "updated", cart: await buildCartView(tx, scope, refreshed) };
  });
}

async function resetCheckoutForEdit(
  db: CommerceQueryDatabase,
  cartId: string,
): Promise<void> {
  await queryBuilder(db)
    .update(cart)
    .set({
      status: "open",
      checkoutState: "cart",
      checkoutKey: null,
      quoteSubtotal: null,
      quoteDeliveryFee: null,
      quoteTotal: null,
      quoteCurrency: null,
      quoteSnapshot: null,
      quotedAt: null,
      quoteVersion: sql`${cart.quoteVersion} + 1`,
    })
    .where(eq(cart.id, cartId));
}

export type StartCheckoutResult =
  | { status: "ready"; cart: CartView }
  | { status: "empty" }
  | { status: "not_found" }
  | { status: "item_unavailable"; productId: string }
  | { status: "insufficient_stock"; productId: string }
  | { status: "cod_unavailable" };

export async function startCheckout(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
    profileName?: string;
  },
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<StartCheckoutResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const cartRow = await findActiveCart(tx, scope, {
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId,
      cartId: input.cartId,
      forUpdate: true,
    });

    if (!cartRow) return { status: "not_found" };

    try {
      const quoted = await quoteCart(tx, scope, cartRow, catalogContentPlan);
      const profileName = normalizeCustomerName(input.profileName);
      const customerName =
        cartRow.customerName ?? profileName ?? null;

      await tx
        .update(cart)
        .set({
          status: "checkout",
          checkoutState: "awaiting_phone",
          checkoutKey: cartRow.checkoutKey ?? crypto.randomUUID(),
          customerName,
          quoteSubtotal: quoted.review.subtotal,
          quoteDeliveryFee: quoted.review.deliveryFee,
          quoteTotal: quoted.review.total,
          quoteCurrency: quoted.review.currency,
          quoteSnapshot: quoteSnapshotFor(quoted.review.lines),
          quotedAt: new Date(),
          quoteVersion: quoted.nextVersion,
        })
        .where(eq(cart.id, cartRow.id));

      const refreshed = await findActiveCart(tx, scope, {
        connectionId: input.connectionId,
        telegramUserId: input.telegramUserId,
        cartId: cartRow.id,
      });

      if (!refreshed) throw new Error("Cart disappeared after checkout start");

      return { status: "ready", cart: await buildCartView(tx, scope, refreshed) };
    } catch (error) {
      if (error instanceof CartQuoteError) {
        if (error.reason === "empty_cart") return { status: "empty" };
        if (error.reason === "cod_unavailable") {
          return { status: "cod_unavailable" };
        }
        return {
          status: error.reason,
          productId: error.productId,
        } as StartCheckoutResult;
      }
      throw error;
    }
  });
}

export type SaveContactResult =
  | { status: "saved"; cart: CartView }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "wrong_state" };

export async function savePhone(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
    phone: unknown;
  },
): Promise<SaveContactResult> {
  assertStoreScope(scope);
  const phone = normalizePhone(input.phone);
  if (!phone) return { status: "invalid" };

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const cartRow = await findActiveCart(tx, scope, {
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId,
      cartId: input.cartId,
      forUpdate: true,
    });

    if (!cartRow || cartRow.status !== "checkout") {
      return { status: "not_found" };
    }

    if (cartRow.checkoutState !== "awaiting_phone") {
      return { status: "wrong_state" };
    }

    await tx
      .update(cart)
      .set({
        customerPhone: phone,
        checkoutState: "awaiting_address",
      })
      .where(eq(cart.id, cartRow.id));

    const refreshed = await findActiveCart(tx, scope, input);
    if (!refreshed) throw new Error("Cart disappeared after phone save");

    return { status: "saved", cart: await buildCartView(tx, scope, refreshed) };
  });
}

export type AddressResult =
  | { status: "review"; review: CheckoutReview; cart: CartView }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "wrong_state" }
  | { status: "item_unavailable"; productId: string }
  | { status: "insufficient_stock"; productId: string }
  | { status: "empty" };

export async function saveAddressAndPrepareReview(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
    address: unknown;
  },
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<AddressResult> {
  assertStoreScope(scope);
  const address = normalizeAddress(input.address);
  if (!address) return { status: "invalid" };

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const cartRow = await findActiveCart(tx, scope, {
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId,
      cartId: input.cartId,
      forUpdate: true,
    });

    if (!cartRow || cartRow.status !== "checkout") {
      return { status: "not_found" };
    }

    if (cartRow.checkoutState !== "awaiting_address") {
      return { status: "wrong_state" };
    }

    const withAddress = { ...cartRow, deliveryAddress: address };

    try {
      const quoted = await quoteCart(tx, scope, withAddress, catalogContentPlan);

      await tx
        .update(cart)
        .set({
          deliveryAddress: address,
          checkoutState: "review",
          quoteSubtotal: quoted.review.subtotal,
          quoteDeliveryFee: quoted.review.deliveryFee,
          quoteTotal: quoted.review.total,
          quoteCurrency: quoted.review.currency,
          quoteSnapshot: quoteSnapshotFor(quoted.review.lines),
          quotedAt: new Date(),
          quoteVersion: quoted.nextVersion,
        })
        .where(eq(cart.id, cartRow.id));

      const refreshed = await findActiveCart(tx, scope, input);
      if (!refreshed) throw new Error("Cart disappeared after address save");

      return {
        status: "review",
        review: { ...quoted.review, deliveryAddress: address },
        cart: await buildCartView(tx, scope, refreshed),
      };
    } catch (error) {
      if (error instanceof CartQuoteError) {
        if (error.reason === "empty_cart") return { status: "empty" };
        if (error.reason === "cod_unavailable") {
          return { status: "not_found" };
        }
        return {
          status: error.reason,
          productId: error.productId,
        } as AddressResult;
      }
      throw error;
    }
  });
}

export type PrepareReviewResult =
  | { status: "review"; review: CheckoutReview }
  | { status: "not_found" }
  | { status: "wrong_state" }
  | { status: "item_unavailable"; productId: string }
  | { status: "insufficient_stock"; productId: string }
  | { status: "empty" };

export async function refreshReview(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
  },
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<PrepareReviewResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "not_found" };
    }

    const cartRow = await findActiveCart(tx, scope, {
      ...input,
      forUpdate: true,
    });

    if (!cartRow || cartRow.status !== "checkout") {
      return { status: "not_found" };
    }

    try {
      const quoted = await quoteCart(tx, scope, cartRow, catalogContentPlan);

      await tx
        .update(cart)
        .set({
          checkoutState: "review",
          quoteSubtotal: quoted.review.subtotal,
          quoteDeliveryFee: quoted.review.deliveryFee,
          quoteTotal: quoted.review.total,
          quoteCurrency: quoted.review.currency,
          quoteSnapshot: quoteSnapshotFor(quoted.review.lines),
          quotedAt: new Date(),
          quoteVersion: quoted.nextVersion,
        })
        .where(eq(cart.id, cartRow.id));

      return { status: "review", review: quoted.review };
    } catch (error) {
      if (error instanceof CartQuoteError) {
        if (error.reason === "empty_cart") return { status: "empty" };
        if (error.reason === "cod_unavailable") return { status: "not_found" };
        return {
          status: error.reason,
          productId: error.productId,
        } as PrepareReviewResult;
      }
      throw error;
    }
  });
}

export async function confirmCodOrder(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
    telegramChatId: number;
    expectedQuoteVersion: number;
  },
  catalogContentPlan?: ManagedCatalogContentPlan,
): Promise<ConfirmOrderResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return { status: "connection_stale" };
    }

    const [cartRow] = await tx
      .select()
      .from(cart)
      .where(
        and(
          eq(cart.id, input.cartId),
          eq(cart.storeId, scope.storeId),
          eq(cart.connectionId, input.connectionId),
          eq(cart.telegramUserId, input.telegramUserId),
        ),
      )
      .limit(1)
      .for("update");

    if (!cartRow) return { status: "not_found" };

    if (cartRow.status === "converted") {
      const existing = await findOrderByCheckoutKey(tx, scope, cartRow.checkoutKey);
      return existing
        ? { ...existing, status: "already_placed" as const }
        : { status: "not_found" };
    }

    if (cartRow.status !== "checkout" || cartRow.checkoutState !== "review") {
      return { status: "invalid_state" };
    }

    if (!cartRow.customerName) return { status: "missing_details", missing: "name" };
    if (!cartRow.customerPhone) return { status: "missing_details", missing: "phone" };
    if (!cartRow.deliveryAddress) {
      return { status: "missing_details", missing: "address" };
    }

    let quoted: Awaited<ReturnType<typeof quoteCart>>;

    try {
      quoted = await quoteCart(tx, scope, cartRow, catalogContentPlan);
    } catch (error) {
      if (error instanceof CartQuoteError) {
        if (error.reason === "cod_unavailable") {
          return { status: "cod_unavailable" };
        }
        if (error.reason === "insufficient_stock") {
          return {
            status: "insufficient_stock",
            productId: error.productId ?? "",
          };
        }
        return {
          status: "item_unavailable",
          productId: error.productId ?? "",
        };
      }
      throw error;
    }

    const expectedVersion = Number.isInteger(input.expectedQuoteVersion)
      ? input.expectedQuoteVersion
      : -1;

    const quoteChanged =
      expectedVersion !== cartRow.quoteVersion ||
      cartRow.quoteSubtotal !== quoted.review.subtotal ||
      cartRow.quoteDeliveryFee !== quoted.review.deliveryFee ||
      cartRow.quoteTotal !== quoted.review.total ||
      cartRow.quoteCurrency !== quoted.review.currency ||
      cartRow.customerName !== quoted.review.customerName ||
      cartRow.customerPhone !== quoted.review.customerPhone ||
      cartRow.deliveryAddress !== quoted.review.deliveryAddress ||
      !quoteSnapshotMatches(cartRow.quoteSnapshot, quoted.review.lines);

    if (quoteChanged) {
      await tx
        .update(cart)
        .set({
          checkoutState: "review",
          quoteSubtotal: quoted.review.subtotal,
          quoteDeliveryFee: quoted.review.deliveryFee,
          quoteTotal: quoted.review.total,
          quoteCurrency: quoted.review.currency,
          quoteSnapshot: quoteSnapshotFor(quoted.review.lines),
          quotedAt: new Date(),
          quoteVersion: quoted.nextVersion,
        })
        .where(eq(cart.id, cartRow.id));

      return { status: "stale_quote", review: quoted.review };
    }

    const productIds = quoted.review.lines.map((line) => line.productId).sort();

    const inventoryRows = await tx
      .select({
        productId: productInventory.productId,
        onHand: productInventory.onHand,
        reserved: productInventory.reserved,
      })
      .from(productInventory)
      .where(
        and(
          eq(productInventory.storeId, scope.storeId),
          inArray(productInventory.productId, productIds),
        ),
      )
      .orderBy(productInventory.productId)
      .for("update");

    if (inventoryRows.length !== productIds.length) {
      return { status: "item_unavailable", productId: "" };
    }

    const inventoryByProduct = new Map(
      inventoryRows.map((row) => [row.productId, row]),
    );

    for (const line of quoted.review.lines) {
      const inventory = inventoryByProduct.get(line.productId);
      if (!inventory || inventory.onHand - inventory.reserved < line.quantity) {
        return { status: "insufficient_stock", productId: line.productId };
      }
    }

    const checkoutKey = cartRow.checkoutKey ?? crypto.randomUUID();
    const inserted = await insertOrderWithReference(tx, {
      cartRow,
      checkoutKey,
      review: quoted.review,
      scope,
      chatId: input.telegramChatId,
    });

    if (!inserted) {
      const existing = await findOrderByCheckoutKey(tx, scope, checkoutKey);
      if (existing) {
        return { ...existing, status: "already_placed" as const };
      }
      throw new Error("Order could not be created");
    }

    const orderRows = quoted.review.lines.map((line) => ({
      orderId: inserted.orderId,
      productId: line.productId,
      productName: line.name,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      lineTotal: line.lineTotal,
      productSnapshot: {
        name: line.name,
        description: line.description,
        categoryId: line.categoryId,
        unitPrice: line.unitPrice,
        currency: quoted.review.currency,
      },
    }));

    const itemRows = await tx
      .insert(orderItem)
      .values(orderRows)
      .returning({ id: orderItem.id, productId: orderItem.productId });

    const itemByProduct = new Map(itemRows.map((row) => [row.productId, row.id]));

    await tx.insert(inventoryReservation).values(
      quoted.review.lines.map((line) => ({
        orderId: inserted.orderId,
        orderItemId: itemByProduct.get(line.productId)!,
        productId: line.productId,
        storeId: scope.storeId,
        quantity: line.quantity,
        status: "reserved" as const,
      })),
    );

    for (const line of quoted.review.lines) {
      await tx
        .update(productInventory)
        .set({
          reserved: sql`${productInventory.reserved} + ${line.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(productInventory.productId, line.productId),
            eq(productInventory.storeId, scope.storeId),
          ),
        );
    }

    await tx
      .update(cart)
      .set({
        status: "converted",
        checkoutKey,
      })
      .where(eq(cart.id, cartRow.id));

    return {
      status: "placed",
      reference: inserted.reference,
      orderId: inserted.orderId,
      subtotal: quoted.review.subtotal,
      deliveryFee: quoted.review.deliveryFee,
      total: quoted.review.total,
      currency: quoted.review.currency,
    };
  });
}

async function insertOrderWithReference(
  db: CommerceTransaction,
  input: {
    cartRow: CartRow;
    checkoutKey: string;
    review: CheckoutReview;
    scope: StoreScope;
    chatId: number;
  },
): Promise<{ orderId: string; reference: string } | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = generateOrderReference();
    const [row] = await db
      .insert(orderTable)
      .values({
        storeId: input.scope.storeId,
        connectionId: input.cartRow.connectionId,
        telegramUserId: input.cartRow.telegramUserId,
        telegramChatId: input.chatId,
        reference,
        checkoutKey: input.checkoutKey,
        status: "placed",
        paymentMethod: "cod",
        paymentStatus: "awaiting_collection",
        fulfillmentStatus: "unfulfilled",
        currency: input.review.currency,
        subtotal: input.review.subtotal,
        deliveryFee: input.review.deliveryFee,
        total: input.review.total,
        customerName: input.review.customerName,
        customerPhone: input.review.customerPhone,
        deliveryAddress: input.review.deliveryAddress,
      })
      .onConflictDoNothing({ target: orderTable.reference })
      .returning({ id: orderTable.id, reference: orderTable.reference });

    if (row) return { orderId: row.id, reference: row.reference };
  }

  return null;
}

async function findOrderByCheckoutKey(
  db: CommerceTransaction,
  scope: StoreScope,
  checkoutKey: string | null,
): Promise<OrderReceipt | null> {
  if (!checkoutKey) return null;

  const [row] = await db
    .select({
      orderId: orderTable.id,
      reference: orderTable.reference,
      subtotal: orderTable.subtotal,
      deliveryFee: orderTable.deliveryFee,
      total: orderTable.total,
      currency: orderTable.currency,
    })
    .from(orderTable)
    .where(
      and(
        eq(orderTable.storeId, scope.storeId),
        eq(orderTable.checkoutKey, checkoutKey),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function readCartForBuyer(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  input: {
    connectionId: string;
    telegramUserId: number;
    cartId?: string;
  },
): Promise<CartView | null> {
  const cartRow = await findActiveCart(db, scope, input);
  if (!cartRow) return null;
  return buildCartView(db, scope, cartRow);
}


export async function readInventoryAvailability(
  db: CommerceQueryDatabase,
  scope: StoreScope,
  productIds: string[],
): Promise<Map<string, number>> {
  assertStoreScope(scope);
  if (productIds.length === 0) return new Map();

  const rows = await queryBuilder(db)
    .select({
      productId: productInventory.productId,
      onHand: productInventory.onHand,
      reserved: productInventory.reserved,
    })
    .from(productInventory)
    .where(
      and(
        eq(productInventory.storeId, scope.storeId),
        inArray(productInventory.productId, productIds),
      ),
    );

  return new Map(
    rows.map((row) => [row.productId, Math.max(0, row.onHand - row.reserved)]),
  );
}

export async function backToCart(
  db: TransactionDatabase,
  scope: StoreScope,
  input: {
    cartId: string;
    connectionId: string;
    telegramUserId: number;
  },
): Promise<CartView | null> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    if (!(await connectionIsCurrent(tx, scope, input.connectionId))) {
      return null;
    }

    const cartRow = await findActiveCart(tx, scope, {
      ...input,
      forUpdate: true,
    });

    if (!cartRow) return null;

    await resetCheckoutForEdit(tx, cartRow.id);

    const refreshed = await findActiveCart(tx, scope, input);
    if (!refreshed) return null;
    return buildCartView(tx, scope, refreshed);
  });
}

const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MerchantOrderRow = typeof orderTable.$inferSelect;

function orderProgress(
  row: MerchantOrderRow,
  releasedQuantity = 0,
  shippedQuantity = 0,
): MerchantOrderProgress {
  return {
    orderId: row.id,
    reference: row.reference,
    orderStatus: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
    paymentStatus: row.paymentStatus,
    cancellationReason: row.cancellationReason,
    releasedQuantity,
    shippedQuantity,
  };
}

/**
 * Locates an order only inside the merchant's trusted store scope and locks the
 * row for the rest of the transaction. A client-supplied order id is a
 * locator, never an authorization input: an id from another store is reported
 * exactly like an unknown id.
 */
async function readMerchantOrderForUpdate(
  db: CommerceTransaction,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderRow | null> {
  assertStoreScope(scope);

  if (!ORDER_ID_PATTERN.test(orderId)) return null;

  const rows = await db
    .select()
    .from(orderTable)
    .where(
      and(
        eq(orderTable.id, orderId),
        eq(orderTable.storeId, scope.storeId),
      ),
    )
    .limit(1)
    .for("update");

  return rows[0] ?? null;
}

function invalidOrderTransition(
  row: MerchantOrderRow,
): MerchantOrderMutationResult {
  return {
    status: "invalid_transition",
    currentStatus: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
  };
}

/**
 * Merchant acceptance: placed -> accepted. Repeating the same request after a
 * successful acceptance is safe and does not move the timestamp.
 */
export async function acceptMerchantOrder(
  db: TransactionDatabase,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, orderId);
    if (!row) return { status: "not_found" };

    if (row.fulfillmentStatus !== "unfulfilled") {
      return invalidOrderTransition(row);
    }

    if (row.status === "accepted") {
      return { status: "already_applied", ...orderProgress(row) };
    }

    if (row.status !== "placed") return invalidOrderTransition(row);

    const now = new Date();
    const [updated] = await tx
      .update(orderTable)
      .set({ status: "accepted", acceptedAt: now, updatedAt: now })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
          eq(orderTable.status, "placed"),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order acceptance could not be persisted");

    return { status: "accepted", ...orderProgress(updated) };
  });
}

/**
 * Merchant preparation: accepted -> preparing. Preparation is refused until
 * acceptance has been recorded, and a retry after success is a no-op.
 */
export async function prepareMerchantOrder(
  db: TransactionDatabase,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, orderId);
    if (!row) return { status: "not_found" };

    if (row.fulfillmentStatus !== "unfulfilled") {
      return invalidOrderTransition(row);
    }

    if (row.status === "preparing") {
      return { status: "already_applied", ...orderProgress(row) };
    }

    if (row.status !== "accepted") return invalidOrderTransition(row);

    const now = new Date();
    const [updated] = await tx
      .update(orderTable)
      .set({ status: "preparing", preparingAt: now, updatedAt: now })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
          eq(orderTable.status, "accepted"),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order preparation could not be persisted");

    return { status: "preparing", ...orderProgress(updated) };
  });
}

/**
 * Merchant handoff: preparing + reserved -> handed_to_shipping + committed.
 *
 * The order row is locked first, so a retry or a concurrent cancellation and
 * handoff serialize. Only the transaction that observes a still-unfulfilled
 * order commits each reservation and removes the shipped quantity from both
 * `on_hand` and `reserved`; every later request is a no-op. Delivery and COD
 * collection never touch inventory.
 */
export async function handMerchantOrderToShipping(
  db: TransactionDatabase,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, orderId);
    if (!row) return { status: "not_found" };

    if (row.status === "cancelled" || row.fulfillmentStatus === "cancelled") {
      return invalidOrderTransition(row);
    }

    if (
      row.fulfillmentStatus === "handed_to_shipping" ||
      row.fulfillmentStatus === "delivered"
    ) {
      return { status: "already_applied", ...orderProgress(row) };
    }

    if (!canHandMerchantOrderToShipping(row.status, row.fulfillmentStatus)) {
      return invalidOrderTransition(row);
    }

    const items = await tx
      .select({
        productId: orderItem.productId,
        quantity: orderItem.quantity,
      })
      .from(orderItem)
      .where(eq(orderItem.orderId, row.id))
      .orderBy(orderItem.productId);

    const reservations = await tx
      .select({
        id: inventoryReservation.id,
        productId: inventoryReservation.productId,
        quantity: inventoryReservation.quantity,
        status: inventoryReservation.status,
      })
      .from(inventoryReservation)
      .where(
        and(
          eq(inventoryReservation.orderId, row.id),
          eq(inventoryReservation.storeId, scope.storeId),
        ),
      )
      .orderBy(inventoryReservation.productId)
      .for("update");

    if (items.length === 0 || reservations.length !== items.length) {
      throw new Error("Order reservations do not match its items");
    }

    for (const [index, reservation] of reservations.entries()) {
      const item = items[index];

      if (
        reservation.status !== "reserved" ||
        reservation.productId !== item.productId ||
        reservation.quantity !== item.quantity
      ) {
        throw new Error("Order reservation is not holdable for shipping");
      }
    }

    const now = new Date();
    let shippedQuantity = 0;

    for (const reservation of reservations) {
      const [committed] = await tx
        .update(inventoryReservation)
        .set({
          status: "committed",
          committedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(inventoryReservation.id, reservation.id),
            eq(inventoryReservation.status, "reserved"),
          ),
        )
        .returning({ quantity: inventoryReservation.quantity });

      if (!committed) {
        throw new Error("Inventory reservation could not be committed");
      }

      const [inventory] = await tx
        .update(productInventory)
        .set({
          onHand: sql`${productInventory.onHand} - ${committed.quantity}`,
          reserved: sql`${productInventory.reserved} - ${committed.quantity}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productInventory.productId, reservation.productId),
            eq(productInventory.storeId, scope.storeId),
            gte(productInventory.onHand, committed.quantity),
            gte(productInventory.reserved, committed.quantity),
          ),
        )
        .returning({ productId: productInventory.productId });

      if (!inventory) {
        throw new Error("Inventory reservation does not match held stock");
      }

      shippedQuantity += committed.quantity;
    }

    const [updated] = await tx
      .update(orderTable)
      .set({
        fulfillmentStatus: "handed_to_shipping",
        handedToShippingAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
          eq(orderTable.status, "preparing"),
          eq(orderTable.fulfillmentStatus, "unfulfilled"),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order handoff could not be persisted");

    return {
      status: "handed_to_shipping",
      ...orderProgress(updated, 0, shippedQuantity),
    };
  });
}

/**
 * Delivery can only follow a handoff to shipping. It records the delivery
 * timestamp and leaves payment and inventory untouched.
 */
export async function markMerchantOrderDelivered(
  db: TransactionDatabase,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, orderId);
    if (!row) return { status: "not_found" };

    if (row.status === "cancelled" || row.fulfillmentStatus === "cancelled") {
      return invalidOrderTransition(row);
    }

    if (row.fulfillmentStatus === "delivered") {
      return { status: "already_applied", ...orderProgress(row) };
    }

    if (!canMarkMerchantOrderDelivered(row.status, row.fulfillmentStatus)) {
      return invalidOrderTransition(row);
    }

    const now = new Date();
    const [updated] = await tx
      .update(orderTable)
      .set({
        fulfillmentStatus: "delivered",
        deliveredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
          eq(orderTable.fulfillmentStatus, "handed_to_shipping"),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order delivery could not be persisted");

    return { status: "delivered", ...orderProgress(updated) };
  });
}

/**
 * COD collection can only be recorded after delivery and only changes payment
 * state. It never changes fulfillment, reservations or inventory.
 */
export async function collectMerchantOrderPayment(
  db: TransactionDatabase,
  scope: StoreScope,
  orderId: string,
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, orderId);
    if (!row) return { status: "not_found" };

    if (row.status === "cancelled" || row.fulfillmentStatus === "cancelled") {
      return invalidOrderTransition(row);
    }

    if (row.paymentStatus === "collected") {
      return row.fulfillmentStatus === "delivered"
        ? { status: "already_applied", ...orderProgress(row) }
        : invalidOrderTransition(row);
    }

    if (
      !canRecordMerchantOrderCollection(
        row.fulfillmentStatus,
        row.paymentStatus,
      )
    ) {
      return invalidOrderTransition(row);
    }

    const now = new Date();
    const [updated] = await tx
      .update(orderTable)
      .set({
        paymentStatus: "collected",
        paymentCollectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
          eq(orderTable.fulfillmentStatus, "delivered"),
          eq(orderTable.paymentStatus, "awaiting_collection"),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order collection could not be persisted");

    return { status: "collected", ...orderProgress(updated) };
  });
}

/**
 * Pre-shipment cancellation with a required reason. The order row is locked
 * first, so concurrent retries serialize: exactly one transaction releases the
 * reservations and decrements `reserved`; the other observes `cancelled` and
 * changes nothing.
 *
 * `on_hand` is deliberately untouched. Nothing was physically removed from the
 * store before shipment, so only the hold is returned to available stock.
 */
export async function cancelMerchantOrder(
  db: TransactionDatabase,
  scope: StoreScope,
  input: { orderId: string; reason: unknown },
): Promise<MerchantOrderMutationResult> {
  assertStoreScope(scope);

  const reason = normalizeCancellationReason(input.reason);
  if (!reason) return { status: "invalid_reason" };

  return db.transaction(async (tx) => {
    const row = await readMerchantOrderForUpdate(tx, scope, input.orderId);
    if (!row) return { status: "not_found" };

    if (row.status === "cancelled") {
      return { status: "already_applied", ...orderProgress(row) };
    }

    if (!canCancelMerchantOrder(row.status, row.fulfillmentStatus)) {
      return invalidOrderTransition(row);
    }

    const reservations = await tx
      .select({
        id: inventoryReservation.id,
        productId: inventoryReservation.productId,
        quantity: inventoryReservation.quantity,
        status: inventoryReservation.status,
      })
      .from(inventoryReservation)
      .where(
        and(
          eq(inventoryReservation.orderId, row.id),
          eq(inventoryReservation.storeId, scope.storeId),
        ),
      )
      .orderBy(inventoryReservation.productId)
      .for("update");

    if (reservations.some((reservation) => reservation.status === "committed")) {
      return invalidOrderTransition(row);
    }

    const now = new Date();
    let releasedQuantity = 0;

    for (const reservation of reservations) {
      if (reservation.status !== "reserved") continue;

      const [released] = await tx
        .update(inventoryReservation)
        .set({
          status: "released",
          releasedAt: now,
          releaseReason: reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(inventoryReservation.id, reservation.id),
            eq(inventoryReservation.status, "reserved"),
          ),
        )
        .returning({ quantity: inventoryReservation.quantity });

      if (!released) {
        throw new Error("Inventory reservation could not be released");
      }

      const [inventory] = await tx
        .update(productInventory)
        .set({
          reserved: sql`${productInventory.reserved} - ${released.quantity}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productInventory.productId, reservation.productId),
            eq(productInventory.storeId, scope.storeId),
            gte(productInventory.reserved, released.quantity),
          ),
        )
        .returning({ productId: productInventory.productId });

      if (!inventory) {
        throw new Error("Inventory reservation does not match held stock");
      }

      releasedQuantity += released.quantity;
    }

    const [updated] = await tx
      .update(orderTable)
      .set({
        status: "cancelled",
        fulfillmentStatus: "cancelled",
        cancellationReason: reason,
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orderTable.id, row.id),
          eq(orderTable.storeId, scope.storeId),
        ),
      )
      .returning();

    if (!updated) throw new Error("Order cancellation could not be persisted");

    return {
      status: "cancelled",
      ...orderProgress(updated, releasedQuantity),
    };
  });
}

export type MerchantOrderAttention = {
  id: string;
  reference: string;
  total: string;
  currency: string;
  placedAt: Date;
};

export async function listMerchantOrdersAwaitingAcceptance(
  db: Database,
  scope: StoreScope,
  limit = 20,
): Promise<MerchantOrderAttention[]> {
  assertStoreScope(scope);

  return db
    .select({
      id: orderTable.id,
      reference: orderTable.reference,
      total: orderTable.total,
      currency: orderTable.currency,
      placedAt: orderTable.placedAt,
    })
    .from(orderTable)
    .where(
      and(
        eq(orderTable.storeId, scope.storeId),
        eq(orderTable.paymentMethod, "cod"),
        eq(orderTable.status, "placed"),
        eq(orderTable.fulfillmentStatus, "unfulfilled"),
      ),
    )
    .orderBy(
      desc(orderTable.placedAt),
      desc(orderTable.createdAt),
      desc(orderTable.id),
    )
    .limit(Math.min(Math.max(1, limit), 50));
}

export async function listMerchantOrders(
  db: Database,
  scope: StoreScope,
  limit = 100,
): Promise<MerchantOrder[]> {
  assertStoreScope(scope);

  const orders = await db
    .select()
    .from(orderTable)
    .where(eq(orderTable.storeId, scope.storeId))
    .orderBy(
      desc(orderTable.placedAt),
      desc(orderTable.createdAt),
      desc(orderTable.id),
    )
    .limit(Math.min(Math.max(1, limit), 200));

  if (orders.length === 0) return [];

  const orderIds = orders.map((row) => row.id);

  const [items, reservations] = await Promise.all([
    db
      .select()
      .from(orderItem)
      .where(inArray(orderItem.orderId, orderIds))
      .orderBy(orderItem.orderId, orderItem.productName),
    db
      .select({
        orderId: inventoryReservation.orderId,
        status: inventoryReservation.status,
      })
      .from(inventoryReservation)
      .where(inArray(inventoryReservation.orderId, orderIds)),
  ]);

  const itemsByOrder = new Map<string, MerchantOrderItem[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item.orderId) ?? [];
    list.push({
      productId: item.productId,
      name: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      snapshot: item.productSnapshot,
    });
    itemsByOrder.set(item.orderId, list);
  }

  const reservationsByOrder = new Map<string, string[]>();
  for (const reservation of reservations) {
    const list = reservationsByOrder.get(reservation.orderId) ?? [];
    list.push(reservation.status);
    reservationsByOrder.set(reservation.orderId, list);
  }

  return orders.map((row) => ({
    id: row.id,
    reference: row.reference,
    placedAt: row.placedAt,
    status: row.status,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    currency: row.currency,
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    total: row.total,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    deliveryAddress: row.deliveryAddress,
    acceptedAt: row.acceptedAt,
    preparingAt: row.preparingAt,
    handedToShippingAt: row.handedToShippingAt,
    deliveredAt: row.deliveredAt,
    paymentCollectedAt: row.paymentCollectedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    items: itemsByOrder.get(row.id) ?? [],
    reservationStatuses: reservationsByOrder.get(row.id) ?? [],
  }));
}
