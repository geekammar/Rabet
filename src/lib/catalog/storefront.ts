import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { category, categoryTranslation, product, productTranslation } from "@/db/schema";
import {
  isCategoryAncestryActive,
  MAX_SAFEGUARD_DEPTH,
} from "./eligibility";

/**
 * Channel-independent storefront catalog reads.
 *
 * The storefront is defined entirely from existing settings and catalog rows:
 * there is no storefront table, no activation flag, and no seeded content. A
 * product is visible here exactly when it is an active, non-deleted product
 * whose full category ancestry is also active, not deleted, acyclic, and within
 * the same depth safeguard used by the live product-card guard.
 */

export interface StorefrontProductListItem {
  id: string;
  categoryId: string;
  slug: string;
  price: string;
  name: string;
}

export interface StorefrontProductPage {
  items: StorefrontProductListItem[];
  totalCount: number;
  page: number;
  totalPages: number;
}

export interface StorefrontCategoryListItem {
  id: string;
  slug: string;
  name: string;
}

export interface StorefrontCategoryPage {
  items: StorefrontCategoryListItem[];
  totalCount: number;
  page: number;
  totalPages: number;
}

type CategoryRow = {
  id: string;
  parentId: string | null;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  deletedAt: Date | null;
};

type EligibleProductRow = {
  id: string;
  categoryId: string;
  slug: string;
  price: string;
  sortOrder: number;
  categorySortOrder: number;
};

type LoadedStorefrontCatalog = {
  products: EligibleProductRow[];
  categoryById: Map<string, CategoryRow>;
  eligibleCategoryIds: Set<string>;
};

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function loadEligibleStorefrontCatalog(
  db: Database,
): Promise<LoadedStorefrontCatalog> {
  const categories = await db
    .select({
      id: category.id,
      parentId: category.parentId,
      slug: category.slug,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      deletedAt: category.deletedAt,
    })
    .from(category);

  const products = await db
    .select({
      id: product.id,
      categoryId: product.categoryId,
      slug: product.slug,
      price: product.price,
      sortOrder: product.sortOrder,
    })
    .from(product)
    .where(and(eq(product.isActive, true), isNull(product.deletedAt)));

  const categoryById = new Map<string, CategoryRow>(
    categories.map((row) => [row.id, row]),
  );
  const categoryEligibility = new Map<string, boolean>();

  const getCategory = (id: string) => {
    const row = categoryById.get(id);
    return row && row.deletedAt === null ? row : undefined;
  };

  // Cache only the result for the requested category. Ancestor results depend on
  // the distance from the product's category to the root, so reusing a cached
  // ancestor result would bypass the depth safeguard.
  function isCategoryEligible(categoryId: string): boolean {
    const cached = categoryEligibility.get(categoryId);
    if (cached !== undefined) return cached;

    const eligible = isCategoryAncestryActive(categoryId, getCategory);
    categoryEligibility.set(categoryId, eligible);
    return eligible;
  }

  const ancestryCache = new Map<string, string[]>();
  function categoryAncestryIds(categoryId: string): string[] {
    const cached = ancestryCache.get(categoryId);
    if (cached) return cached;

    const ids: string[] = [];
    const visited = new Set<string>();
    let currentId: string | null = categoryId;
    let depth = 0;

    while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      ids.push(currentId);

      const row = categoryById.get(currentId);
      if (!row) break;
      currentId = row.parentId;
      depth += 1;
    }

    ancestryCache.set(categoryId, ids);
    return ids;
  }

  const eligibleProducts = products
    .filter((row) => isCategoryEligible(row.categoryId))
    .map((row) => ({
      ...row,
      categorySortOrder: categoryById.get(row.categoryId)?.sortOrder ?? 0,
    }))
    .sort(
      (a, b) =>
        a.categorySortOrder - b.categorySortOrder ||
        compareStrings(a.categoryId, b.categoryId) ||
        a.sortOrder - b.sortOrder ||
        compareStrings(a.id, b.id),
    );

  const eligibleCategoryIds = new Set<string>();
  for (const row of eligibleProducts) {
    for (const id of categoryAncestryIds(row.categoryId)) {
      eligibleCategoryIds.add(id);
    }
  }

  return { products: eligibleProducts, categoryById, eligibleCategoryIds };
}

function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { items: T[]; totalCount: number; page: number; totalPages: number } {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / normalizedPageSize));
  const requestedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const currentPage = Math.min(requestedPage, totalPages);
  const start = (currentPage - 1) * normalizedPageSize;

  return {
    items: items.slice(start, start + normalizedPageSize),
    totalCount,
    page: currentPage,
    totalPages,
  };
}

/**
 * True when at least one product is visible through a fully eligible category
 * hierarchy. Home uses this to avoid offering a category entry point that has
 * no useful eligible content.
 */
export async function hasEligibleStorefrontProducts(db: Database): Promise<boolean> {
  const loaded = await loadEligibleStorefrontCatalog(db);
  return loaded.products.length > 0;
}

/**
 * Category ids that are ancestors of at least one eligible product. The new
 * storefront category browser uses this set to hide empty branches while the
 * legacy `c:` callbacks continue to operate on the full configured tree.
 */
export async function getEligibleStorefrontCategoryIds(
  db: Database,
): Promise<Set<string>> {
  const loaded = await loadEligibleStorefrontCatalog(db);
  return loaded.eligibleCategoryIds;
}

/**
 * Returns one deterministic page of visible storefront products with names
 * resolved through requested-language → default-language → slug fallback.
 */
export async function listEligibleStorefrontProducts(
  db: Database,
  params: {
    languageId: string;
    defaultLanguageId: string;
    page: number;
    pageSize: number;
  },
): Promise<StorefrontProductPage> {
  const loaded = await loadEligibleStorefrontCatalog(db);
  const result = paginate(loaded.products, params.page, params.pageSize);

  if (result.items.length === 0) {
    return { ...result, items: [] };
  }

  const languageIds = Array.from(
    new Set([params.languageId, params.defaultLanguageId].filter((id) => id.length > 0)),
  );

  const translations = await db
    .select({
      productId: productTranslation.productId,
      languageId: productTranslation.languageId,
      name: productTranslation.name,
    })
    .from(productTranslation)
    .where(
      and(
        inArray(
          productTranslation.productId,
          result.items.map((row) => row.id),
        ),
        inArray(productTranslation.languageId, languageIds),
      ),
    );

  const namesByProduct = new Map<string, Map<string, string>>();
  for (const translation of translations) {
    const byLanguage = namesByProduct.get(translation.productId) ?? new Map();
    byLanguage.set(translation.languageId, translation.name);
    namesByProduct.set(translation.productId, byLanguage);
  }

  return {
    ...result,
    items: result.items.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      price: row.price,
      name:
        namesByProduct.get(row.id)?.get(params.languageId) ??
        namesByProduct.get(row.id)?.get(params.defaultLanguageId) ??
        row.slug,
    })),
  };
}

/**
 * Returns one deterministic page of direct child categories that lead to at
 * least one eligible product. Ordering uses the configured category sort order
 * with an id tie-breaker.
 */
export async function listEligibleStorefrontCategories(
  db: Database,
  params: {
    parentId: string | null;
    languageId: string;
    defaultLanguageId: string;
    page: number;
    pageSize: number;
  },
): Promise<StorefrontCategoryPage> {
  const loaded = await loadEligibleStorefrontCatalog(db);
  const categories = Array.from(loaded.categoryById.values())
    .filter(
      (row) =>
        row.parentId === params.parentId &&
        loaded.eligibleCategoryIds.has(row.id),
    )
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || compareStrings(a.id, b.id),
    );

  const result = paginate(categories, params.page, params.pageSize);
  if (result.items.length === 0) {
    return { ...result, items: [] };
  }

  const languageIds = Array.from(
    new Set([params.languageId, params.defaultLanguageId].filter((id) => id.length > 0)),
  );

  const translations = await db
    .select({
      categoryId: categoryTranslation.categoryId,
      languageId: categoryTranslation.languageId,
      name: categoryTranslation.name,
    })
    .from(categoryTranslation)
    .where(
      and(
        inArray(
          categoryTranslation.categoryId,
          result.items.map((row) => row.id),
        ),
        inArray(categoryTranslation.languageId, languageIds),
      ),
    );

  const namesByCategory = new Map<string, Map<string, string>>();
  for (const translation of translations) {
    const byLanguage = namesByCategory.get(translation.categoryId) ?? new Map();
    byLanguage.set(translation.languageId, translation.name);
    namesByCategory.set(translation.categoryId, byLanguage);
  }

  return {
    ...result,
    items: result.items.map((row) => ({
      id: row.id,
      slug: row.slug,
      name:
        namesByCategory.get(row.id)?.get(params.languageId) ??
        namesByCategory.get(row.id)?.get(params.defaultLanguageId) ??
        row.slug,
    })),
  };
}
