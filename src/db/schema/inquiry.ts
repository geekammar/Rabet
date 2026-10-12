import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { customer } from "./customer";
import { product } from "./catalog";

/**
 * The unified conversation model (DATA_MODEL.md §9).
 *
 * One customer ↔ seller conversation is one `inquiry` row, covering **both** a
 * product inquiry (started by `START_INQUIRY`, `product_id` set, price and
 * selected path frozen) and general support (started by `OPEN_SUPPORT`,
 * `product_id` `NULL`, configurable category). They share one table, one
 * message table, one reply flow and one dashboard inbox; duplicating those
 * systems is explicitly avoided.
 */

export const inquiryStatusEnum = pgEnum("inquiry_status", [
  "open",
  "waiting_on_customer",
  "resolved",
  "closed",
]);

export const messageAuthorEnum = pgEnum("message_author", ["customer", "admin"]);

export const messageDeliveryEnum = pgEnum("message_delivery", [
  "pending",
  "sent",
  "failed",
]);

/**
 * `inquiry` — one thread, plus the immutable context the customer saw.
 *
 * **Mutable menus, immutable conversation context.** The button tree, the
 * price and the product text are all live and editable at any time, so
 * anything the customer has already sent to the seller is **frozen** at
 * inquiry time: `productSnapshot` and `selectedOptions` are write-once — an
 * `UPDATE` on either is rejected by the `inquiry_freeze_context` trigger (see
 * `drizzle/0001_tree_and_snapshot_integrity.sql`). A conversation therefore
 * always quotes the price the customer actually saw and the options the
 * customer actually picked, no matter how the seller re-prices or restructures
 * the catalog afterwards.
 *
 * **Resume by construction.** A unique partial index permits at most one active
 * inquiry per customer per product, so a repeat `START_INQUIRY` tap re-opens
 * the existing thread instead of creating a duplicate, without a
 * lookup-then-insert race.
 */
export const inquiry = pgTable(
  "inquiry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // `RESTRICT`: conversations outlive account state — a customer row cannot
    // be deleted while its inquiry history exists.
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "restrict" }),
    // `NULL` = general support. `SET NULL`: deleting a product keeps the
    // conversation readable through its frozen snapshot.
    productId: uuid("product_id").references(() => product.id, {
      onDelete: "set null",
    }),
    // Short quotable id, generated server-side so it can be quoted without
    // leaking a uuid.
    reference: text("reference").notNull().unique(),
    status: inquiryStatusEnum("status").notNull().default("open"),
    // General support only; validated against `bot_setting.support_category`
    // in the write path (a `CHECK` cannot read another table).
    category: text("category"),
    // Frozen at creation: product name, price, currency, category path.
    productSnapshot: jsonb("product_snapshot").notNull(),
    // Frozen at creation: the button path the customer took, recovered from
    // the action's own ancestor chain — e.g.
    // `["Choose Options","Design","Landing Page","Basic"]`.
    selectedOptions: jsonb("selected_options"),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inquiry_customer_status_idx").on(table.customerId, table.status),
    // At most one active inquiry per customer per product. Partial because
    // only active statuses participate, and note a general-support inquiry
    // (`product_id IS NULL`) is not deduplicated here — Postgres treats a
    // `NULL` product as distinct — so resuming a general conversation is a
    // write-path concern, by design (DATA_MODEL.md §9.2).
    uniqueIndex("inquiry_active_per_customer_product_idx")
      .on(table.customerId, table.productId)
      .where(sql`status IN ('open', 'waiting_on_customer')`),
  ],
);

/**
 * `inquiry_message` — one message on a thread, plus delivery state.
 *
 * Append-only: no `UPDATE` path exists for `body` or `author`; only the
 * `delivery_*` columns change, and only `pending → sent | failed`.
 *
 * `UNIQUE (inquiry_id, telegram_message_id)` is **message-level dedup**: a
 * redelivered Telegram update cannot double-post a customer message. It is the
 * second site of the one-row-lock idempotency pattern; the third is the active
 * partial index above (DATA_MODEL.md §11.6).
 */
export const inquiryMessage = pgTable(
  "inquiry_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // A thread is one unit.
    inquiryId: uuid("inquiry_id")
      .notNull()
      .references(() => inquiry.id, { onDelete: "cascade" }),
    author: messageAuthorEnum("author").notNull(),
    // Telegram's message-text limit; longer content is split by the bot layer.
    body: text("body").notNull(),
    // Inbound: the Telegram message id. Outbound: the id of the delivered
    // message. `NULL` for an outbound message not yet accepted by Telegram.
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    deliveryStatus: messageDeliveryEnum("delivery_status")
      .notNull()
      .default("pending"),
    // The Telegram API error recorded on failure, for diagnostics and retry.
    // A failed reply is never silently dropped and never marked sent.
    deliveryError: text("delivery_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "inquiry_message_body_length_check",
      sql`length(${table.body}) <= 4096`,
    ),
    uniqueIndex("inquiry_message_telegram_message_idx").on(
      table.inquiryId,
      table.telegramMessageId,
    ),
    index("inquiry_message_thread_order_idx").on(table.inquiryId, table.createdAt),
  ],
);
