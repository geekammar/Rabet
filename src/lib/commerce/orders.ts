import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  cart,
  cartItem,
  inventoryReservation,
  order as orderTable,
  orderItem,
  productInventory,
  storeCommerceSetting,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import { readManagedProduct } from "@/lib/catalog/managed-storefront";
import {
  assertStoreScope,
  type StoreScope,
} from "@/lib/data/store-scope";
import { isCodOrdersDeploymentEnabled } from "./feature";

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
  items: MerchantOrderItem[];
  reservationStatuses: string[];
};

function queryBuilder(db: CommerceQueryDatabase): Database {
  return db as unknown as Database;
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

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
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

  await queryBuilder(db)
    .insert(cart)
    .values({
      storeId: scope.storeId,
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId,
      telegramChatId: input.telegramChatId,
    })
    .onConflictDoNothing();

  const existing = await findActiveCart(db, scope, input);

  if (!existing) {
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
): Promise<{
  review: CheckoutReview;
  nextVersion: number;
  setting: CommerceSetting;
  available: Map<string, number>;
}> {
  const setting = await loadSettingOrFail(db, scope);
  const { lines, subtotalCents, unavailable, inventoryAvailable } =
    await loadCartLines(db, scope, cartRow);

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
): Promise<StartCheckoutResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const cartRow = await findActiveCart(tx, scope, {
      connectionId: input.connectionId,
      telegramUserId: input.telegramUserId,
      cartId: input.cartId,
      forUpdate: true,
    });

    if (!cartRow) return { status: "not_found" };

    try {
      const quoted = await quoteCart(tx, scope, cartRow);
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
): Promise<AddressResult> {
  assertStoreScope(scope);
  const address = normalizeAddress(input.address);
  if (!address) return { status: "invalid" };

  return db.transaction(async (tx) => {
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
      const quoted = await quoteCart(tx, scope, withAddress);

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
): Promise<PrepareReviewResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
    const cartRow = await findActiveCart(tx, scope, {
      ...input,
      forUpdate: true,
    });

    if (!cartRow || cartRow.status !== "checkout") {
      return { status: "not_found" };
    }

    try {
      const quoted = await quoteCart(tx, scope, cartRow);

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
): Promise<ConfirmOrderResult> {
  assertStoreScope(scope);

  return db.transaction(async (tx) => {
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
      quoted = await quoteCart(tx, scope, cartRow);
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
    .orderBy(desc(orderTable.placedAt))
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
    items: itemsByOrder.get(row.id) ?? [],
    reservationStatuses: reservationsByOrder.get(row.id) ?? [],
  }));
}
