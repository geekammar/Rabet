import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
} from "@/lib/data/catalog";

import {
  buildCategoryHierarchy,
  resolveCategoryDisplayName,
  type HierarchyCategoryNode,
} from "./tree";

export type AdminProductStatus = "active" | "hidden" | "inactive";

export interface AdminProductRow {
  product: CatalogProductRecord;
  name: string;
  categoryName: string;
  categoryPath: string;
  categoryIsVisible: boolean;
  status: AdminProductStatus;
}

export interface AdminProductFilters {
  query?: string;
  categoryId?: string;
  active?: "all" | "active" | "inactive";
}

export interface AdminCategoryRow {
  node: HierarchyCategoryNode;
  isRoot: boolean;
  parentName: string | null;
  directProductCount: number;
  totalProductCount: number;
}

export function resolveProductDisplayName(
  product: CatalogProductRecord,
  preferredLanguage = "en",
  defaultLanguage = "en",
): string {
  const preferred = product.translations[preferredLanguage]?.name?.trim();
  if (preferred) return preferred;

  const fallback = product.translations[defaultLanguage]?.name?.trim();
  if (fallback) return fallback;

  for (const translation of Object.values(product.translations)) {
    const name = translation?.name?.trim();
    if (name) return name;
  }

  return product.slug;
}

export function buildAdminProductRows(
  products: CatalogProductRecord[],
  categories: CatalogCategoryRecord[],
  options?: {
    preferredLanguage?: string;
    defaultLanguage?: string;
  },
): AdminProductRow[] {
  const preferredLanguage = options?.preferredLanguage ?? "en";
  const defaultLanguage = options?.defaultLanguage ?? "en";

  const { flattened } = buildCategoryHierarchy(categories, {
    preferredLanguage,
    defaultLanguage,
  });
  const categoryById = new Map(flattened.map((node) => [node.id, node]));

  return products.map((product) => {
    const category = categoryById.get(product.categoryId);
    const categoryIsVisible = category?.effectiveVisibility ?? false;
    const status: AdminProductStatus = !product.isActive
      ? "inactive"
      : categoryIsVisible
        ? "active"
        : "hidden";

    return {
      product,
      name: resolveProductDisplayName(product, preferredLanguage, defaultLanguage),
      categoryName: category
        ? resolveCategoryDisplayName(category, preferredLanguage, defaultLanguage)
        : "Unknown category",
      categoryPath: category?.breadcrumb ?? "Unknown category",
      categoryIsVisible,
      status,
    };
  });
}

export function filterAdminProductRows(
  rows: AdminProductRow[],
  filters: AdminProductFilters,
): AdminProductRow[] {
  const query = filters.query?.trim().toLowerCase() ?? "";
  const categoryId = filters.categoryId?.trim() ?? "";
  const active = filters.active ?? "all";

  return rows.filter((row) => {
    if (categoryId && row.product.categoryId !== categoryId) return false;

    if (active === "active" && !row.product.isActive) return false;
    if (active === "inactive" && row.product.isActive) return false;

    if (!query) return true;

    const haystack = [
      row.name,
      row.product.slug,
      row.product.price,
      row.categoryName,
      row.categoryPath,
      row.status === "active"
        ? "active"
        : row.status === "hidden"
          ? "active hidden inactive ancestor"
          : "inactive",
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

export function buildAdminCategoryRows(
  categories: CatalogCategoryRecord[],
  products: CatalogProductRecord[],
  options?: {
    preferredLanguage?: string;
    defaultLanguage?: string;
  },
): AdminCategoryRow[] {
  const preferredLanguage = options?.preferredLanguage ?? "en";
  const defaultLanguage = options?.defaultLanguage ?? "en";

  const { flattened } = buildCategoryHierarchy(categories, {
    preferredLanguage,
    defaultLanguage,
  });

  const directCounts = new Map<string, number>();
  for (const product of products) {
    directCounts.set(
      product.categoryId,
      (directCounts.get(product.categoryId) ?? 0) + 1,
    );
  }

  const totalCounts = new Map<string, number>();
  const countSubtree = (node: HierarchyCategoryNode): number => {
    const cached = totalCounts.get(node.id);
    if (cached !== undefined) return cached;

    const total =
      (directCounts.get(node.id) ?? 0) +
      node.children.reduce((sum, child) => sum + countSubtree(child), 0);
    totalCounts.set(node.id, total);
    return total;
  };

  const byId = new Map(flattened.map((node) => [node.id, node]));

  return flattened.map((node) => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const directProductCount = directCounts.get(node.id) ?? 0;

    return {
      node,
      isRoot: node.depth === 0,
      parentName: parent
        ? resolveCategoryDisplayName(parent, preferredLanguage, defaultLanguage)
        : null,
      directProductCount,
      totalProductCount: countSubtree(node),
    };
  });
}
