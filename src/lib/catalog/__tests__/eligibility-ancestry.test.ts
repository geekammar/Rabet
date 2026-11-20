import { describe, expect, it } from "vitest";

import {
  isCategoryAncestryActive,
  MAX_SAFEGUARD_DEPTH,
  type CategoryAncestryNode,
} from "@/lib/catalog/eligibility";

function chain(length: number): Map<string, CategoryAncestryNode> {
  const rows = new Map<string, CategoryAncestryNode>();
  for (let i = 1; i <= length; i++) {
    const id = `c${i}`;
    rows.set(id, {
      id,
      parentId: i === 1 ? null : `c${i - 1}`,
      isActive: true,
    });
  }
  return rows;
}

describe("shared category ancestry predicate", () => {
  it("accepts valid active ancestry", () => {
    const rows = chain(4);
    expect(isCategoryAncestryActive("c4", (id) => rows.get(id))).toBe(true);
  });

  it("rejects an inactive ancestor", () => {
    const rows = chain(4);
    rows.set("c2", { ...rows.get("c2")!, isActive: false });
    expect(isCategoryAncestryActive("c4", (id) => rows.get(id))).toBe(false);
  });

  it("rejects a deleted ancestor (represented by an absent lookup row)", () => {
    const rows = chain(4);
    const deleted = new Set(["c2"]);
    expect(
      isCategoryAncestryActive("c4", (id) =>
        deleted.has(id) ? undefined : rows.get(id),
      ),
    ).toBe(false);
  });

  it("rejects a missing ancestor", () => {
    const rows = chain(4);
    rows.delete("c2");
    expect(isCategoryAncestryActive("c4", (id) => rows.get(id))).toBe(false);
  });

  it("rejects an unresolved scoped parent even when the target is active", () => {
    const rows = chain(4);
    rows.set("c3", { ...rows.get("c3")!, parentResolved: false });
    expect(isCategoryAncestryActive("c4", (id) => rows.get(id))).toBe(false);
    expect(isCategoryAncestryActive("c3", (id) => rows.get(id))).toBe(false);
  });

  it("treats a genuine root as resolved by default", () => {
    const rows = chain(4);
    expect(rows.get("c1")?.parentResolved).toBeUndefined();
    expect(isCategoryAncestryActive("c1", (id) => rows.get(id))).toBe(true);
  });

  it("rejects a cycle without looping", () => {
    const rows = chain(3);
    rows.set("c1", { id: "c1", parentId: "c3", isActive: true });
    expect(isCategoryAncestryActive("c3", (id) => rows.get(id))).toBe(false);
  });

  it("accepts ancestry exactly at the depth boundary", () => {
    const rows = chain(MAX_SAFEGUARD_DEPTH);
    expect(
      isCategoryAncestryActive(`c${MAX_SAFEGUARD_DEPTH}`, (id) => rows.get(id)),
    ).toBe(true);
  });

  it("rejects ancestry exceeding the depth boundary", () => {
    const rows = chain(MAX_SAFEGUARD_DEPTH + 1);
    expect(
      isCategoryAncestryActive(
        `c${MAX_SAFEGUARD_DEPTH + 1}`,
        (id) => rows.get(id),
      ),
    ).toBe(false);
  });
});
