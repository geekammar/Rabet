import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
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
