import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
} from "drizzle-orm/pg-core";

import { language } from "./settings";

/**
 * ===========================================================================
 * The catalog hierarchy (one of the two recursive trees).
 * ===========================================================================
 *
 * `category` organizes products. Categories are pure navigation — they carry
 * no price and no buttons, which live on products. Browsing categories is a
 * different operation from pressing a product's buttons, and the two trees are
 * deliberately separate (ADR-014). Jumping from a button to a category is an
 * explicit, validated `NAVIGATE_CATALOG` action on the interaction tree
 * (`actions.ts`), never an implicit structural link.
 *
 * The recursion is an adjacency list: `parent_id` self-references, root rows
 * are `NULL`. Postgres recursive CTEs walk it natively, and there is **no
 * depth column and no depth CHECK** — nesting is unlimited in the data model,
 * bounded only by documented application runtime guards (DATA_MODEL.md §11.3).
 */

/**
 * `category` — self-referencing adjacency list.
 *
 * Tree integrity is enforced in the database, not only in the app:
 * - **C1** no self-parent — `CHECK (parent_id <> id)`;
 * - **C2** no cycles and no invalid parents — the `category_check_ancestry`
 *   trigger walks the ancestor chain of the new parent and rejects a cycle, a
 *   missing ancestor or a deleted ancestor (see
 *   `drizzle/0001_tree_and_snapshot_integrity.sql`);
 * - **C3** deleted ancestors are unreachable — the ancestry trigger refuses to
 *   point a node at a deleted parent and `ON DELETE RESTRICT` blocks deleting
 *   a category that still has live children, so the seller must re-parent
 *   them explicitly rather than silently orphaning products;
 * - **C4** no duplicate sibling ordering — two partial unique indexes, one for
 *   children and one for roots, because root rows have a `NULL` parent and
 *   Postgres treats `NULL`s as distinct in a unique index.
 */
export const category = pgTable(
  "category",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Annotated `PgColumn` so the self-reference type-checks without an
    // inference cycle (`category` cannot infer its own type while its
    // initializer reads `category.id`). The runtime thunk is unchanged.
    parentId: uuid("parent_id").references((): PgColumn => category.id, {
      onDelete: "restrict",
    }),
    // Stable dashboard/bot key, e.g. `design.websites.landing`.
    slug: text("slug").notNull().unique(),
    sortOrder: integer("sort_order").notNull().default(0),
    // Activation is independent of deletion: a category starts inactive and
    // nothing is customer-visible until the seller turns it on.
    isActive: boolean("is_active").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    // Maintained by the shared `touch_updated_at` trigger, not by the ORM.
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // **C1** — a `NULL` parent (root) satisfies this because `NULL <> id` is
    // `NULL`, which is not a violation.
    check("category_no_self_parent_check", sql`${table.parentId} <> ${table.id}`),
    index("category_parent_idx").on(table.parentId),
    // Partial: keeps the catalog indexes free of soft-deleted tombstones.
    index("category_active_idx")
      .on(table.isActive)
      .where(sql`deleted_at IS NULL`),
    // **C4** — children of one node may not share a sort order.
    uniqueIndex("category_sibling_sort_order_idx")
      .on(table.parentId, table.sortOrder)
      .where(sql`parent_id IS NOT NULL`),
    // **C4** — root nodes may not share a sort order either. A single
    // `UNIQUE (parent_id, sort_order)` would not protect roots, because
    // Postgres treats the `NULL` parent of every root as distinct.
    uniqueIndex("category_root_sort_order_idx")
      .on(table.sortOrder)
      .where(sql`parent_id IS NULL`),
  ],
);

/**
 * `category_translation` — per-language name and description.
 *
 * `UNIQUE (category_id, language_id)` is what makes the fallback chain
 * resolvable in one indexed read (DATA_MODEL.md §7, §13).
 */
export const categoryTranslation = pgTable(
  "category_translation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "cascade" }),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("category_translation_category_language_idx").on(
      table.categoryId,
      table.languageId,
    ),
  ],
);

/**
 * `product` — a digital good or service with a **displayed price**.
 *
 * The price is a quote shown to the customer, never a charge: there is no
 * order, no payment and no financial state anywhere in this model (ADR-013).
 * The price exists to be shown next to a product and to be frozen onto an
 * inquiry when a customer asks about it, so the conversation quotes what the
 * customer actually saw (`inquiry.productSnapshot`). Currency is global — one
 * merchant, one displayed currency, on `bot_setting.currency`.
 */
export const product = pgTable(
  "product",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // `RESTRICT`: a category holding products is not deletable until the
    // products are re-parented, so a category move can never strand products
    // the seller believes are gone.
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    price: numeric("price", { precision: 18, scale: 2 }).notNull(),
    isActive: boolean("is_active").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A displayed price may be zero (a freebie) but never negative.
    check("product_price_nonnegative_check", sql`${table.price} >= 0`),
    index("product_category_order_idx")
      .on(table.categoryId, table.sortOrder)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * `product_translation` — per-language product content.
 *
 * `description` and `details` are deliberately separate: the product card
 * shows the short text, and a `SHOW_DETAILS` button reveals the long text —
 * configurable, localized, and requiring no extra table.
 */
export const productTranslation = pgTable(
  "product_translation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "cascade" }),
    languageId: uuid("language_id")
      .notNull()
      .references(() => language.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_translation_product_language_idx").on(
      table.productId,
      table.languageId,
    ),
  ],
);
