import { describe, expect, it } from "vitest";

import {
  buildActionHierarchy,
  type RawActionNode,
} from "../tree";

function makeAction(
  id: string,
  label: string,
  actionType = "OPEN_SUBMENU",
  parentActionId: string | null = null,
  isActive = true,
  sortOrder = 0,
): RawActionNode {
  return {
    id,
    productId: "prod-1",
    parentActionId,
    actionType,
    sortOrder,
    isActive,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    translations: {
      en: {
        id: `trans-${id}`,
        languageId: "lang-en",
        label,
        menuText: null,
      },
    },
  };
}

describe("buildActionHierarchy", () => {
  it("builds a nested tree with accurate breadcrumbs, depth, and level", () => {
    const root = makeAction("1", "Main Menu", "OPEN_SUBMENU", null, true, 0);
    const child = makeAction("2", "Tiers", "OPEN_SUBMENU", "1", true, 0);
    const leaf = makeAction("3", "Pro Tier Details", "SHOW_DETAILS", "2", true, 0);

    const { tree, flattened } = buildActionHierarchy([root, child, leaf]);

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("1");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].level).toBe(1);
    expect(tree[0].breadcrumb).toBe("Main Menu");
    expect(tree[0].effectiveVisibility).toBe(true);

    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("2");
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].level).toBe(2);
    expect(tree[0].children[0].breadcrumb).toBe("Main Menu > Tiers");

    expect(tree[0].children[0].children[0].id).toBe("3");
    expect(tree[0].children[0].children[0].depth).toBe(2);
    expect(tree[0].children[0].children[0].level).toBe(3);
    expect(tree[0].children[0].children[0].breadcrumb).toBe("Main Menu > Tiers > Pro Tier Details");

    expect(flattened).toHaveLength(3);
  });

  it("calculates effectiveVisibility and inactive reasons truthfully", () => {
    // 1. Inactive root hides active children
    const inactiveRoot = makeAction("1", "Root", "OPEN_SUBMENU", null, false, 0);
    const activeChild = makeAction("2", "Child", "SHOW_DETAILS", "1", true, 0);

    const { tree: tree1 } = buildActionHierarchy([inactiveRoot, activeChild]);
    expect(tree1[0].effectiveVisibility).toBe(false);
    expect(tree1[0].inactiveReason).toBe("self_inactive");

    expect(tree1[0].children[0].effectiveVisibility).toBe(false);
    expect(tree1[0].children[0].hasInactiveAncestor).toBe(true);
    expect(tree1[0].children[0].inactiveReason).toBe("inactive_ancestor");

    // 2. Active buttons on inactive product
    const activeRoot = makeAction("10", "Root", "OPEN_SUBMENU", null, true, 0);
    const { tree: tree2 } = buildActionHierarchy([activeRoot], {
      isProductActive: false,
      isCategoryActive: true,
    });
    expect(tree2[0].effectiveVisibility).toBe(false);
    expect(tree2[0].inactiveReason).toBe("inactive_product");

    // 3. Active buttons on inactive category
    const { tree: tree3 } = buildActionHierarchy([activeRoot], {
      isProductActive: true,
      isCategoryActive: false,
    });
    expect(tree3[0].effectiveVisibility).toBe(false);
    expect(tree3[0].inactiveReason).toBe("inactive_category");
  });

  it("flags depth warnings when nesting exceeds 8 levels and max depth at 16 levels", () => {
    const chain: RawActionNode[] = [];
    let parentId: string | null = null;

    for (let i = 1; i <= 16; i++) {
      const id = String(i);
      chain.push(makeAction(id, `Level ${i}`, "OPEN_SUBMENU", parentId, true, 0));
      parentId = id;
    }

    const { flattened, hasAnyDepthWarning } = buildActionHierarchy(chain);

    expect(hasAnyDepthWarning).toBe(true);

    const nodeL8 = flattened.find((n) => n.level === 8);
    expect(nodeL8?.hasDepthWarning).toBe(false);

    const nodeL9 = flattened.find((n) => n.level === 9);
    expect(nodeL9?.hasDepthWarning).toBe(true);

    const nodeL16 = flattened.find((n) => n.level === 16);
    expect(nodeL16?.hasDepthWarning).toBe(true);
    expect(nodeL16?.isAtMaxDepth).toBe(true);
  });

  it("counts active children and detects when active limit exceeds 20", () => {
    const parent = makeAction("parent", "Parent", "OPEN_SUBMENU", null, true, 0);
    const children: RawActionNode[] = [];

    for (let i = 1; i <= 21; i++) {
      children.push(
        makeAction(`child-${i}`, `Child ${i}`, "START_INQUIRY", "parent", true, i),
      );
    }

    const { tree } = buildActionHierarchy([parent, ...children]);

    expect(tree[0].childCount).toBe(21);
    expect(tree[0].activeChildCount).toBe(21);
    expect(tree[0].exceedsActiveLimit).toBe(true);
  });

  it("safeguards against loops and cycle corruption", () => {
    // 1. Root -> Child -> Root cycle
    const root = makeAction("root", "Root", "OPEN_SUBMENU", null, true, 0);
    const child = makeAction("child", "Child", "OPEN_SUBMENU", "root", true, 0);
    // Artificially corrupt child to have root as child
    root.parentActionId = null;

    // Both in tree: root is root, child has root as child
    const { tree } = buildActionHierarchy([root, child]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);

    // 2. Orphan cycle: A -> B -> A
    const nodeA = makeAction("a", "A", "OPEN_SUBMENU", "b", true, 0);
    const nodeB = makeAction("b", "B", "OPEN_SUBMENU", "a", true, 0);
    expect(() => buildActionHierarchy([nodeA, nodeB])).not.toThrow();
  });
});
