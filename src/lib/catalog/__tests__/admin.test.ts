import { describe, expect, it } from "vitest";

import {
  buildAdminCategoryRows,
  buildAdminProductRows,
  filterAdminProductRows,
  resolveProductDisplayName,
} from "@/lib/catalog/admin";
import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
} from "@/lib/data/catalog";

const now = new Date("2026-01-01T00:00:00.000Z");

function makeCategory(
  overrides: Partial<CatalogCategoryRecord> & {
    id: string;
    slug: string;
    parentId?: string | null;
    isActive?: boolean;
    sortOrder?: number;
    name?: string;
  },
): CatalogCategoryRecord {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    slug: overrides.slug,
    sortOrder: overrides.sortOrder ?? 0,
    isActive: overrides.isActive ?? false,
    createdAt: now,
    updatedAt: now,
    translations: overrides.name
      ? {
          en: {
            id: `${overrides.id}-en`,
            languageId: "lang-en",
            name: overrides.name,
            description: null,
          },
        }
      : {},
  };
}

function makeProduct(
  overrides: Partial<CatalogProductRecord> & {
    id: string;
    categoryId: string;
    slug: string;
    isActive?: boolean;
    price?: string;
    name?: string;
    arabicName?: string;
  },
): CatalogProductRecord {
  const translations: CatalogProductRecord["translations"] = {};
  if (overrides.name) {
    translations.en = {
      id: `${overrides.id}-en`,
      languageId: "lang-en",
      name: overrides.name,
      description: null,
      details: null,
    };
  }
  if (overrides.arabicName) {
    translations.ar = {
      id: `${overrides.id}-ar`,
      languageId: "lang-ar",
      name: overrides.arabicName,
      description: null,
      details: null,
    };
  }

  return {
    id: overrides.id,
    categoryId: overrides.categoryId,
    slug: overrides.slug,
    price: overrides.price ?? "10.00",
    isActive: overrides.isActive ?? false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    translations,
  };
}

const root = makeCategory({
  id: "cat-root",
  slug: "root",
  name: "Root",
  isActive: true,
});
const child = makeCategory({
  id: "cat-child",
  slug: "child",
  parentId: root.id,
  name: "Child",
  isActive: true,
});
const inactiveRoot = makeCategory({
  id: "cat-inactive-root",
  slug: "inactive-root",
  name: "Inactive Root",
  isActive: false,
});
const hiddenChild = makeCategory({
  id: "cat-hidden-child",
  slug: "hidden-child",
  parentId: inactiveRoot.id,
  name: "Hidden Child",
  isActive: true,
});

const categories = [root, child, inactiveRoot, hiddenChild];
const products = [
  makeProduct({
    id: "prod-root",
    categoryId: root.id,
    slug: "root-product",
    name: "Root Product",
    isActive: true,
    price: "10.00",
  }),
  makeProduct({
    id: "prod-child",
    categoryId: child.id,
    slug: "child-product",
    arabicName: "منتج فرعي",
    isActive: true,
    price: "20.00",
  }),
  makeProduct({
    id: "prod-hidden",
    categoryId: hiddenChild.id,
    slug: "hidden-product",
    name: "Hidden Product",
    isActive: true,
    price: "30.00",
  }),
  makeProduct({
    id: "prod-inactive",
    categoryId: root.id,
    slug: "inactive-product",
    isActive: false,
    price: "40.00",
  }),
];

describe("simple catalog admin view models", () => {
  it("resolves product names through requested, default, any saved language, then slug", () => {
    expect(resolveProductDisplayName(products[0], "en", "en")).toBe("Root Product");
    expect(resolveProductDisplayName(products[1], "en", "en")).toBe("منتج فرعي");
    expect(resolveProductDisplayName(products[3], "en", "en")).toBe(
      "inactive-product",
    );
  });

  it("shows category paths and truthful active, hidden and inactive states", () => {
    const rows = buildAdminProductRows(products, categories);
    const byId = new Map(rows.map((row) => [row.product.id, row]));

    expect(byId.get("prod-root")?.status).toBe("active");
    expect(byId.get("prod-child")?.status).toBe("active");
    expect(byId.get("prod-hidden")?.status).toBe("hidden");
    expect(byId.get("prod-inactive")?.status).toBe("inactive");
    expect(byId.get("prod-child")?.categoryPath).toBe("Root › Child");
  });

  it("filters the loaded list by search, direct category and active state", () => {
    const rows = buildAdminProductRows(products, categories);

    expect(
      filterAdminProductRows(rows, { query: "hidden" }).map(
        (row) => row.product.id,
      ),
    ).toEqual(["prod-hidden"]);

    expect(
      filterAdminProductRows(rows, { categoryId: child.id }).map(
        (row) => row.product.id,
      ),
    ).toEqual(["prod-child"]);

    expect(
      filterAdminProductRows(rows, { active: "inactive" }).map(
        (row) => row.product.id,
      ),
    ).toEqual(["prod-inactive"]);

    expect(
      filterAdminProductRows(rows, {
        query: "20.00",
        categoryId: child.id,
        active: "active",
      }).map((row) => row.product.id),
    ).toEqual(["prod-child"]);
  });

  it("distinguishes root and child categories and counts direct and descendant products", () => {
    const rows = buildAdminCategoryRows(categories, products);
    const byId = new Map(rows.map((row) => [row.node.id, row]));

    expect(byId.get(root.id)?.isRoot).toBe(true);
    expect(byId.get(root.id)?.parentName).toBeNull();
    expect(byId.get(root.id)?.directProductCount).toBe(2);
    expect(byId.get(root.id)?.totalProductCount).toBe(3);

    expect(byId.get(child.id)?.isRoot).toBe(false);
    expect(byId.get(child.id)?.parentName).toBe("Root");
    expect(byId.get(child.id)?.directProductCount).toBe(1);

    expect(byId.get(hiddenChild.id)?.node.isActive).toBe(true);
    expect(byId.get(hiddenChild.id)?.node.effectiveVisibility).toBe(false);
    expect(byId.get(hiddenChild.id)?.node.hasInactiveAncestor).toBe(true);
  });
});
