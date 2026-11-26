import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { product } from "./catalog";
import { appUser, store } from "./tenant";
import { telegramConnection } from "./telegram-connections";

/**
 * First commerce slice: cash-on-delivery orders on the managed Store Bot path.
 *
 * The design keeps commercial and stock facts separate from the cart:
 * - a cart never reserves stock; only a confirmed order holds a reservation;
 * - `on_hand` and `reserved` are distinct, and available stock is their
 *   difference;
 * - the order header and line snapshots are written once, so later catalog
 *   edits never change what the buyer confirmed;
 * - order, payment and fulfillment states are independent columns.
 *
 * COD is disabled by default. A store must have an explicit
 * `store_commerce_setting` row with `cod_enabled = true`, and the deployment
 * must opt in through `RABET_COD_ORDERS_ENABLED`.
 *
 * Manual Vodafone Cash transfers are a second, independent payment method on
 * the same order lifecycle. They are disabled by default and require both
 * `vodafone_cash_enabled = true` on the store row and the deployment opt-in
 * `RABET_MANUAL_TRANSFER_ENABLED`. A buyer's transfer claim is recorded in
 * `order_payment_claim`; it never changes payment state by itself.
 */

const CURRENCIES = sql`currency IN ('SAR', 'USD', 'AED', 'EGP')`;
const ORDER_REFERENCE = sql`reference ~ '^ORD-[A-HJ-NP-Z2-9]{6}$'`;

export const storeCommerceSetting = pgTable(
  "store_commerce_setting",
  {
    storeId: uuid("store_id")
      .primaryKey()
      .references(() => store.id, { onDelete: "restrict" }),
    currency: char("currency", { length: 3 }).notNull(),
    deliveryFee: numeric("delivery_fee", { precision: 18, scale: 2 })
      .notNull()
      .default("0.00"),
    codEnabled: boolean("cod_enabled").notNull().default(false),
    vodafoneCashEnabled: boolean("vodafone_cash_enabled")
      .notNull()
      .default(false),
    vodafoneCashNumber: text("vodafone_cash_number"),
    vodafoneCashAccountName: text("vodafone_cash_account_name"),
    vodafoneCashInstructionsAr: text("vodafone_cash_instructions_ar"),
    vodafoneCashInstructionsEn: text("vodafone_cash_instructions_en"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("store_commerce_setting_currency_allowlist_check", CURRENCIES),
    check(
      "store_commerce_setting_delivery_fee_nonnegative_check",
      sql`${table.deliveryFee} >= 0`,
    ),
    check(
      "store_commerce_setting_vodafone_cash_config_check",
      sql`(
        ${table.vodafoneCashEnabled} = false
        OR (
          ${table.vodafoneCashNumber} IS NOT NULL
          AND btrim(${table.vodafoneCashNumber}) <> ''
          AND ${table.vodafoneCashAccountName} IS NOT NULL
          AND btrim(${table.vodafoneCashAccountName}) <> ''
          AND (
            (${table.vodafoneCashInstructionsAr} IS NOT NULL
              AND btrim(${table.vodafoneCashInstructionsAr}) <> '')
            OR
            (${table.vodafoneCashInstructionsEn} IS NOT NULL
              AND btrim(${table.vodafoneCashInstructionsEn}) <> '')
          )
        )
      )`,
    ),
    check(
      "store_commerce_setting_vodafone_cash_number_length_check",
      sql`${table.vodafoneCashNumber} IS NULL
        OR char_length(${table.vodafoneCashNumber}) <= 32`,
    ),
    check(
      "store_commerce_setting_vodafone_cash_account_name_length_check",
      sql`${table.vodafoneCashAccountName} IS NULL
        OR char_length(${table.vodafoneCashAccountName}) <= 120`,
    ),
    check(
      "store_commerce_setting_vodafone_cash_instructions_length_check",
      sql`(${table.vodafoneCashInstructionsAr} IS NULL
          OR char_length(${table.vodafoneCashInstructionsAr}) <= 1000)
        AND (${table.vodafoneCashInstructionsEn} IS NULL
          OR char_length(${table.vodafoneCashInstructionsEn}) <= 1000)`,
    ),
  ],
);

export const productInventory = pgTable(
  "product_inventory",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => product.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("product_inventory_store_idx").on(table.storeId),
    check("product_inventory_on_hand_nonnegative_check", sql`${table.onHand} >= 0`),
    check("product_inventory_reserved_nonnegative_check", sql`${table.reserved} >= 0`),
    check(
      "product_inventory_reserved_within_on_hand_check",
      sql`${table.reserved} <= ${table.onHand}`,
    ),
  ],
);

export type CartStatus = "open" | "checkout" | "converted" | "abandoned";
export type CheckoutState =
  | "cart"
  | "awaiting_phone"
  | "awaiting_address"
  | "review";

export const cart = pgTable(
  "cart",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => telegramConnection.id, { onDelete: "restrict" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    status: text("status").notNull().default("open"),
    checkoutState: text("checkout_state").notNull().default("cart"),
    paymentMethod: text("payment_method").notNull().default("cod"),
    checkoutKey: uuid("checkout_key"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    deliveryAddress: text("delivery_address"),
    quoteSubtotal: numeric("quote_subtotal", { precision: 18, scale: 2 }),
    quoteDeliveryFee: numeric("quote_delivery_fee", { precision: 18, scale: 2 }),
    quoteTotal: numeric("quote_total", { precision: 18, scale: 2 }),
    quoteCurrency: char("quote_currency", { length: 3 }),
    quoteSnapshot: jsonb("quote_snapshot"),
    quoteVersion: integer("quote_version").notNull().default(0),
    quotedAt: timestamp("quoted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cart_one_active_per_store_buyer_idx")
      .on(table.storeId, table.telegramUserId)
      .where(sql`${table.status} IN ('open', 'checkout')`),
    index("cart_store_idx").on(table.storeId),
    index("cart_connection_idx").on(table.connectionId),
    index("cart_telegram_user_idx").on(table.telegramUserId),
    check(
      "cart_status_check",
      sql`${table.status} IN ('open', 'checkout', 'converted', 'abandoned')`,
    ),
    check(
      "cart_checkout_state_check",
      sql`${table.checkoutState} IN ('cart', 'awaiting_phone', 'awaiting_address', 'review')`,
    ),
    check(
      "cart_payment_method_check",
      sql`${table.paymentMethod} IN ('cod', 'vodafone_cash')`,
    ),
    check("cart_telegram_user_positive_check", sql`${table.telegramUserId} > 0`),
    check("cart_telegram_chat_positive_check", sql`${table.telegramChatId} > 0`),
    check("cart_quote_version_nonnegative_check", sql`${table.quoteVersion} >= 0`),
    check(
      "cart_quote_currency_allowlist_check",
      sql`${table.quoteCurrency} IS NULL OR ${table.quoteCurrency} IN ('SAR', 'USD', 'AED', 'EGP')`,
    ),
    check(
      "cart_quote_consistency_check",
      sql`(
        (${table.quoteSubtotal} IS NULL
          AND ${table.quoteDeliveryFee} IS NULL
          AND ${table.quoteTotal} IS NULL
          AND ${table.quoteCurrency} IS NULL
          AND ${table.quoteSnapshot} IS NULL
          AND ${table.quotedAt} IS NULL)
        OR
        (${table.quoteSubtotal} IS NOT NULL
          AND ${table.quoteDeliveryFee} IS NOT NULL
          AND ${table.quoteTotal} IS NOT NULL
          AND ${table.quoteCurrency} IS NOT NULL
          AND ${table.quoteSnapshot} IS NOT NULL
          AND ${table.quotedAt} IS NOT NULL
          AND ${table.quoteSubtotal} >= 0
          AND ${table.quoteDeliveryFee} >= 0
          AND ${table.quoteTotal} = ${table.quoteSubtotal} + ${table.quoteDeliveryFee})
      )`,
    ),
  ],
);

export const cartItem = pgTable(
  "cart_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => cart.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cart_item_cart_product_unique").on(table.cartId, table.productId),
    index("cart_item_cart_idx").on(table.cartId),
    check(
      "cart_item_quantity_check",
      sql`${table.quantity} > 0 AND ${table.quantity} <= 99`,
    ),
  ],
);

export type OrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "cancelled";
export type PaymentMethod = "cod" | "vodafone_cash";
export type PaymentStatus =
  | "awaiting_collection"
  | "collected"
  | "failed"
  | "awaiting_transfer"
  | "transfer_awaiting_review"
  | "transfer_verified"
  | "transfer_rejected";
export type TransferClaimStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";
export type FulfillmentStatus =
  | "unfulfilled"
  | "handed_to_shipping"
  | "delivered"
  | "cancelled";

export const order = pgTable(
  "order",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => telegramConnection.id, { onDelete: "restrict" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    reference: text("reference").notNull().unique(),
    checkoutKey: uuid("checkout_key").notNull(),
    status: text("status").notNull().default("placed"),
    paymentMethod: text("payment_method").notNull().default("cod"),
    paymentStatus: text("payment_status").notNull().default("awaiting_collection"),
    fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),
    currency: char("currency", { length: 3 }).notNull(),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull(),
    deliveryFee: numeric("delivery_fee", { precision: 18, scale: 2 }).notNull(),
    total: numeric("total", { precision: 18, scale: 2 }).notNull(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    deliveryAddress: text("delivery_address").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    preparingAt: timestamp("preparing_at", { withTimezone: true, mode: "date" }),
    handedToShippingAt: timestamp("handed_to_shipping_at", {
      withTimezone: true,
      mode: "date",
    }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    paymentCollectedAt: timestamp("payment_collected_at", {
      withTimezone: true,
      mode: "date",
    }),
    transferReferenceRequestedAt: timestamp("transfer_reference_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    transferPromptMessageId: bigint("transfer_prompt_message_id", {
      mode: "number",
    }),
    transferSnapshot: jsonb("transfer_snapshot"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    cancellationReason: text("cancellation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_store_checkout_key_unique").on(
      table.storeId,
      table.checkoutKey,
    ),
    index("order_store_placed_idx").on(table.storeId, table.placedAt),
    index("order_telegram_user_idx").on(table.telegramUserId),
    check("order_reference_format_check", ORDER_REFERENCE),
    check(
      "order_status_check",
      sql`${table.status} IN ('placed', 'accepted', 'preparing', 'cancelled')`,
    ),
    check(
      "order_merchant_progress_check",
      sql`(
        (${table.status} = 'placed'
          AND ${table.acceptedAt} IS NULL
          AND ${table.preparingAt} IS NULL)
        OR
        (${table.status} = 'accepted'
          AND ${table.acceptedAt} IS NOT NULL
          AND ${table.preparingAt} IS NULL)
        OR
        (${table.status} = 'preparing'
          AND ${table.acceptedAt} IS NOT NULL
          AND ${table.preparingAt} IS NOT NULL)
        OR
        (${table.status} = 'cancelled')
      )`,
    ),
    check(
      "order_cancellation_state_check",
      sql`(
        (${table.status} = 'cancelled'
          AND ${table.cancellationReason} IS NOT NULL
          AND btrim(${table.cancellationReason}) <> ''
          AND ${table.cancelledAt} IS NOT NULL)
        OR
        (${table.status} <> 'cancelled'
          AND ${table.cancellationReason} IS NULL
          AND ${table.cancelledAt} IS NULL)
      )`,
    ),
    check(
      "order_cancellation_reason_length_check",
      sql`${table.cancellationReason} IS NULL
        OR char_length(${table.cancellationReason}) BETWEEN 3 AND 300`,
    ),
    check(
      "order_payment_method_check",
      sql`${table.paymentMethod} IN ('cod', 'vodafone_cash')`,
    ),
    check(
      "order_payment_status_check",
      sql`${table.paymentStatus} IN (
        'awaiting_collection',
        'collected',
        'failed',
        'awaiting_transfer',
        'transfer_awaiting_review',
        'transfer_verified',
        'transfer_rejected'
      )`,
    ),
    check(
      "order_payment_method_status_check",
      sql`(
        (${table.paymentMethod} = 'cod'
          AND ${table.paymentStatus} IN ('awaiting_collection', 'collected', 'failed'))
        OR
        (${table.paymentMethod} = 'vodafone_cash'
          AND ${table.paymentStatus} IN (
            'awaiting_transfer',
            'transfer_awaiting_review',
            'transfer_verified',
            'transfer_rejected'
          ))
      )`,
    ),
    check(
      "order_transfer_reference_request_state_check",
      sql`(
        (${table.transferReferenceRequestedAt} IS NULL
          OR ${table.paymentMethod} = 'vodafone_cash')
        AND
        (${table.transferPromptMessageId} IS NULL
          OR (${table.paymentMethod} = 'vodafone_cash'
            AND ${table.transferPromptMessageId} > 0))
      )`,
    ),
    check(
      "order_transfer_snapshot_state_check",
      sql`(
        (${table.paymentMethod} = 'vodafone_cash'
          AND ${table.transferSnapshot} IS NOT NULL)
        OR
        (${table.paymentMethod} = 'cod'
          AND ${table.transferSnapshot} IS NULL)
      )`,
    ),
    check(
      "order_fulfillment_status_check",
      sql`${table.fulfillmentStatus} IN ('unfulfilled', 'handed_to_shipping', 'delivered', 'cancelled')`,
    ),
    check(
      "order_shipping_state_check",
      sql`(
        (${table.fulfillmentStatus} = 'unfulfilled'
          AND ${table.handedToShippingAt} IS NULL
          AND ${table.deliveredAt} IS NULL)
        OR
        (${table.fulfillmentStatus} = 'handed_to_shipping'
          AND ${table.deliveredAt} IS NULL)
        OR
        (${table.fulfillmentStatus} = 'delivered'
          AND (
            ${table.handedToShippingAt} IS NULL
            OR
            (${table.deliveredAt} IS NOT NULL
              AND ${table.deliveredAt} >= ${table.handedToShippingAt})
          ))
        OR
        (${table.fulfillmentStatus} = 'cancelled'
          AND ${table.handedToShippingAt} IS NULL
          AND ${table.deliveredAt} IS NULL)
      )`,
    ),
    check(
      "order_payment_collection_state_check",
      sql`(
        ${table.paymentStatus} = 'collected'
        OR ${table.paymentCollectedAt} IS NULL
      )`,
    ),
    check("order_currency_allowlist_check", CURRENCIES),
    check(
      "order_totals_nonnegative_check",
      sql`${table.subtotal} >= 0 AND ${table.deliveryFee} >= 0 AND ${table.total} >= 0`,
    ),
    check(
      "order_total_matches_parts_check",
      sql`${table.total} = ${table.subtotal} + ${table.deliveryFee}`,
    ),
    check("order_telegram_user_positive_check", sql`${table.telegramUserId} > 0`),
    check("order_telegram_chat_positive_check", sql`${table.telegramChatId} > 0`),
    check(
      "order_customer_name_not_empty_check",
      sql`btrim(${table.customerName}) <> ''`,
    ),
    check(
      "order_customer_phone_not_empty_check",
      sql`btrim(${table.customerPhone}) <> ''`,
    ),
    check(
      "order_delivery_address_not_empty_check",
      sql`btrim(${table.deliveryAddress}) <> ''`,
    ),
  ],
);

export const orderItem = pgTable(
  "order_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => order.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    productName: text("product_name").notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull(),
    productSnapshot: jsonb("product_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_item_order_product_unique").on(
      table.orderId,
      table.productId,
    ),
    index("order_item_order_idx").on(table.orderId),
    check("order_item_quantity_check", sql`${table.quantity} > 0`),
    check(
      "order_item_totals_nonnegative_check",
      sql`${table.unitPrice} >= 0 AND ${table.lineTotal} >= 0`,
    ),
    check(
      "order_item_line_total_check",
      sql`${table.lineTotal} = ${table.unitPrice} * ${table.quantity}`,
    ),
    check(
      "order_item_product_name_not_empty_check",
      sql`btrim(${table.productName}) <> ''`,
    ),
  ],
);

export type ReservationStatus = "reserved" | "committed" | "released";

export const inventoryReservation = pgTable(
  "inventory_reservation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => order.id, { onDelete: "restrict" }),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItem.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull().default("reserved"),
    reservedAt: timestamp("reserved_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_reservation_order_item_unique").on(table.orderItemId),
    uniqueIndex("inventory_reservation_order_product_unique").on(
      table.orderId,
      table.productId,
    ),
    index("inventory_reservation_order_idx").on(table.orderId),
    index("inventory_reservation_store_idx").on(table.storeId),
    index("inventory_reservation_product_idx").on(table.productId),
    check("inventory_reservation_quantity_check", sql`${table.quantity} > 0`),
    check(
      "inventory_reservation_status_check",
      sql`${table.status} IN ('reserved', 'committed', 'released')`,
    ),
  ],
);

/**
 * Buyer-reported manual transfer claims for one order.
 *
 * A claim is evidence supplied by the buyer, not a payment. Submitting it only
 * moves the order to `transfer_awaiting_review`; an authorized merchant must
 * verify the transfer against their own wallet before the order becomes
 * `transfer_verified`. Rejection releases the reservation and cancels the
 * order in the same transaction, so stock can never stay held for a payment
 * that will not arrive.
 *
 * The unique order id makes a repeated submission idempotent. The store/reference
 * unique index prevents the same transfer reference from being claimed against
 * two orders in one store. `decided_by` records the authenticated merchant user
 * as the decision actor.
 */
export const orderPaymentClaim = pgTable(
  "order_payment_claim",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => order.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    method: text("method").notNull().default("vodafone_cash"),
    reference: text("reference").notNull(),
    status: text("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decidedBy: uuid("decided_by").references(() => appUser.id, {
      onDelete: "restrict",
    }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("order_payment_claim_order_unique").on(table.orderId),
    uniqueIndex("order_payment_claim_store_reference_unique").on(
      table.storeId,
      table.reference,
    ),
    index("order_payment_claim_store_status_idx").on(
      table.storeId,
      table.status,
    ),
    check(
      "order_payment_claim_method_check",
      sql`${table.method} = 'vodafone_cash'`,
    ),
    check(
      "order_payment_claim_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled')`,
    ),
    check(
      "order_payment_claim_reference_length_check",
      sql`char_length(${table.reference}) BETWEEN 3 AND 80`,
    ),
    check(
      "order_payment_claim_decision_state_check",
      sql`(
        (${table.status} = 'pending'
          AND ${table.decidedAt} IS NULL
          AND ${table.decidedBy} IS NULL)
        OR
        (${table.status} IN ('approved', 'rejected')
          AND ${table.decidedAt} IS NOT NULL
          AND ${table.decidedBy} IS NOT NULL)
        OR
        (${table.status} = 'cancelled'
          AND ${table.decidedAt} IS NOT NULL
          AND ${table.decidedBy} IS NULL)
      )`,
    ),
    check(
      "order_payment_claim_decision_note_length_check",
      sql`${table.decisionNote} IS NULL
        OR char_length(${table.decisionNote}) <= 300`,
    ),
  ],
);
