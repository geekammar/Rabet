import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { store } from "./tenant";

/**
 * `merchant_notification_bot` — one outbound-only Telegram notification bot
 * per store, configured by the store owner.
 *
 * This is deliberately separate from `telegram_connection` (the buyer-facing
 * managed store bot) and from the operator-owned singleton
 * `seller_notification_setting`. A merchant may connect a different bot here
 * without touching the customer-facing storefront bot or the environment
 * token used by the operator.
 *
 * Security model:
 * - The bot token is encrypted at rest by `connection-secrets.ts` (AES-256-GCM,
 *   environment-owned key). The raw token is never returned to a browser, a
 *   page, a Server Action result or a log line.
 * - `store_id` is unique: a store has at most one notification bot.
 * - `bot_id` is unique: the same Telegram bot cannot be connected to two
 *   stores at the same time, which prevents a cross-store destination leak.
 * - Only a numeric private chat id is accepted as a destination.
 * - Pairing is short-lived: only the SHA-256 digest of a random code is
 *   stored, together with an expiry. A successful pairing clears the digest.
 * - `pairing_update_offset` is the next Telegram update id to request. It
 *   lets repeated checks move through a backlog in bounded batches without
 *   dropping an update before it has been evaluated for the active challenge.
 * - `config_epoch` changes on every token save and pairing change. A test
 *   send records its epoch and can only persist verification while that exact
 *   configuration is still current, even if the bot and chat ids are unchanged.
 */

export const merchantNotificationBot = pgTable(
  "merchant_notification_bot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    botId: bigint("bot_id", { mode: "number" }).notNull(),
    botUsername: text("bot_username").notNull(),
    botName: text("bot_name"),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenKeyId: text("token_key_id").notNull(),
    destinationChatId: text("destination_chat_id"),
    destinationChatTitle: text("destination_chat_title"),
    destinationChatUsername: text("destination_chat_username"),
    pairingCodeHash: text("pairing_code_hash"),
    pairingExpiresAt: timestamp("pairing_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    pairingUpdateOffset: bigint("pairing_update_offset", { mode: "number" }),
    configEpoch: uuid("config_epoch").notNull().defaultRandom(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    lastTestAt: timestamp("last_test_at", {
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
    uniqueIndex("merchant_notification_bot_store_unique").on(table.storeId),
    uniqueIndex("merchant_notification_bot_bot_id_unique").on(table.botId),
    check(
      "merchant_notification_bot_bot_id_positive_check",
      sql`${table.botId} > 0`,
    ),
    check(
      "merchant_notification_bot_bot_username_format_check",
      sql`${table.botUsername} ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$'`,
    ),
    check(
      "merchant_notification_bot_token_not_empty_check",
      sql`btrim(${table.tokenCiphertext}) <> ''`,
    ),
    check(
      "merchant_notification_bot_token_key_id_format_check",
      sql`${table.tokenKeyId} ~ '^[A-Za-z0-9._-]{1,32}$'`,
    ),
    check(
      "merchant_notification_bot_destination_chat_id_format_check",
      sql`${table.destinationChatId} IS NULL OR ${table.destinationChatId} ~ '^[1-9][0-9]{4,19}$'`,
    ),
    check(
      "merchant_notification_bot_pairing_state_check",
      sql`(
        (${table.pairingCodeHash} IS NULL
          AND ${table.pairingExpiresAt} IS NULL)
        OR
        (${table.pairingCodeHash} IS NOT NULL
          AND ${table.pairingExpiresAt} IS NOT NULL)
      )`,
    ),
    check(
      "merchant_notification_bot_pairing_hash_format_check",
      sql`${table.pairingCodeHash} IS NULL OR ${table.pairingCodeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "merchant_notification_bot_pairing_update_offset_check",
      sql`${table.pairingUpdateOffset} IS NULL OR ${table.pairingUpdateOffset} >= 1`,
    ),
    check(
      "merchant_notification_bot_verified_requires_destination_check",
      sql`${table.verifiedAt} IS NULL OR ${table.destinationChatId} IS NOT NULL`,
    ),
  ],
);
