import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { category, product, productTranslation } from "@/db/schema";

/**
 * Channel-independent storefront catalog reads.
 *
 * The storefront is defined entirely from existing settings and catalog rows:
 * there is no storefront table, no activation flag, and no seeded content. A
 * product is visible here exactly when it is an active, non-deleted product
 * whose full category ancestry is also active and not deleted.
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

type CategoryRow = {
  id: string;
  parentId: string | null;
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

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function loadEligibleProductRows(db: Database): Promise<EligibleProductRow[]> {
  const categories = await db
    .select({
      id: category.id,
      parentId: category.parentId,
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

  function isCategoryEligible(categoryId: string): boolean {
    const cached = categoryEligibility.get(categoryId);
    if (cached !== undefined) return cached;

    const visited = new Set<string>();
    let currentId: string | null = categoryId;
    let eligible = true;

    while (currentId !== null) {
      const known = categoryEligibility.get(currentId);
      if (known !== undefined) {
        eligible = known;
        break;
      }

      if (visited.has(currentId)) {
        eligible = false;
        break;
      }
      visited.add(currentId);

      const row = categoryById.get(currentId);
      if (!row || !row.isActive || row.deletedAt !== null) {
        eligible = false;
        break;
      }

      currentId = row.parentId;
    }

    for (const id of visited) {
      categoryEligibility.set(id, eligible);
    }

    return eligible;
  }

  return products
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
}

/**
 * True when at least one product is visible through a fully active category
 * hierarchy. Home uses this to avoid offering a category entry point that has
 * no useful eligible content.
 */
export async function hasEligibleStorefrontProducts(db: Database): Promise<boolean> {
  const rows = await loadEligibleProductRows(db);
  return rows.length > 0;
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
  const eligible = await loadEligibleProductRows(db);
  const pageSize = Math.max(1, Math.floor(params.pageSize));
  const totalCount = eligible.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const requestedPage = Number.isInteger(params.page) && params.page > 0 ? params.page : 1;
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const pageRows = eligible.slice(start, start + pageSize);

  if (pageRows.length === 0) {
    return { items: [], totalCount, page, totalPages };
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
          pageRows.map((row) => row.id),
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
    items: pageRows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      price: row.price,
      name:
        namesByProduct.get(row.id)?.get(params.languageId) ??
        namesByProduct.get(row.id)?.get(params.defaultLanguageId) ??
        row.slug,
    })),
    totalCount,
    page,
    totalPages,
  };
}
