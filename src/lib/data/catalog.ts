import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
} from "@/db/schema";
import {
  mapDatabaseError,
  RabetDataError,
} from "./errors";

/**
 * ===========================================================================
 * Server-only catalog & product data access functions (Phase 05-A).
 * ===========================================================================
 */

export interface CatalogCategoryRecord {
  id: string;
  parentId: string | null;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  translations: Record<
    string,
    {
      id: string;
      languageId: string;
      name: string;
      description: string | null;
    }
  >;
}

export interface CatalogProductRecord {
  id: string;
  categoryId: string;
  slug: string;
  price: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  translations: Record<
    string,
    {
      id: string;
      languageId: string;
      name: string;
      description: string | null;
      details: string | null;
    }
  >;
}

type BatchCapableDb = {
  batch: (queries: unknown[]) => Promise<unknown[]>;
};

type TransactionCapableDb = {
  transaction: <T>(
    cb: (tx: {
      execute: (stmt: import("drizzle-orm").SQLWrapper | string) => Promise<unknown>;
    }) => Promise<T>,
  ) => Promise<T>;
};

function isBatchCapable(target: unknown): target is BatchCapableDb {
  return (
    typeof target === "object" &&
    target !== null &&
    "batch" in target &&
    typeof (target as Record<string, unknown>).batch === "function"
  );
}

function isTransactionCapable(target: unknown): target is TransactionCapableDb {
  return (
    typeof target === "object" &&
    target !== null &&
    "transaction" in target &&
    typeof (target as Record<string, unknown>).transaction === "function"
  );
}

/**
 * Wraps an SQL template statement so it can participate in non-interactive `db.batch` on Neon HTTP
 * or `executeAtomicBatch` on both Neon HTTP and Postgres-js.
 */
export function toBatchable(
  db: Database,
  sqlWrapper: import("drizzle-orm").SQLWrapper,
) {
  return {
    _prepare() {
      const dialect = (
        db as unknown as {
          dialect?: { sqlToQuery: (s: unknown) => { sql: string; params: unknown[] } };
        }
      ).dialect;
      const built = dialect
        ? dialect.sqlToQuery(sqlWrapper.getSQL())
        : { sql: "", params: [] };
      return {
        getQuery: () => built,
        isResponseInArrayMode: () => false,
        mapResult: (res: { rows?: unknown[] } | unknown[]) =>
          Array.isArray(res) ? res : res?.rows ?? [],
      };
    },
    getSQL: () => sqlWrapper.getSQL(),
  };
}

/**
 * Executes a batch of statements atomically.
 * On Neon HTTP, uses the driver's native non-interactive `db.batch(...)`.
 * In environments where `db.batch` is not supported (such as postgres-js test runner),
 * uses an atomic transaction on the underlying client.
 */
export async function executeAtomicBatch(
  db: Database,
  queries: unknown[],
): Promise<unknown[]> {
  if (isBatchCapable(db)) {
    return db.batch(queries);
  }
  if (isTransactionCapable(db)) {
    return db.transaction(async (tx) => {
      const results: unknown[] = [];
      for (const query of queries) {
        const sqlStmt =
          typeof query === "object" && query !== null && "getSQL" in query
            ? (query as { getSQL: () => import("drizzle-orm").SQL }).getSQL()
            : (query as import("drizzle-orm").SQLWrapper | string);
        results.push(await tx.execute(sqlStmt));
      }
      return results;
    });
  }
  throw new Error(
    "Database client does not support batch or transaction execution.",
  );
}

/**
 * Lists all non-deleted categories and their saved translations.
 */
export async function listCatalogCategories(
  db: Database,
): Promise<CatalogCategoryRecord[]> {
  try {
    const categories = await db
      .select()
      .from(category)
      .where(isNull(category.deletedAt))
      .orderBy(category.sortOrder, category.createdAt, category.id);

    if (categories.length === 0) {
      return [];
    }

    const translations = await db
      .select({
        id: categoryTranslation.id,
        categoryId: categoryTranslation.categoryId,
        languageId: categoryTranslation.languageId,
        languageCode: language.code,
        name: categoryTranslation.name,
        description: categoryTranslation.description,
      })
      .from(categoryTranslation)
      .innerJoin(language, eq(categoryTranslation.languageId, language.id));

    const transByCatId = new Map<
      string,
      Record<
        string,
        {
          id: string;
          languageId: string;
          name: string;
          description: string | null;
        }
      >
    >();

    for (const t of translations) {
      const existing = transByCatId.get(t.categoryId) ?? {};
      existing[t.languageCode] = {
        id: t.id,
        languageId: t.languageId,
        name: t.name,
        description: t.description,
      };
      transByCatId.set(t.categoryId, existing);
    }

    return categories.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      slug: c.slug,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      translations: transByCatId.get(c.id) ?? {},
    }));
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Lists all non-deleted products (optionally scoped to a category) with their saved translations.
 */
export async function listCatalogProducts(
  db: Database,
  categoryId?: string,
): Promise<CatalogProductRecord[]> {
  try {
    const conditions = [isNull(product.deletedAt)];
    if (categoryId) {
      conditions.push(eq(product.categoryId, categoryId));
    }

    const products = await db
      .select()
      .from(product)
      .where(and(...conditions))
      .orderBy(product.sortOrder, product.createdAt, product.id);

    if (products.length === 0) {
      return [];
    }

    const translations = await db
      .select({
        id: productTranslation.id,
        productId: productTranslation.productId,
        languageId: productTranslation.languageId,
        languageCode: language.code,
        name: productTranslation.name,
        description: productTranslation.description,
        details: productTranslation.details,
      })
      .from(productTranslation)
      .innerJoin(language, eq(productTranslation.languageId, language.id));

    const transByProdId = new Map<
      string,
      Record<
        string,
        {
          id: string;
          languageId: string;
          name: string;
          description: string | null;
          details: string | null;
        }
      >
    >();

    for (const t of translations) {
      const existing = transByProdId.get(t.productId) ?? {};
      existing[t.languageCode] = {
        id: t.id,
        languageId: t.languageId,
        name: t.name,
        description: t.description,
        details: t.details,
      };
      transByProdId.set(t.productId, existing);
    }

    return products.map((p) => ({
      id: p.id,
      categoryId: p.categoryId,
      slug: p.slug,
      price: p.price,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      translations: transByProdId.get(p.id) ?? {},
    }));
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads a single category by ID with translations.
 */
export async function readCatalogCategory(
  db: Database,
  id: string,
): Promise<CatalogCategoryRecord | null> {
  try {
    const rows = await db
      .select()
      .from(category)
      .where(and(eq(category.id, id), isNull(category.deletedAt)));

    if (rows.length === 0) {
      return null;
    }

    const c = rows[0];
    const translations = await db
      .select({
        id: categoryTranslation.id,
        categoryId: categoryTranslation.categoryId,
        languageId: categoryTranslation.languageId,
        languageCode: language.code,
        name: categoryTranslation.name,
        description: categoryTranslation.description,
      })
      .from(categoryTranslation)
      .innerJoin(language, eq(categoryTranslation.languageId, language.id))
      .where(eq(categoryTranslation.categoryId, id));

    const transMap: Record<
      string,
      {
        id: string;
        languageId: string;
        name: string;
        description: string | null;
      }
    > = {};

    for (const t of translations) {
      transMap[t.languageCode] = {
        id: t.id,
        languageId: t.languageId,
        name: t.name,
        description: t.description,
      };
    }

    return {
      id: c.id,
      parentId: c.parentId,
      slug: c.slug,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      translations: transMap,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads a single product by ID with translations.
 */
export async function readCatalogProduct(
  db: Database,
  id: string,
): Promise<CatalogProductRecord | null> {
  try {
    const rows = await db
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));

    if (rows.length === 0) {
      return null;
    }

    const p = rows[0];
    const translations = await db
      .select({
        id: productTranslation.id,
        productId: productTranslation.productId,
        languageId: productTranslation.languageId,
        languageCode: language.code,
        name: productTranslation.name,
        description: productTranslation.description,
        details: productTranslation.details,
      })
      .from(productTranslation)
      .innerJoin(language, eq(productTranslation.languageId, language.id))
      .where(eq(productTranslation.productId, id));

    const transMap: Record<
      string,
      {
        id: string;
        languageId: string;
        name: string;
        description: string | null;
        details: string | null;
      }
    > = {};

    for (const t of translations) {
      transMap[t.languageCode] = {
        id: t.id,
        languageId: t.languageId,
        name: t.name,
        description: t.description,
        details: t.details,
      };
    }

    return {
      id: p.id,
      categoryId: p.categoryId,
      slug: p.slug,
      price: p.price,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      translations: transMap,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface CreateCategoryTranslationInput {
  languageId: string;
  name: string;
  description?: string | null;
}

export interface CreateCategoryInput {
  parentId: string | null;
  slug: string;
  translations: CreateCategoryTranslationInput[];
}

/**
 * Atomically creates a category and its initial translations.
 *
 * Rules:
 * - Parent category must exist and must not be soft-deleted.
 * - Sibling sort order accounts for all rows covered by the unique index (including soft-deleted rows).
 * - Created category starts inactive (is_active = false).
 * - Category and its default-language translation are created atomically in a batch.
 */
export async function createCatalogCategory(
  db: Database,
  input: CreateCategoryInput,
): Promise<{ categoryId: string; category: CatalogCategoryRecord }> {
  try {
    // 1. If parentId is specified, verify it exists and is not soft-deleted
    if (input.parentId !== null) {
      const parentRows = await db
        .select({ id: category.id, deletedAt: category.deletedAt })
        .from(category)
        .where(eq(category.id, input.parentId));

      if (parentRows.length === 0 || parentRows[0].deletedAt !== null) {
        throw new RabetDataError(
          "NOT_FOUND",
          "The selected parent category does not exist or has been deleted.",
        );
      }
    }

    // 2. Calculate next sort order among siblings.
    // NOTE: The unique partial indexes on category (category_sibling_sort_order_idx and
    // category_root_sort_order_idx) cover ALL rows where deleted_at IS NULL or NOT NULL!
    // So soft-deleted rows must be included in the max sort order query.
    let nextOrder = 0;
    if (input.parentId === null) {
      const [maxRow] = await db
        .select({ maxOrder: sql<number | null>`max(${category.sortOrder})` })
        .from(category)
        .where(isNull(category.parentId));
      const max = maxRow?.maxOrder;
      nextOrder = typeof max === "number" ? max + 1 : 0;
    } else {
      const [maxRow] = await db
        .select({ maxOrder: sql<number | null>`max(${category.sortOrder})` })
        .from(category)
        .where(eq(category.parentId, input.parentId));
      const max = maxRow?.maxOrder;
      nextOrder = typeof max === "number" ? max + 1 : 0;
    }

    const categoryId = globalThis.crypto.randomUUID();

    // 3. Prepare atomic batch queries
    const categoryInsert = db.insert(category).values({
      id: categoryId,
      parentId: input.parentId,
      slug: input.slug,
      sortOrder: nextOrder,
      isActive: false,
    });

    const translationInserts = input.translations.map((t) =>
      db.insert(categoryTranslation).values({
        id: globalThis.crypto.randomUUID(),
        categoryId,
        languageId: t.languageId,
        name: t.name,
        description: t.description ?? null,
      }),
    );

    await executeAtomicBatch(db, [categoryInsert, ...translationInserts]);

    const createdRecord = await readCatalogCategory(db, categoryId);
    if (!createdRecord) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read category after creation.",
      );
    }

    return { categoryId, category: createdRecord };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export interface EditCategoryInput {
  categoryId: string;
  slug: string;
  isActive: boolean;
  translation?: {
    languageId: string;
    name: string;
    description?: string | null;
  } | null;
}

/**
 * Atomically updates category base fields (slug, isActive) and optionally
 * upserts a translation for a specific language in a single atomic batch.
 *
 * Rules:
 * - Category must exist and must not be soft-deleted.
 * - Base fields and translation are committed together.
 * - If translation persistence fails, base fields remain unchanged.
 * - Translations in other languages are preserved.
 * - Returns the authoritative updated record from the database.
 */
export async function editCatalogCategory(
  db: Database,
  input: EditCategoryInput,
): Promise<{ category: CatalogCategoryRecord }> {
  try {
    const existing = await db
      .select({ id: category.id, deletedAt: category.deletedAt })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    const categoryUpdate = db
      .update(category)
      .set({
        slug: input.slug,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(and(eq(category.id, input.categoryId), isNull(category.deletedAt)));

    const queries: unknown[] = [categoryUpdate];

    if (input.translation) {
      const translationUpsert = db
        .insert(categoryTranslation)
        .values({
          id: globalThis.crypto.randomUUID(),
          categoryId: input.categoryId,
          languageId: input.translation.languageId,
          name: input.translation.name,
          description: input.translation.description ?? null,
        })
        .onConflictDoUpdate({
          target: [
            categoryTranslation.categoryId,
            categoryTranslation.languageId,
          ],
          set: {
            name: input.translation.name,
            description: input.translation.description ?? null,
            updatedAt: sql`now()`,
          },
        });
      queries.push(translationUpsert);
    }

    await executeAtomicBatch(db, queries);

    const updated = await readCatalogCategory(db, input.categoryId);
    if (!updated) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read category after update.",
      );
    }

    return { category: updated };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * Updates a category's base attributes (slug, isActive).
 */
export async function updateCatalogCategory(
  db: Database,
  categoryId: string,
  input: {
    slug?: string;
    isActive?: boolean;
  },
): Promise<void> {
  try {
    const existing = await db
      .select({ id: category.id, deletedAt: category.deletedAt })
      .from(category)
      .where(eq(category.id, categoryId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    const updates: Record<string, unknown> = {};
    if (input.slug !== undefined) updates.slug = input.slug;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    if (Object.keys(updates).length > 0) {
      await db
        .update(category)
        .set(updates)
        .where(eq(category.id, categoryId));
    }
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * Saves or updates a translation for a category.
 * Preserves translations in other languages.
 */
export async function saveCatalogCategoryTranslation(
  db: Database,
  input: {
    categoryId: string;
    languageId: string;
    name: string;
    description?: string | null;
  },
): Promise<void> {
  try {
    const catRows = await db
      .select({ id: category.id, deletedAt: category.deletedAt })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (catRows.length === 0 || catRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    await db
      .insert(categoryTranslation)
      .values({
        id: globalThis.crypto.randomUUID(),
        categoryId: input.categoryId,
        languageId: input.languageId,
        name: input.name,
        description: input.description ?? null,
      })
      .onConflictDoUpdate({
        target: [
          categoryTranslation.categoryId,
          categoryTranslation.languageId,
        ],
        set: {
          name: input.name,
          description: input.description ?? null,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export interface CreateProductTranslationInput {
  languageId: string;
  name: string;
  description?: string | null;
  details?: string | null;
}

export interface CreateProductInput {
  categoryId: string;
  slug: string;
  price: string;
  translations: CreateProductTranslationInput[];
}

/**
 * Atomically creates a product and its initial translations.
 *
 * Rules:
 * - Target category must exist and must not be soft-deleted.
 * - Product starts inactive (is_active = false).
 * - Sibling order is deterministic.
 * - Product and translations are created atomically.
 */
export async function createCatalogProduct(
  db: Database,
  input: CreateProductInput,
): Promise<{ productId: string; product: CatalogProductRecord }> {
  try {
    const catRows = await db
      .select({ id: category.id, deletedAt: category.deletedAt })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (catRows.length === 0 || catRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The target category does not exist or has been deleted.",
      );
    }

    const [maxRow] = await db
      .select({ maxOrder: sql<number | null>`max(${product.sortOrder})` })
      .from(product)
      .where(eq(product.categoryId, input.categoryId));
    const max = maxRow?.maxOrder;
    const nextOrder = typeof max === "number" ? max + 1 : 0;

    const productId = globalThis.crypto.randomUUID();

    const productInsert = db.insert(product).values({
      id: productId,
      categoryId: input.categoryId,
      slug: input.slug,
      price: input.price,
      sortOrder: nextOrder,
      isActive: false,
    });

    const translationInserts = input.translations.map((t) =>
      db.insert(productTranslation).values({
        id: globalThis.crypto.randomUUID(),
        productId,
        languageId: t.languageId,
        name: t.name,
        description: t.description ?? null,
        details: t.details ?? null,
      }),
    );

    await executeAtomicBatch(db, [productInsert, ...translationInserts]);

    const createdRecord = await readCatalogProduct(db, productId);
    if (!createdRecord) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read product after creation.",
      );
    }

    return { productId, product: createdRecord };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export interface EditProductInput {
  productId: string;
  slug: string;
  price: string;
  isActive: boolean;
  translation?: {
    languageId: string;
    name: string;
    description?: string | null;
    details?: string | null;
  } | null;
}

/**
 * Atomically updates product base fields (slug, price, isActive) and optionally
 * upserts a translation for a specific language in a single atomic batch.
 *
 * Rules:
 * - Product must exist and must not be soft-deleted.
 * - Base fields and translation are committed together.
 * - If translation persistence fails, base fields remain unchanged.
 * - Translations in other languages are preserved.
 * - Returns the authoritative updated record from the database.
 */
export async function editCatalogProduct(
  db: Database,
  input: EditProductInput,
): Promise<{ product: CatalogProductRecord }> {
  try {
    const existing = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, input.productId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    const productUpdate = db
      .update(product)
      .set({
        slug: input.slug,
        price: input.price,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(and(eq(product.id, input.productId), isNull(product.deletedAt)));

    const queries: unknown[] = [productUpdate];

    if (input.translation) {
      const translationUpsert = db
        .insert(productTranslation)
        .values({
          id: globalThis.crypto.randomUUID(),
          productId: input.productId,
          languageId: input.translation.languageId,
          name: input.translation.name,
          description: input.translation.description ?? null,
          details: input.translation.details ?? null,
        })
        .onConflictDoUpdate({
          target: [
            productTranslation.productId,
            productTranslation.languageId,
          ],
          set: {
            name: input.translation.name,
            description: input.translation.description ?? null,
            details: input.translation.details ?? null,
            updatedAt: sql`now()`,
          },
        });
      queries.push(translationUpsert);
    }

    await executeAtomicBatch(db, queries);

    const updated = await readCatalogProduct(db, input.productId);
    if (!updated) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read product after update.",
      );
    }

    return { product: updated };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * Updates a product's base attributes (slug, price, isActive).
 */
export async function updateCatalogProduct(
  db: Database,
  productId: string,
  input: {
    slug?: string;
    price?: string;
    isActive?: boolean;
  },
): Promise<void> {
  try {
    const existing = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, productId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    const updates: Record<string, unknown> = {};
    if (input.slug !== undefined) updates.slug = input.slug;
    if (input.price !== undefined) updates.price = input.price;
    if (input.isActive !== undefined) updates.isActive = input.isActive;

    if (Object.keys(updates).length > 0) {
      await db
        .update(product)
        .set(updates)
        .where(eq(product.id, productId));
    }
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

/**
 * Saves or updates a translation for a product.
 * Preserves translations in other languages.
 */
export async function saveCatalogProductTranslation(
  db: Database,
  input: {
    productId: string;
    languageId: string;
    name: string;
    description?: string | null;
    details?: string | null;
  },
): Promise<void> {
  try {
    const prodRows = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, input.productId));

    if (prodRows.length === 0 || prodRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    await db
      .insert(productTranslation)
      .values({
        id: globalThis.crypto.randomUUID(),
        productId: input.productId,
        languageId: input.languageId,
        name: input.name,
        description: input.description ?? null,
        details: input.details ?? null,
      })
      .onConflictDoUpdate({
        target: [
          productTranslation.productId,
          productTranslation.languageId,
        ],
        set: {
          name: input.name,
          description: input.description ?? null,
          details: input.details ?? null,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}
