import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { inquiry } from "./inquiry";

export type SellerNotificationStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "cancelled";

export const SELLER_NOTIFICATION_STATUSES: SellerNotificationStatus[] = [
  "pending",
  "sending",
  "sent",
  "failed",
  "unknown",
  "cancelled",
];

/**
 * `seller_notification_setting` — Singleton configuration for the outbound
 * seller notification Telegram bot.
 *
 * Distinct singleton table from `bot_setting` so existing settings queries
 * do not select missing columns before migration, keeping pre-upgrade deployments safe.
 *
 * Security:
 * - TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN is NEVER stored here. It is read
 *   strictly from process environment at runtime.
 */
export const sellerNotificationSetting = pgTable(
  "seller_notification_setting",
  {
    id: smallint("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    // Decimal string representing seller's private Telegram chat ID
    destinationChatId: text("destination_chat_id"),
    // Notification language: 'ar' or 'en'
    language: char("language", { length: 2 }).notNull().default("ar"),
    // Verification metadata: records the verified bot and destination
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    verifiedBotId: bigint("verified_bot_id", { mode: "number" }),
    verifiedBotUsername: text("verified_bot_username"),
    verifiedChatId: text("verified_chat_id"),
    // Monotonic revision number incremented when destination or verification changes
    revision: integer("revision").notNull().default(1),
    // Persisted timestamp for test cooldown enforcement
    lastTestAt: timestamp("last_test_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "seller_notification_setting_singleton_check",
      sql`${table.id} = 1`,
    ),
    check(
      "seller_notification_setting_language_check",
      sql`${table.language} IN ('ar', 'en')`,
    ),
    check(
      "seller_notification_setting_destination_check",
      sql`${table.destinationChatId} IS NULL OR ${table.destinationChatId} ~ '^[1-9][0-9]{4,19}$'`,
    ),
  ],
);

/**
 * `seller_notification_delivery` — Small durable outbox for seller notification delivery.
 *
 * Enforces:
 * - Exactly one event per inquiry via (event_type, inquiry_id) unique constraint.
 * - Atomic claiming using claim_attempt_id and claim_expires_at lease.
 * - Configuration revision binding so destination/bot changes invalidate old pending/failed attempts.
 * - Allowlisted safe diagnostics only (never token URLs or raw customer prose).
 */
export const sellerNotificationDelivery = pgTable(
  "seller_notification_delivery",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: text("event_type").notNull().default("new_inquiry"),
    inquiryId: uuid("inquiry_id")
      .notNull()
      .references(() => inquiry.id, { onDelete: "cascade" }),
    reference: text("reference").notNull().unique(),
    revision: integer("revision").notNull(),
    destinationChatId: text("destination_chat_id").notNull(),
    status: text("status").notNull().default("pending"),
    claimAttemptId: text("claim_attempt_id"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    errorCategory: text("error_category"),
    retryAfterUntil: timestamp("retry_after_until", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("seller_notification_delivery_event_inquiry_idx").on(
      table.eventType,
      table.inquiryId,
    ),
    uniqueIndex("seller_notification_delivery_reference_unique").on(
      table.reference,
    ),
    index("seller_notification_delivery_status_idx").on(
      table.status,
      table.claimExpiresAt,
    ),
    index("seller_notification_delivery_created_at_idx").on(
      table.createdAt,
    ),
    check(
      "seller_notification_delivery_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled')`,
    ),
  ],
);
