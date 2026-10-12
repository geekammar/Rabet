import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { language } from "./settings";

/**
 * `customer` — a Telegram customer, minimal attributes only.
 *
 * Storage minimization is a design rule, not an accident (DATA_MODEL.md
 * §12.3): the table holds only what the product needs — the Telegram id, the
 * username and the names Telegram provides, a language hint, the explicitly
 * chosen language and an operational block flag. There is deliberately no
 * phone number, email, address, avatar, marketing or profiling column, and no
 * analytics table to join them into.
 *
 * Erasure: a customer's right to be forgotten is satisfied by **anonymizing**
 * this row (nulling `telegram_username`, `first_name`, `last_name`, resetting
 * `language_code` / `selected_language_id`) while **retaining** the inquiry
 * history, which is possible because inquiries reference `customer_id` rather
 * than a denormalized name.
 */
export const customer = pgTable("customer", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Telegram user ids are 64-bit; stored as `bigint` and read as a JS number,
  // which is exact for every id Telegram has ever issued (well below 2^53).
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  telegramUsername: text("telegram_username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  // The IETF language tag Telegram reports with the update (`en`, `ar`) — a
  // hint for the bot's first message, superseded once the customer chooses.
  languageCode: text("language_code"),
  // The explicitly chosen language; `NULL` until the customer picks one (or
  // immediately, when only one language is enabled).
  selectedLanguageId: uuid("selected_language_id").references(() => language.id, {
    onDelete: "set null",
  }),
  // Set when Telegram reports the bot blocked (403) on an outbound send; no
  // further sends are attempted until the customer re-engages.
  isBlocked: boolean("is_blocked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
