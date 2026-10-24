import { describe, expect, it } from "vitest";
import {
  buildCategoryHierarchy,
  type RawCategoryNode,
} from "../tree";

function makeCategory(
  id: string,
  slug: string,
  parentId: string | null = null,
  isActive = true,
  name?: string,
  sortOrder = 0,
): RawCategoryNode {
  return {
    id,
    parentId,
    slug,
    sortOrder,
    isActive,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    translations: {
      en: { id: `trans-${id}`, name: name ?? slug, description: null },
    },
  };
}

describe("buildCategoryHierarchy", () => {
  it("builds a simple root and child hierarchy with accurate breadcrumbs and depth", () => {
    const root = makeCategory("1", "electronics", null, true, "Electronics", 0);
    const child = makeCategory("2", "phones", "1", true, "Phones", 0);
    const grandchild = makeCategory("3", "smartphones", "2", true, "Smartphones", 0);

    const { tree, flattened } = buildCategoryHierarchy([root, child, grandchild]);

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("1");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].breadcrumb).toBe("Electronics");
    expect(tree[0].effectiveVisibility).toBe(true);

    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("2");
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].breadcrumb).toBe("Electronics › Phones");
    expect(tree[0].children[0].effectiveVisibility).toBe(true);

    expect(tree[0].children[0].children[0].id).toBe("3");
    expect(tree[0].children[0].children[0].depth).toBe(2);
    expect(tree[0].children[0].children[0].breadcrumb).toBe("Electronics › Phones › Smartphones");
    expect(tree[0].children[0].children[0].effectiveVisibility).toBe(true);

    expect(flattened).toHaveLength(3);
    expect(flattened.map((f) => f.id)).toEqual(["1", "2", "3"]);
  });

  it("never implies an active child is customer-visible when an ancestor is inactive", () => {
    // Root is INACTIVE, but child and grandchild are marked active
    const root = makeCategory("1", "root", null, false, "Root", 0);
    const child = makeCategory("2", "child", "1", true, "Child", 0);
    const grandchild = makeCategory("3", "grandchild", "2", true, "Grandchild", 0);

    const { tree } = buildCategoryHierarchy([root, child, grandchild]);

    expect(tree[0].isActive).toBe(false);
    expect(tree[0].effectiveVisibility).toBe(false);

    const childNode = tree[0].children[0];
    expect(childNode.isActive).toBe(true);
    expect(childNode.effectiveVisibility).toBe(false);
    expect(childNode.hasInactiveAncestor).toBe(true);
    expect(childNode.inactiveAncestorName).toBe("Root");

    const grandNode = childNode.children[0];
    expect(grandNode.isActive).toBe(true);
    expect(grandNode.effectiveVisibility).toBe(false);
    expect(grandNode.hasInactiveAncestor).toBe(true);
    expect(grandNode.inactiveAncestorName).toBe("Root");
  });

  it("sorts siblings by sortOrder ASC, createdAt ASC, id ASC", () => {
    const root = makeCategory("1", "root", null, true, "Root", 0);
    const c3 = makeCategory("c3", "c3", "1", true, "C3", 10);
    const c1 = makeCategory("c1", "c1", "1", true, "C1", 2);
    const c2 = makeCategory("c2", "c2", "1", true, "C2", 5);

    const { tree } = buildCategoryHierarchy([root, c3, c1, c2]);
    const childSlugs = tree[0].children.map((c) => c.slug);
    expect(childSlugs).toEqual(["c1", "c2", "c3"]);
  });

  it("safeguards against loops and cycle corruption", () => {
    // A -> B -> A
    const catA = makeCategory("a", "a", "b", true, "A");
    const catB = makeCategory("b", "b", "a", true, "B");

    // Since both reference each other as parent, neither is a root under normal parentId === null.
    // However, when parentId is not in byId (or cycle), it safely terminates without infinite loop.
    expect(() => buildCategoryHierarchy([catA, catB])).not.toThrow();
  });
});
