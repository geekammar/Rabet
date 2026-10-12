import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import {
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  pgErrorCode,
  uniqueLanguageCode,
  type TestDatabase,
} from "./helpers";

/**
 * The catalog hierarchy (DATA_MODEL.md §4): a recursive `category` tree whose
 * integrity is enforced by the database — a self-parent, a cycle, a deleted
 * ancestor or a duplicate sibling order cannot be written by anything,
 * including a buggy admin tool.
 *
 * Categories are pure navigation: they carry no price and no buttons, which
 * live on products. Deleting a category with live children or products is
 * blocked rather than silently orphaning them.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("catalog");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

/** Inserts a category and returns its id. */
async function insertCategory(values: {
  id?: string;
  parentId?: string | null;
  slug: string;
  sortOrder?: number;
  isActive?: boolean;
  deletedAt?: Date | null;
}) {
  const inserted = await testDb!.db
    .insert(category)
    .values({
      id: values.id as never,
      parentId: values.parentId ?? null,
      slug: values.slug,
      sortOrder: values.sortOrder ?? nextOrder(),
      isActive: values.isActive ?? false,
      deletedAt: values.deletedAt ?? null,
    })
    .returning({ id: category.id });

  return inserted[0].id;
}

describe.skipIf(!shouldRun)("catalog hierarchy", () => {
  it("stores root and nested categories to arbitrary depth", async () => {
    const root = await insertCategory({ slug: "digital-products" });
    const design = await insertCategory({ slug: "design", parentId: root });
    const websites = await insertCategory({ slug: "design.websites", parentId: design });
    const landing = await insertCategory({
      slug: "design.websites.landing",
      parentId: websites,
    });

    // A recursive CTE resolves the whole depth, exactly as the bot's read path
    // does — and nothing in the schema capped it.
    const rows = await testDb!.db.execute<{ depth: number }>(sql`
      with recursive chain(id, depth) as (
        select id, 0 from category where parent_id is null and slug = 'digital-products'
        union all
        select c.id, chain.depth + 1
          from category c join chain on c.parent_id = chain.id
      )
      select depth from chain where id = ${landing} order by depth
    `);

    expect(rows[0].depth).toBe(3);
    expect([root, design, websites, landing]).toHaveLength(4);
  });

  it("rejects a category parented on itself", async () => {
    const id = await insertCategory({ slug: "self-parent" });

    await expect(
      testDb!.db
        .update(category)
        .set({ parentId: id })
        .where(eq(category.id, id)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    expect(pgErrorCode).toBeDefined();
  });

  it("rejects a cycle: a category cannot become its own descendant's child", async () => {
    const grandparent = await insertCategory({ slug: "cycle-root" });
    const parent = await insertCategory({ slug: "cycle-mid", parentId: grandparent });
    const child = await insertCategory({ slug: "cycle-leaf", parentId: parent });

    // Re-parenting the top of the branch under its own leaf is a cycle.
    await expect(
      testDb!.db
        .update(category)
        .set({ parentId: child })
        .where(eq(category.id, grandparent)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    // The tree is unchanged: the update was rejected, not partially applied.
    const rows = await testDb!.db.query.category.findMany({
      where: eq(category.parentId, child),
    });

    expect(rows).toHaveLength(0);
  });

  it("rejects pointing a category at a soft-deleted parent", async () => {
    const deleted = await insertCategory({
      slug: "tombstone",
      deletedAt: new Date(),
    });
    const live = await insertCategory({ slug: "under-tombstone" });

    await expect(
      testDb!.db
        .update(category)
        .set({ parentId: deleted })
        .where(eq(category.id, live)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("enforces unique sort order among children of the same parent", async () => {
    const parent = await insertCategory({ slug: "ordered" });
    await insertCategory({ slug: "ordered.a", parentId: parent, sortOrder: 0 });
    await insertCategory({ slug: "ordered.b", parentId: parent, sortOrder: 1 });

    // A second child at order 1 collides on the partial unique index.
    await expect(
      insertCategory({ slug: "ordered.c", parentId: parent, sortOrder: 1 }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // And roots are protected too — a plain UNIQUE (parent_id, sort_order)
    // would not cover them, because their parent is NULL. The root index is
    // unique across *every* root in the table, so the fixture takes a fresh
    // order that no earlier root in this database uses, then collides on it.
    const rootOrder = nextOrder();
    await insertCategory({ slug: "root-a", sortOrder: rootOrder });
    await expect(
      insertCategory({ slug: "root-b", sortOrder: rootOrder }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("blocks deleting a category that still has children", async () => {
    const parent = await insertCategory({ slug: "has-children" });
    await insertCategory({ slug: "has-children.child", parentId: parent });

    // `ON DELETE RESTRICT`: the seller must re-parent the children explicitly
    // rather than silently orphaning products under them. PostgreSQL reports a
    // RESTRICT block as `integrity_constraint_violation` (23001).
    await expect(
      testDb!.db.delete(category).where(eq(category.id, parent)),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
  });

  it("keeps category translations unique per language and cascades on delete", async () => {
    const english = (
      await testDb!.db
        .insert(language)
        .values({ code: uniqueLanguageCode(), label: "English", isEnabled: true })
        .returning({ id: language.id })
    )[0].id;
    const arabic = (
      await testDb!.db
        .insert(language)
        .values({
          code: uniqueLanguageCode(),
          label: "العربية",
          textDirection: "rtl",
        })
        .returning({ id: language.id })
    )[0].id;

    const categoryId = await insertCategory({ slug: "translated" });

    await testDb!.db.insert(categoryTranslation).values([
      { categoryId, languageId: english, name: "Websites" },
      { categoryId, languageId: arabic, name: "مواقع" },
    ]);

    // A second English row for the same category is not allowed.
    await expect(
      testDb!.db
        .insert(categoryTranslation)
        .values({ categoryId, languageId: english, name: "Websites again" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // Deleting the category takes its translations with it.
    await testDb!.db.delete(category).where(eq(category.id, categoryId));

    const remaining = await testDb!.db.query.categoryTranslation.findMany({
      where: eq(categoryTranslation.categoryId, categoryId),
    });

    expect(remaining).toHaveLength(0);
  });
});

describe.skipIf(!shouldRun)("products and translations", () => {
  it("stores a displayed price and rejects a negative one", async () => {
    const categoryId = (
      await testDb!.db
        .insert(category)
        .values({
          slug: "products-category",
          isActive: true,
          sortOrder: nextOrder(),
        })
        .returning({ id: category.id })
    )[0].id;

    const inserted = await testDb!.db
      .insert(product)
      .values({
        categoryId,
        slug: "website-design.landing",
        price: "120.50",
        isActive: true,
      })
      .returning();

    expect(inserted[0].price).toBe("120.50");
    expect(inserted[0].isActive).toBe(true);

    // A displayed price is a quote, never a charge — but it may not be
    // negative.
    await expect(
      testDb!.db.insert(product).values({
        categoryId,
        slug: "negative-price",
        price: "-1.00",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("blocks deleting a category that still holds products", async () => {
    const categoryId = (
      await testDb!.db
        .insert(category)
        .values({ slug: "holds-products", sortOrder: nextOrder() })
        .returning({ id: category.id })
    )[0].id;

    await testDb!.db.insert(product).values({
      categoryId,
      slug: "held-product",
      price: "10.00",
    });

    // `ON DELETE RESTRICT`: a category holding products is not deletable until
    // the products are re-parented. PostgreSQL reports a RESTRICT block as
    // `integrity_constraint_violation` (23001).
    await expect(
      testDb!.db.delete(category).where(eq(category.id, categoryId)),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
  });

  it("keeps product translations unique per language", async () => {
    const english = (
      await testDb!.db
        .insert(language)
        .values({ code: uniqueLanguageCode(), label: "English" })
        .returning({ id: language.id })
    )[0].id;
    const categoryId = (
      await testDb!.db
        .insert(category)
        .values({ slug: "translation-category", sortOrder: nextOrder() })
        .returning({ id: category.id })
    )[0].id;
    const productId = (
      await testDb!.db
        .insert(product)
        .values({ categoryId, slug: "translated-product", price: "5.00" })
        .returning({ id: product.id })
    )[0].id;

    await testDb!.db.insert(productTranslation).values({
      productId,
      languageId: english,
      name: "Landing Page",
      description: "Short",
      details: "Long-form details shown by SHOW_DETAILS.",
    });

    await expect(
      testDb!.db.insert(productTranslation).values({
        productId,
        languageId: english,
        name: "Duplicate",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
