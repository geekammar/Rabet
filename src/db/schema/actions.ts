import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from "drizzle-orm/pg-core";

import { category, product } from "./catalog";
import { language } from "./settings";

/**
 * ===========================================================================
 * The interaction hierarchy (the second recursive tree).
 * ===========================================================================
 *
 * Each product owns a tree of configurable buttons. Each button independently
 * has a translatable label, an action type from a closed safe allowlist, an
 * order among its siblings, an activation state, and optionally children. Root
 * buttons have `parent_action_id IS NULL`. All descendants of a root button
 * belong to that root button's product — the database enforces it (constraint
 * **A2**, below).
 *
 * This recursion is independent of the catalog tree and has its own integrity
 * rule set (ADR-014): a category groups products, a button executes an action.
 */

/**
 * The closed, safe action allowlist — the complete set of behaviours the bot
 * knows how to execute (DATA_MODEL.md §5.2). There is no arbitrary action, no
 * user-defined JavaScript or SQL, no webhook and no workflow engine: every
 * value is a fixed server-side handler behind this enum.
 *
 * Exactly one member is menu-capable (`OPEN_SUBMENU`); the other six are
 * terminal. Extending the allowlist is an implementation change — enum +
 * handler + form field — while adding a supported button or nesting level is
 * configuration only.
 */
export const actionTypeEnum = pgEnum("action_type", [
  "OPEN_SUBMENU",
  "START_INQUIRY",
  "SHOW_DETAILS",
  "SEND_TEMPLATE_MESSAGE",
  "OPEN_URL",
  "OPEN_SUPPORT",
  "NAVIGATE_CATALOG",
]);

/**
 * `product_action` — self-referencing adjacency list.
 *
 * Tree integrity, enforced in the database (constraints **A1**–**A5**):
 * - **A1** no self-parent — `CHECK (parent_action_id <> id)`;
 * - **A2** all descendants belong to the right product — the
 *   `product_action_check_ancestry` trigger walks the new parent's chain and
 *   rejects a parent from another product, and `product_id` is **immutable**
 *   (the trigger rejects changing it), so a buggy admin tool cannot build a
 *   cross-product branch;
 * - **A3** no cycles and no invalid parents — the same trigger rejects a cycle
 *   or a missing ancestor;
 * - **A4** only menu-capable nodes may have children — the trigger rejects a
 *   child whose immediate parent is not `OPEN_SUBMENU`, and a second trigger
 *   rejects changing a node's type away from `OPEN_SUBMENU` while it still has
 *   children, so unreachable child nodes are impossible to write;
 * - **A5** no duplicate sibling ordering — two partial unique indexes, one for
 *   children and one for roots.
 */
export const productAction = pgTable(
  "product_action",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The tree is wholly owned by the product: deleting a product removes its
    // tree, and no action can outlive its product.
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    // `NULL` = root button. `CASCADE`: deleting a branch is a confirmed
    // dashboard action and the cascade is exactly that. Annotated `PgColumn`
    // so the self-reference type-checks without an inference cycle.
    parentActionId: uuid("parent_action_id").references(
      (): PgColumn => productAction.id,
      {
        onDelete: "cascade",
      },
    ),
    actionType: actionTypeEnum("action_type").notNull(),
    // `OPEN_URL` only. Enforced as HTTPS at the database level so a
    // `javascript:` or `data:` URL can never be persisted at all; the
    // application validates further with the WHATWG URL parser. The URL is for
    // information pages only — never a payment or checkout redirect (ADR-013).
    url: text("url"),
    // `NAVIGATE_CATALOG` only. Real foreign keys rather than ids inside a JSON
    // column, because Postgres cannot validate a JSON-stored id; a moved or
    // deleted catalog node leaves a *configurable* button (`SET NULL`) rather
    // than a dangling one.
    navigateCategoryId: uuid("navigate_category_id").references(() => category.id, {
      onDelete: "set null",
    }),
    navigateProductId: uuid("navigate_product_id").references(() => product.id, {
      onDelete: "set null",
    }),
    // A flat, validated object and the extension point for a future action
    // type whose scalar config does not deserve a column. Never localizable
    // text, never an action type, never a parent reference — those are
    // columns. No action type requires a value here at the MVP.
    actionConfig: jsonb("action_config").notNull().default(sql`'{}'::jsonb`),
    sortOrder: integer("sort_order").notNull().default(0),
    // A button is created inside the tree editor after the seller has typed
    // its label and chosen its type, so it is born ready; the whole tree is
    // gated on `product.is_active`, which is the real publish gate.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // **A1** — a root button (`NULL` parent) satisfies this.
    check(
      "product_action_no_self_parent_check",
      sql`${table.parentActionId} <> ${table.id}`,
    ),
    // The DB-level HTTPS guarantee.
    check(
      "product_action_url_https_check",
      sql`${table.url} IS NULL OR ${table.url} ~ '^https://'`,
    ),
    // A navigation target may not be combined with any other target.
    check(
      "product_action_navigation_target_exclusive_check",
      sql`NOT (${table.navigateCategoryId} IS NOT NULL AND ${table.navigateProductId} IS NOT NULL)`,
    ),
    // Navigation targets exist only on a `NAVIGATE_CATALOG` button, so a
    // terminal button cannot carry a dangling catalog pointer. The converse —
    // a `NAVIGATE_CATALOG` button *must* have a target — is deliberately not a
    // schema constraint, so a button can be created and its target chosen as a
    // second step; the write path rejects a missing target before activation.
    check(
      "product_action_navigation_target_type_check",
      sql`${table.actionType} = 'NAVIGATE_CATALOG' OR (${table.navigateCategoryId} IS NULL AND ${table.navigateProductId} IS NULL)`,
    ),
    // The bot's main read: load a product's whole tree.
    index("product_action_tree_idx").on(table.productId, table.parentActionId),
    // **A5** — children of one node may not share a sort order.
    uniqueIndex("product_action_sibling_sort_order_idx")
      .on(table.parentActionId, table.sortOrder)
      .where(sql`parent_action_id IS NOT NULL`),
    // **A5** — root buttons of one product may not share a sort order either.
    uniqueIndex("product_action_root_sort_order_idx")
      .on(table.productId, table.sortOrder)
      .where(sql`parent_action_id IS NULL`),
  ],
);

/**
 * `product_action_translation` — per-language button label, menu text and
 * template body.
 *
 * A separate table rather than an inline `jsonb` translations column, because
 * the project's one localization mechanism is *one row per language per parent
 * entity* and reusing it means one fallback helper, one admin form shape and
 * one "default language required" rule across categories, products, buttons
 * and templates (DATA_MODEL.md §5.5). An inline column could express none of
 * `UNIQUE (action_id, language_id)`, the FK to `language`, `NOT NULL` on
 * `label` or the length check at the database level.
 */
export const productActionTranslation = pgTable(
  "product_action_translation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => productAction.id, { onDelete: "cascade" }),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "cascade" }),
    // The button text the customer sees. 64 is the practical Telegram
    // button-text limit, so a configured label can always be rendered.
    label: text("label").notNull(),
    // The optional message sent before this submenu's children
    // (`OPEN_SUBMENU` only) — how "message then more options" is one button.
    menuText: text("menu_text"),
    // The message body for `SEND_TEMPLATE_MESSAGE`.
    templateBody: text("template_body"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_action_translation_action_language_idx").on(
      table.actionId,
      table.languageId,
    ),
    check(
      "product_action_translation_label_length_check",
      sql`length(${table.label}) <= 64`,
    ),
  ],
);
