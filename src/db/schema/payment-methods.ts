import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { language } from "./settings";

/**
 * ===========================================================================
 * Central Payment Methods domain.
 * ===========================================================================
 *
 * Defines reusable payment methods that product buttons can bind to.
 * Methods are defined centrally once with localized customer-facing title and
 * instructions, and are referenced by typed product actions.
 *
 * Security & Compliance boundary:
 * Does NOT store provider credentials, bank/card secrets, or live payment data.
 * Defaults to disabled (isActive = false).
 */

export const paymentMethod = pgTable("payment_method", {
  id: uuid("id").defaultRandom().primaryKey(),
  adminLabel: text("admin_label").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const paymentMethodTranslation = pgTable(
  "payment_method_translation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentMethodId: uuid("payment_method_id")
      .notNull()
      .references(() => paymentMethod.id, { onDelete: "cascade" }),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    instructions: text("instructions"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_method_translation_method_language_idx").on(
      table.paymentMethodId,
      table.languageId,
    ),
  ],
);
