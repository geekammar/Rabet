import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import { assertStoreScope, type StoreScope } from "@/lib/data/store-scope";
import {
  isCategoryAncestryActive,
  MAX_SAFEGUARD_DEPTH,
} from "./eligibility";

/**
 * Customer-facing catalog reads for a verified Managed Store Bot connection.
 *
 * These deliberately differ from the legacy storefront reader: every query is
 * constrained by the server-minted `StoreScope`, and a product is visible only
 * when it is active, not deleted, and every category on its path belongs to the
 * same store and is active and not deleted. A product id from another store is
 * simply not found.
 */

type ScopedCategoryRow = {
  id: string;
  parentId: string | null;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  deletedAt: Date | null;
};

type ScopedProductRow = {
  id: string;
  categoryId: string;
  slug: string;
  price: string;
  sortOrder: number;
};

type LoadedCatalog = {
  products: ScopedProductRow[];
  categoryById: Map<string, ScopedCategoryRow>;
  eligibleCategoryIds: Set<string>;
};

export type ManagedProductPage = {
  items: Array<{
    id: string;
    categoryId: string;
    slug: string;
    price: string;
    name: string;
    description: string | null;
  }>;
  totalCount: number;
  page: number;
  totalPages: number;
};

export type ManagedCategoryPage = {
  items: Array<{ id: string; slug: string; name: string }>;
  totalCount: number;
  page: number;
  totalPages: number;
};

export type ManagedProduct = {
  id: string;
  categoryId: string;
  slug: string;
  price: string;
  name: string;
  description: string | null;
  details: string | null;
};

async function loadCatalog(
  db: Database,
  scope: StoreScope,
): Promise<LoadedCatalog> {
  assertStoreScope(scope);

  const categories = await db
    .select({
      id: category.id,
      parentId: category.parentId,
      slug: category.slug,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      deletedAt: category.deletedAt,
    })
    .from(category)
    .where(eq(category.storeId, scope.storeId));

  const products = await db
    .select({
      id: product.id,
      categoryId: product.categoryId,
      slug: product.slug,
      price: product.price,
      sortOrder: product.sortOrder,
    })
    .from(product)
    .where(
      and(
        eq(product.storeId, scope.storeId),
        eq(product.isActive, true),
        isNull(product.deletedAt),
      ),
    );

  const categoryById = new Map(categories.map((row) => [row.id, row]));
  const categoryEligibility = new Map<string, boolean>();

  const getCategory = (id: string) => {
    const row = categoryById.get(id);
    return row && row.deletedAt === null ? row : undefined;
  };

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

  const eligibleProducts = products.filter((row) =>
    isCategoryEligible(row.categoryId),
  );

  const eligibleCategoryIds = new Set<string>();
  for (const row of eligibleProducts) {
    for (const id of categoryAncestryIds(row.categoryId)) {
      eligibleCategoryIds.add(id);
    }
  }

  return { products: eligibleProducts, categoryById, eligibleCategoryIds };
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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

async function loadEnglishNames(
  db: Database,
  productIds: string[],
): Promise<{ names: Map<string, string>; descriptions: Map<string, string> }> {
  if (productIds.length === 0) {
    return { names: new Map(), descriptions: new Map() };
  }

  const rows = await db
    .select({
      productId: productTranslation.productId,
      code: language.code,
      name: productTranslation.name,
      description: productTranslation.description,
    })
    .from(productTranslation)
    .innerJoin(language, eq(language.id, productTranslation.languageId))
    .where(inArray(productTranslation.productId, productIds))
    .orderBy(asc(language.code));

  const names = new Map<string, string>();
  const descriptions = new Map<string, string>();

  // English first, then the first available translation. The latter fallback
  // keeps a store with only Arabic content usable.
  for (const row of rows) {
    if (row.code === "en" || !names.has(row.productId)) {
      names.set(row.productId, row.name);
      if (row.description) descriptions.set(row.productId, row.description);
    }
  }

  return { names, descriptions };
}

async function loadEnglishCategoryNames(
  db: Database,
  categoryIds: string[],
): Promise<Map<string, string>> {
  if (categoryIds.length === 0) return new Map();

  const rows = await db
    .select({
      categoryId: categoryTranslation.categoryId,
      code: language.code,
      name: categoryTranslation.name,
    })
    .from(categoryTranslation)
    .innerJoin(language, eq(language.id, categoryTranslation.languageId))
    .where(inArray(categoryTranslation.categoryId, categoryIds))
    .orderBy(asc(language.code));

  const names = new Map<string, string>();

  for (const row of rows) {
    if (row.code === "en" || !names.has(row.categoryId)) {
      names.set(row.categoryId, row.name);
    }
  }

  return names;
}

export async function listManagedProducts(
  db: Database,
  scope: StoreScope,
  params: { page: number; pageSize: number },
): Promise<ManagedProductPage> {
  const loaded = await loadCatalog(db, scope);
  const ordered = loaded.products
    .map((row) => ({
      ...row,
      categorySortOrder: loaded.categoryById.get(row.categoryId)?.sortOrder ?? 0,
    }))
    .sort(
      (a, b) =>
        a.categorySortOrder - b.categorySortOrder ||
        compareStrings(a.categoryId, b.categoryId) ||
        a.sortOrder - b.sortOrder ||
        compareStrings(a.id, b.id),
    );

  const result = paginate(ordered, params.page, params.pageSize);
  const { names, descriptions } = await loadEnglishNames(
    db,
    result.items.map((row) => row.id),
  );

  return {
    ...result,
    items: result.items.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      price: row.price,
      name: names.get(row.id) ?? row.slug,
      description: descriptions.get(row.id) ?? null,
    })),
  };
}

export async function listManagedCategories(
  db: Database,
  scope: StoreScope,
  params: { parentId: string | null; page: number; pageSize: number },
): Promise<ManagedCategoryPage> {
  const loaded = await loadCatalog(db, scope);
  const categories = Array.from(loaded.categoryById.values())
    .filter(
      (row) =>
        row.parentId === params.parentId &&
        loaded.eligibleCategoryIds.has(row.id),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || compareStrings(a.id, b.id));

  const result = paginate(categories, params.page, params.pageSize);
  const names = await loadEnglishCategoryNames(
    db,
    result.items.map((row) => row.id),
  );

  return {
    ...result,
    items: result.items.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: names.get(row.id) ?? row.slug,
    })),
  };
}

export async function listManagedProductsInCategory(
  db: Database,
  scope: StoreScope,
  params: { categoryId: string; page: number; pageSize: number },
): Promise<ManagedProductPage> {
  const loaded = await loadCatalog(db, scope);

  if (!loaded.eligibleCategoryIds.has(params.categoryId)) {
    return { items: [], totalCount: 0, page: 1, totalPages: 1 };
  }

  const products = loaded.products
    .filter((row) => row.categoryId === params.categoryId)
    .sort(
      (a, b) => a.sortOrder - b.sortOrder || compareStrings(a.id, b.id),
    );

  const result = paginate(products, params.page, params.pageSize);
  const { names, descriptions } = await loadEnglishNames(
    db,
    result.items.map((row) => row.id),
  );

  return {
    ...result,
    items: result.items.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      price: row.price,
      name: names.get(row.id) ?? row.slug,
      description: descriptions.get(row.id) ?? null,
    })),
  };
}

export async function readManagedProduct(
  db: Database,
  scope: StoreScope,
  productId: string,
): Promise<ManagedProduct | null> {
  const loaded = await loadCatalog(db, scope);
  const row = loaded.products.find((productRow) => productRow.id === productId);

  if (!row) return null;

  const translations = await db
    .select({
      code: language.code,
      name: productTranslation.name,
      description: productTranslation.description,
      details: productTranslation.details,
    })
    .from(productTranslation)
    .innerJoin(language, eq(language.id, productTranslation.languageId))
    .where(eq(productTranslation.productId, row.id))
    .orderBy(asc(language.code));

  const preferred =
    translations.find((translation) => translation.code === "en") ??
    translations[0];

  return {
    id: row.id,
    categoryId: row.categoryId,
    slug: row.slug,
    price: row.price,
    name: preferred?.name ?? row.slug,
    description: preferred?.description ?? null,
    details: preferred?.details ?? null,
  };
}

export async function readManagedCategory(
  db: Database,
  scope: StoreScope,
  categoryId: string,
): Promise<{ id: string; parentId: string | null; name: string } | null> {
  const loaded = await loadCatalog(db, scope);

  if (!loaded.eligibleCategoryIds.has(categoryId)) {
    return null;
  }

  const row = loaded.categoryById.get(categoryId);
  if (!row) return null;

  const names = await loadEnglishCategoryNames(db, [categoryId]);

  return {
    id: row.id,
    parentId: row.parentId,
    name: names.get(row.id) ?? row.slug,
  };
}
