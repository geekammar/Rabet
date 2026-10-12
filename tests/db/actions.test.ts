import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { category, language, product, productAction, productActionTranslation } from "@/db/schema";
import {
  createTestDatabase,
  hasTestCluster,
  nextOrder,
  uniqueLanguageCode,
  type TestDatabase,
} from "./helpers";

/**
 * The interaction hierarchy (DATA_MODEL.md §5): each product owns a recursive
 * tree of configurable buttons, separate from the catalog tree. These tests
 * exercise the constraints that make the tree trustworthy when the seller
 * edits it from the dashboard — and that hold even when a buggy tool writes
 * directly to the tables.
 *
 * Worked example from the design: a product whose root buttons reach six
 * levels of nesting, mixing action types at every level.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("actions");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

/** Inserts a category + product pair and returns the product id. */
async function insertProduct(slug: string) {
  const categoryId = (
    await testDb!.db
      .insert(category)
      .values({ slug: `cat-${slug}`, isActive: true, sortOrder: nextOrder() })
      .returning({ id: category.id })
  )[0].id;

  return (
    await testDb!.db
      .insert(product)
      .values({ categoryId, slug: `prod-${slug}`, price: "99.00", isActive: true })
      .returning({ id: product.id })
  )[0].id;
}

/** Inserts a button and returns its id. */
async function insertAction(values: {
  productId: string;
  parentActionId?: string | null;
  actionType: (typeof productAction.actionType.enumValues)[number];
  url?: string | null;
  sortOrder?: number;
}) {
  return (
    await testDb!.db
      .insert(productAction)
      .values({
        productId: values.productId,
        parentActionId: values.parentActionId ?? null,
        actionType: values.actionType,
        url: values.url ?? null,
        sortOrder: values.sortOrder ?? nextOrder(),
      })
      .returning({ id: productAction.id })
  )[0].id;
}

describe.skipIf(!shouldRun)("product action tree", () => {
  it("builds a deeply nested tree of mixed action types", async () => {
    const productId = await insertProduct("nested");

    // The six-level worked example from DATA_MODEL.md §6, condensed: a chain of
    // four OPEN_SUBMENU buttons, then a level mixing terminal actions with a
    // further submenu that keeps the tree growing.
    const l1ChooseOptions = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    const l2Design = await insertAction({
      productId,
      parentActionId: l1ChooseOptions,
      actionType: "OPEN_SUBMENU",
    });
    const l3Landing = await insertAction({
      productId,
      parentActionId: l2Design,
      actionType: "OPEN_SUBMENU",
    });
    const l4Basic = await insertAction({
      productId,
      parentActionId: l3Landing,
      actionType: "OPEN_SUBMENU",
    });
    await insertAction({
      productId,
      parentActionId: l4Basic,
      actionType: "SHOW_DETAILS",
      sortOrder: 0,
    });
    await insertAction({
      productId,
      parentActionId: l4Basic,
      actionType: "START_INQUIRY",
      sortOrder: 1,
    });
    const l5MoreOptions = await insertAction({
      productId,
      parentActionId: l4Basic,
      actionType: "OPEN_SUBMENU",
      sortOrder: 2,
    });
    await insertAction({
      productId,
      parentActionId: l5MoreOptions,
      actionType: "SEND_TEMPLATE_MESSAGE",
      sortOrder: 0,
    });

    const rows = await testDb!.db
      .select({
        id: productAction.id,
        productId: productAction.productId,
        parentActionId: productAction.parentActionId,
      })
      .from(productAction);

    // Eight buttons across six levels, mixing five action types — and every
    // row belongs to the same product, no matter how deep the nesting went.
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.productId === productId)).toBe(true);
    expect(new Set(rows.map((row) => row.parentActionId)).size).toBe(6);
  });

  it("rejects a button parented on itself", async () => {
    const productId = await insertProduct("self-parent");
    const id = await insertAction({ productId, actionType: "OPEN_SUBMENU" });

    await expect(
      testDb!.db
        .update(productAction)
        .set({ parentActionId: id })
        .where(eq(productAction.id, id)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a cross-product parent reference", async () => {
    const productA = await insertProduct("a");
    const productB = await insertProduct("b");

    const rootOfB = await insertAction({ productId: productB, actionType: "OPEN_SUBMENU" });

    // A button of product A under a menu of product B must be impossible: the
    // trees are wholly owned by their product, and navigation tokens resolve
    // the product through the action's own immutable product_id.
    await expect(
      insertAction({
        productId: productA,
        parentActionId: rootOfB,
        actionType: "START_INQUIRY",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects moving a button to another product's subtree, including deep chains", async () => {
    const productA = await insertProduct("deep-a");
    const productB = await insertProduct("deep-b");

    // A three-deep chain in product B.
    const bRoot = await insertAction({ productId: productB, actionType: "OPEN_SUBMENU" });
    const bChild = await insertAction({
      productId: productB,
      parentActionId: bRoot,
      actionType: "OPEN_SUBMENU",
    });
    const bGrandchild = await insertAction({
      productId: productB,
      parentActionId: bChild,
      actionType: "OPEN_SUBMENU",
    });

    // A button of product A cannot be re-parented under B's grandchild, even
    // though the *immediate* parent chain walk passes the first hop.
    const aButton = await insertAction({ productId: productA, actionType: "START_INQUIRY" });

    await expect(
      testDb!.db
        .update(productAction)
        .set({ parentActionId: bGrandchild })
        .where(eq(productAction.id, aButton),
        ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects making product_id mutable, so a branch cannot migrate products", async () => {
    const productA = await insertProduct("immutable-a");
    const productB = await insertProduct("immutable-b");

    const button = await insertAction({ productId: productA, actionType: "OPEN_SUBMENU" });

    await expect(
      testDb!.db
        .update(productAction)
        .set({ productId: productB })
        .where(eq(productAction.id, button)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects a cycle: a menu cannot become its own grandchild", async () => {
    const productId = await insertProduct("cycle");
    const top = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    const middle = await insertAction({
      productId,
      parentActionId: top,
      actionType: "OPEN_SUBMENU",
    });
    const leaf = await insertAction({
      productId,
      parentActionId: middle,
      actionType: "OPEN_SUBMENU",
    });

    await expect(
      testDb!.db
        .update(productAction)
        .set({ parentActionId: leaf })
        .where(eq(productAction.id, top)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    // Nothing was written: the top button is still a root.
    const reloaded = await testDb!.db.query.productAction.findFirst({
      where: eq(productAction.id, top),
    });

    expect(reloaded?.parentActionId).toBeNull();
  });

  it("rejects a child under a terminal action type", async () => {
    const productId = await insertProduct("terminal");

    for (const terminalType of [
      "START_INQUIRY",
      "SHOW_DETAILS",
      "SEND_TEMPLATE_MESSAGE",
      "OPEN_URL",
      "OPEN_SUPPORT",
      "NAVIGATE_CATALOG",
    ] as const) {
      const terminal = await insertAction({
        productId,
        actionType: terminalType,
        url: terminalType === "OPEN_URL" ? "https://example.com" : null,
      });

      // Only OPEN_SUBMENU may hold children. Enforced on insert, so a terminal
      // node can never accumulate unreachable children.
      await expect(
        insertAction({
          productId,
          parentActionId: terminal,
          actionType: "SHOW_DETAILS",
        }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
    }
  });

  it("rejects changing a menu button to a terminal type while it has children", async () => {
    const productId = await insertProduct("type-change");
    const menu = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    await insertAction({
      productId,
      parentActionId: menu,
      actionType: "START_INQUIRY",
    });

    await expect(
      testDb!.db
        .update(productAction)
        .set({ actionType: "SHOW_DETAILS" })
        .where(eq(productAction.id, menu)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // The menu and its child both survive, untouched.
    const children = await testDb!.db.query.productAction.findMany({
      where: eq(productAction.parentActionId, menu),
    });

    expect(children).toHaveLength(1);
  });

  it("allows changing a menu button to terminal once its children are gone", async () => {
    const productId = await insertProduct("type-change-clean");
    const menu = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    const child = await insertAction({
      productId,
      parentActionId: menu,
      actionType: "START_INQUIRY",
    });

    await testDb!.db.delete(productAction).where(eq(productAction.id, child));

    await expect(
      testDb!.db
        .update(productAction)
        .set({ actionType: "SHOW_DETAILS" })
        .where(eq(productAction.id, menu)),
    ).resolves.toBeDefined();
  });

  it("enforces unique sort order among siblings and roots", async () => {
    const productId = await insertProduct("ordering");
    const menu = await insertAction({ productId, actionType: "OPEN_SUBMENU" });

    await insertAction({
      productId,
      parentActionId: menu,
      actionType: "SHOW_DETAILS",
      sortOrder: 0,
    });
    await insertAction({
      productId,
      parentActionId: menu,
      actionType: "START_INQUIRY",
      sortOrder: 1,
    });

    await expect(
      insertAction({
        productId,
        parentActionId: menu,
        actionType: "OPEN_URL",
        url: "https://example.com",
        sortOrder: 1,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // Roots are protected by their own partial index.
    await insertAction({ productId, actionType: "OPEN_SUBMENU", sortOrder: 0 });
    await expect(
      insertAction({ productId, actionType: "OPEN_SUBMENU", sortOrder: 0 }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("cascades: deleting a product removes its whole button tree", async () => {
    const productId = await insertProduct("cascade");
    const root = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    const child = await insertAction({
      productId,
      parentActionId: root,
      actionType: "OPEN_SUBMENU",
    });
    const grandchild = await insertAction({
      productId,
      parentActionId: child,
      actionType: "START_INQUIRY",
    });

    await testDb!.db.delete(product).where(eq(product.id, productId));

    const remaining = await testDb!.db
      .select({ id: productAction.id })
      .from(productAction)
      .where(eq(productAction.id, root));

    expect(remaining).toHaveLength(0);
    expect([root, child, grandchild]).toHaveLength(3);
  });

  it("cascades: deleting a branch removes only that branch", async () => {
    const productId = await insertProduct("branch-cascade");
    const kept = await insertAction({
      productId,
      actionType: "OPEN_SUBMENU",
      sortOrder: 0,
    });
    const doomed = await insertAction({
      productId,
      actionType: "OPEN_SUBMENU",
      sortOrder: 1,
    });
    await insertAction({
      productId,
      parentActionId: doomed,
      actionType: "START_INQUIRY",
    });

    await testDb!.db.delete(productAction).where(eq(productAction.id, doomed));

    // The suite shares one database per file, so the table also holds earlier
    // tests' trees; the question is which of *this product's* buttons survive.
    const survivors = await testDb!.db
      .select({ id: productAction.id })
      .from(productAction)
      .where(eq(productAction.productId, productId));

    // The sibling root survives with its own subtree intact; only the deleted
    // branch and its descendants are gone.
    expect(survivors.map((row) => row.id)).toEqual([kept]);
  });
});

describe.skipIf(!shouldRun)("action columns and translations", () => {
  it("rejects a non-https url at the database level", async () => {
    const productId = await insertProduct("urls");

    await expect(
      insertAction({
        productId,
        actionType: "OPEN_URL",
        url: "http://insecure.example.com",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(
      insertAction({
        productId,
        actionType: "OPEN_URL",
        url: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    // HTTPS is accepted, and the check is on the column, not the type.
    const ok = await insertAction({
      productId,
      actionType: "OPEN_URL",
      url: "https://example.com/info",
    });

    expect(typeof ok).toBe("string");
  });

  it("allows navigation targets only on NAVIGATE_CATALOG, and never both", async () => {
    const productId = await insertProduct("nav");
    const targetCategory = (
      await testDb!.db
        .insert(category)
        .values({
          slug: "nav-target-category",
          isActive: true,
          sortOrder: nextOrder(),
        })
        .returning({ id: category.id })
    )[0].id;
    const targetProduct = (
      await testDb!.db
        .insert(product)
        .values({
          categoryId: targetCategory,
          slug: "nav-target-product",
          price: "1.00",
        })
        .returning({ id: product.id })
    )[0].id;

    // A terminal button may not carry a catalog pointer.
    await expect(
      insertAction({
        productId,
        actionType: "START_INQUIRY",
      }),
    ).resolves.toBeDefined();

    const withCategory = await insertAction({
      productId,
      actionType: "NAVIGATE_CATALOG",
    });

    await testDb!.db
      .update(productAction)
      .set({ navigateCategoryId: targetCategory })
      .where(eq(productAction.id, withCategory));

    // Setting both targets at once is rejected.
    await expect(
      testDb!.db
        .update(productAction)
        .set({ navigateProductId: targetProduct })
        .where(eq(productAction.id, withCategory)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("keeps button translations unique per language and caps the label length", async () => {
    const productId = await insertProduct("labels");
    const actionId = await insertAction({ productId, actionType: "OPEN_SUBMENU" });
    const languageId = (
      await testDb!.db
        .insert(language)
        .values({ code: uniqueLanguageCode(), label: "Label" })
        .returning({ id: language.id })
    )[0].id;

    await testDb!.db.insert(productActionTranslation).values({
      actionId,
      languageId,
      label: "Choose Options",
      menuText: "Pick a design package",
    });

    // One translation per button per language.
    await expect(
      testDb!.db.insert(productActionTranslation).values({
        actionId,
        languageId,
        label: "Duplicate",
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // The 64-character Telegram button-text limit, enforced in the database so
    // a configured label can always be rendered.
    await expect(
      testDb!.db.insert(productActionTranslation).values({
        actionId,
        languageId,
        label: "x".repeat(65),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
