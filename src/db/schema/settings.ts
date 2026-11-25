import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { store } from "./tenant";

/**
 * `bot_setting` — the single configuration row for the one bot.
 *
 * The MVP has exactly one bot, one administrator and one seller, so
 * configuration is one typed row rather than a key/value map: the schema stays
 * self-documenting and the dashboard form is one form. The singleton is
 * enforced structurally — `id` is the primary key **and** constrained to `1`,
 * so a second settings row is impossible to write (DATA_MODEL.md §4.5).
 *
 * Configurable values are deliberately kept configurable here rather than
 * baked into code, and no row is seeded by a migration: the values the seller
 * chooses (display name, support categories, reply-time copy) are data, not
 * schema, and Phase 03B inserts no production business defaults.
 *
 * `currency` is the single displayed currency for the whole catalog. The
 * allowlist is the one from the approved design; which member the seller uses
 * is a product decision recorded in DATA_MODEL.md §19.6 and is **not** fixed
 * by this schema — the column carries no default and no seed value.
 */
export const botSetting = pgTable(
  "bot_setting",
  {
    // `smallint` + `CHECK (id = 1)` forces the singleton. A default of `1`
    // keeps the single legitimate insert ergonomic.
    id: smallint("id").primaryKey().default(1),
    storeId: uuid("store_id").references(() => store.id, {
      onDelete: "restrict",
    }),
    defaultLanguageId: uuid("default_language_id")
      .notNull()
      .references(() => language.id, { onDelete: "restrict" }),
    currency: char("currency", { length: 3 }).notNull(),
    displayName: text("display_name").notNull(),
    askForLanguage: boolean("ask_for_language").notNull().default(true),
    // `text[]`, deliberately not a table: support categories are a handful of
    // short editable strings, and the array keeps them on one dashboard form
    // with no orphan rows to clean up (DATA_MODEL.md §2.1, §19.1). The values
    // are shown as typed — English only at the MVP — and the additive path to
    // a localizable table is documented for when that becomes unacceptable.
    supportCategory: text("support_category")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    supportReplyTime: text("support_reply_time"),
    // Ordered merchant choices for the five default storefront entries.
    // `NULL` means "not customized yet" and preserves the Phase 28 defaults,
    // which is why this column has no default and no migration seed. The shape
    // is validated in `src/lib/storefront/menu.ts`; malformed values fall back
    // safely at read time and never break the customer home.
    storefrontMenu: jsonb("storefront_menu"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_setting_store_idx").on(table.storeId),
    check(
      "bot_setting_singleton_check",
      sql`${table.id} = 1`,
    ),
    check(
      "bot_setting_currency_allowlist_check",
      sql`${table.currency} IN ('SAR', 'USD', 'AED', 'EGP')`,
    ),
  ],
);

/**
 * `language` — the enabled languages for bot content.
 *
 * The default language is **not** a boolean flag here; it lives in
 * `bot_setting.default_language_id`. With exactly one settings row there is
 * exactly one default, which kills the classic "two rows claim to be the
 * default" bug (DATA_MODEL.md §4.6). Disabling a language does not delete its
 * translations — they stop being offered and content falls back to the
 * default (§7).
 */
export const language = pgTable(
  "language",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // ISO 639-1 code, e.g. `en`, `ar`.
    code: char("code", { length: 2 }).notNull().unique(),
    label: text("label").notNull(),
    textDirection: text("text_direction").notNull().default("ltr"),
    // English is the default bot language and the fallback for all content,
    // so it is the one language seeded enabled. Whether the seller enables
    // Arabic is a configuration choice, not a schema one.
    isEnabled: boolean("is_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "language_text_direction_check",
      sql`${table.textDirection} IN ('ltr', 'rtl')`,
    ),
  ],
);

/**
 * `store_language_setting` — the customer-facing default language for one
 * store.
 *
 * This is additive to the legacy `bot_setting` singleton: existing stores keep
 * their configured default through that row, and a store without an explicit
 * row falls back to it. Writing here is merchant-scoped, so one store's choice
 * never changes another store.
 *
 * The reference is nullable-free but the row itself is optional, which is the
 * "not configured yet" state. A disabled language is ignored at read time so
 * disabling Arabic cleanly falls back instead of leaving buyers stuck.
 */
export const storeLanguageSetting = pgTable(
  "store_language_setting",
  {
    storeId: uuid("store_id")
      .primaryKey()
      .references(() => store.id, { onDelete: "restrict" }),
    defaultLanguageId: uuid("default_language_id")
      .notNull()
      .references(() => language.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
);

/**
 * `buyer_language_preference` — one explicit buyer choice per store.
 *
 * The trusted identity is the pair `(store_id, telegram_user_id)`. It is a
 * separate table because `customer.telegram_id` is global while a buyer may
 * talk to more than one store bot: using another store's bot must not carry
 * this preference across.
 *
 * A row is written only when the buyer explicitly selects a language. The
 * absence of a row means "use the merchant default", not "English".
 */
export const buyerLanguagePreference = pgTable(
  "buyer_language_preference",
  {
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "restrict" }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "buyer_language_preference_pk",
      columns: [table.storeId, table.telegramUserId],
    }),
    check(
      "buyer_language_preference_telegram_user_positive_check",
      sql`${table.telegramUserId} > 0`,
    ),
  ],
);
