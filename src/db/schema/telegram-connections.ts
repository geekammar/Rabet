import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { appUser, store } from "./tenant";

/**
 * Managed Telegram Store Bot connections.
 *
 * This is deliberately a separate model from the legacy environment-token bot:
 * the legacy `telegram_update` table keeps its global `update_id` uniqueness
 * and the legacy webhook keeps its current behaviour unchanged.
 *
 * A link attempt is server-owned and scoped to exactly one store and merchant.
 * The raw nonce is never stored: `nonce_digest` is the SHA-256 lookup key and
 * `nonce_ciphertext` is the AES-256-GCM value used only to re-render the
 * merchant's private deep link while the attempt is live.
 *
 * A connection is created only after the manager-bot event has been correlated
 * to exactly one pending attempt and the managed bot's own token, identity and
 * webhook have been verified. It becomes `ready` only after the signed-in
 * merchant explicitly confirms the verified bot. Exactly one active connection
 * per store and one bot id per connection are enforced by the database.
 */

export type TelegramLinkAttemptStatus =
  | "pending"
  | "provisioning"
  | "awaiting_confirmation"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

export const TELEGRAM_LINK_ATTEMPT_STATUSES: readonly TelegramLinkAttemptStatus[] =
  [
    "pending",
    "provisioning",
    "awaiting_confirmation",
    "completed",
    "expired",
    "cancelled",
    "failed",
  ];

export type TelegramConnectionStatus =
  | "provisioning"
  | "awaiting_confirmation"
  | "ready"
  | "revoked"
  | "disconnected"
  | "needs_review";

export const TELEGRAM_CONNECTION_STATUSES: readonly TelegramConnectionStatus[] =
  [
    "provisioning",
    "awaiting_confirmation",
    "ready",
    "revoked",
    "disconnected",
    "needs_review",
  ];

export type TelegramManagedUpdateStatus = "processing" | "processed" | "failed";

export const telegramLinkAttempt = pgTable(
  "telegram_link_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    merchantUserId: uuid("merchant_user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    managerBotUsername: text("manager_bot_username").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    nonceCiphertext: text("nonce_ciphertext").notNull(),
    nonceKeyId: text("nonce_key_id").notNull(),
    status: text("status").notNull().default("pending"),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    telegramBotId: bigint("telegram_bot_id", { mode: "number" }),
    telegramBotUsername: text("telegram_bot_username"),
    telegramBotName: text("telegram_bot_name"),
    connectionId: uuid("connection_id").references(
      () => telegramConnection.id,
      { onDelete: "restrict" },
    ),
    failureCode: text("failure_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" })
      .notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true, mode: "date" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_link_attempt_nonce_digest_unique").on(
      table.nonceDigest,
    ),
    index("telegram_link_attempt_store_idx").on(table.storeId),
    index("telegram_link_attempt_telegram_user_idx").on(table.telegramUserId),
    uniqueIndex("telegram_link_attempt_one_active_per_store_idx")
      .on(table.storeId)
      .where(
        sql`${table.status} IN ('pending', 'provisioning', 'awaiting_confirmation')`,
      ),
    uniqueIndex("telegram_link_attempt_one_active_per_user_idx")
      .on(table.telegramUserId)
      .where(
        sql`${table.telegramUserId} IS NOT NULL AND ${table.status} IN ('pending', 'provisioning', 'awaiting_confirmation')`,
      ),
    check(
      "telegram_link_attempt_nonce_digest_format_check",
      sql`${table.nonceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "telegram_link_attempt_status_check",
      sql`${table.status} IN ('pending', 'provisioning', 'awaiting_confirmation', 'completed', 'expired', 'cancelled', 'failed')`,
    ),
    check(
      "telegram_link_attempt_expiry_after_creation_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "telegram_link_attempt_telegram_user_positive_check",
      sql`${table.telegramUserId} IS NULL OR ${table.telegramUserId} > 0`,
    ),
    check(
      "telegram_link_attempt_telegram_bot_positive_check",
      sql`${table.telegramBotId} IS NULL OR ${table.telegramBotId} > 0`,
    ),
  ],
);

export const telegramConnection = pgTable(
  "telegram_connection",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    botId: bigint("bot_id", { mode: "number" }).notNull().unique(),
    botUsername: text("bot_username").notNull(),
    botName: text("bot_name"),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenKeyId: text("token_key_id").notNull(),
    webhookSecretHash: text("webhook_secret_hash").notNull(),
    webhookUrl: text("webhook_url").notNull(),
    status: text("status").notNull().default("provisioning"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("telegram_connection_store_idx").on(table.storeId),
    uniqueIndex("telegram_connection_one_active_per_store_idx")
      .on(table.storeId)
      .where(
        sql`${table.status} IN ('provisioning', 'awaiting_confirmation', 'ready')`,
      ),
    check(
      "telegram_connection_status_check",
      sql`${table.status} IN ('provisioning', 'awaiting_confirmation', 'ready', 'revoked', 'disconnected', 'needs_review')`,
    ),
    check(
      "telegram_connection_bot_id_positive_check",
      sql`${table.botId} > 0`,
    ),
    check(
      "telegram_connection_webhook_secret_hash_format_check",
      sql`${table.webhookSecretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "telegram_connection_webhook_url_https_check",
      sql`${table.webhookUrl} ~ '^https://'`,
    ),
  ],
);

/**
 * Per-bot Telegram update deduplication.
 *
 * Telegram update ids are per-bot, not global: two managed bots can deliver
 * the same `update_id`. `UNIQUE (bot_id, update_id)` is therefore the lock for
 * this path. The legacy `telegram_update` table and its global uniqueness are
 * untouched.
 */
export const telegramManagedUpdate = pgTable(
  "telegram_managed_update",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: bigint("bot_id", { mode: "number" }).notNull(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    updateType: text("update_type").notNull(),
    connectionId: uuid("connection_id").references(() => telegramConnection.id, {
      onDelete: "restrict",
    }),
    attemptId: uuid("attempt_id").references(() => telegramLinkAttempt.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("processing"),
    attemptToken: text("attempt_token").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_managed_update_bot_update_unique").on(
      table.botId,
      table.updateId,
    ),
    index("telegram_managed_update_status_idx").on(
      table.status,
      table.claimedAt,
    ),
    check(
      "telegram_managed_update_status_check",
      sql`${table.status} IN ('processing', 'processed', 'failed')`,
    ),
    check(
      "telegram_managed_update_update_id_positive_check",
      sql`${table.updateId} > 0`,
    ),
    check(
      "telegram_managed_update_bot_id_positive_check",
      sql`${table.botId} > 0`,
    ),
  ],
);
