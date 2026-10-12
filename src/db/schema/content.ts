import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { language } from "./settings";

/**
 * `message_template` — the editable global bot strings.
 *
 * Templates are keyed by a stable code identifier the code references
 * (`inquiry_received`, `empty_menu`, …) rather than by id, so a rename in the
 * dashboard can never break a handler, and a new bot string is added by
 * referencing a new key. This is the localization surface for every bot-facing
 * message that is not product-specific content (DATA_MODEL.md §2).
 *
 * The optional `description` is an admin aid: it tells the seller, in the one
 * dashboard form that edits these, where each string is actually used. It
 * carries no runtime meaning and defaults to nothing.
 */
export const messageTemplate = pgTable("message_template", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * `message_translation` — the per-language body for a template.
 *
 * One row per template per language, resolved at read time through the single
 * English-first fallback chain shared by every translatable entity
 * (DATA_MODEL.md §7). The body is capped at Telegram's message-text limit,
 * the same bound `inquiry_message.body` uses, because every one of these
 * strings is rendered inside a Telegram message.
 */
export const messageTranslation = pgTable(
  "message_translation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplate.id, { onDelete: "cascade" }),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("message_translation_template_language_idx").on(
      table.templateId,
      table.languageId,
    ),
    check(
      "message_translation_body_length_check",
      sql`length(${table.body}) <= 4096`,
    ),
  ],
);
