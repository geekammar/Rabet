import "server-only";

import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  appUser,
  category,
  categoryTranslation,
  language,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  store,
  storeMembership,
} from "@/db/schema";
import { isCategoryAncestryActive } from "@/lib/catalog/eligibility";
import { validatePrice } from "@/lib/catalog/validation";
import {
  mapDatabaseError,
  RabetDataError,
} from "./errors";
import {
  assertOwnershipCompatible,
  resolveLegacyStoreIdForWrite,
} from "./store-context";
import { assertStoreScope, type StoreScope } from "./store-scope";

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

export interface CatalogCategoryRecordWithRevision
  extends CatalogCategoryRecord {
  /** Exact microsecond UTC `updated_at` revision, never a JavaScript Date. */
  revision: string;
  /** Whether the category and every scoped ancestor are available. */
  pathVisible: boolean;
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

export interface CatalogProductRecordWithRevision extends CatalogProductRecord {
  /** Exact microsecond UTC `updated_at` revision, never a JavaScript Date. */
  revision: string;
  /** Whether the product's non-deleted same-store category is active. */
  categoryIsActive: boolean;
  /** Whether the full same-store category path is active and traversable. */
  categoryPathVisible: boolean;
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
      .select({
        id: category.id,
        parentId: category.parentId,
        slug: category.slug,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      })
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
 * Lists one store's non-deleted categories with translations, exact revisions
 * and effective category-path visibility.
 *
 * Ancestry is resolved exclusively from the same scoped rows. A missing,
 * soft-deleted, foreign or cyclic ancestor is not loaded, so the path is
 * reported unavailable without exposing any foreign category id, name or slug.
 */
export async function listCatalogCategoriesForStore(
  db: Database,
  scope: StoreScope,
): Promise<CatalogCategoryRecordWithRevision[]> {
  assertStoreScope(scope);

  try {
    const rows = await db
      .select({
        id: category.id,
        parentId: category.parentId,
        slug: category.slug,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        revision: categoryRevisionSql(),
        translationId: categoryTranslation.id,
        translationLanguageId: categoryTranslation.languageId,
        translationLanguageCode: language.code,
        translationName: categoryTranslation.name,
        translationDescription: categoryTranslation.description,
      })
      .from(category)
      .leftJoin(
        categoryTranslation,
        eq(categoryTranslation.categoryId, category.id),
      )
      .leftJoin(language, eq(categoryTranslation.languageId, language.id))
      .where(
        and(eq(category.storeId, scope.storeId), isNull(category.deletedAt)),
      )
      .orderBy(
        category.sortOrder,
        category.createdAt,
        category.id,
        categoryTranslation.languageId,
      );

    const categories = new Map<string, CatalogCategoryRecordWithRevision>();

    for (const row of rows) {
      let record = categories.get(row.id);

      if (record === undefined) {
        record = {
          id: row.id,
          parentId: row.parentId,
          slug: row.slug,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          revision: row.revision,
          pathVisible: false,
          translations: {},
        };
        categories.set(row.id, record);
      }

      if (
        row.translationId !== null &&
        row.translationLanguageId !== null &&
        row.translationLanguageCode !== null &&
        row.translationName !== null
      ) {
        record.translations[row.translationLanguageCode] = {
          id: row.translationId,
          languageId: row.translationLanguageId,
          name: row.translationName,
          description: row.translationDescription,
        };
      }
    }

    const pathVisibility = new Map<string, boolean>();

    for (const record of categories.values()) {
      let visible = pathVisibility.get(record.id);

      if (visible === undefined) {
        visible = isCategoryAncestryActive(record.id, (id) =>
          categories.get(id),
        );
        pathVisibility.set(record.id, visible);
      }

      record.pathVisible = visible;
    }

    // A parent that is missing, soft-deleted or owned by another store is not
    // part of the scoped result. Do not echo its id: the category keeps its
    // own identity, but its unresolvable parent becomes indistinguishable from
    // a root in the returned record.
    for (const record of categories.values()) {
      if (record.parentId !== null && !categories.has(record.parentId)) {
        record.parentId = null;
      }
    }

    return [...categories.values()];
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
      .select({
        id: product.id,
        categoryId: product.categoryId,
        slug: product.slug,
        price: product.price,
        isActive: product.isActive,
        sortOrder: product.sortOrder,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
      })
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
 * Lists one store's products and translations from one SQL snapshot.
 *
 * This is the Phase 1 tenant-scoped read. It is intentionally separate from the
 * legacy global `listCatalogProducts`: the operator dashboard keeps its current
 * behavior until its reviewed cutover.
 *
 * Isolation has three gates:
 *   1. the scope must be the exact server-minted object;
 *   2. an optional category filter must name a live category owned by the same
 *      store, checked before the product query, so a bad filter can never fall
 *      through to an unfiltered read;
 *   3. every returned product must have `store_id = scope.storeId` *and* a
 *      non-deleted category owned by the same store. The latter excludes an
 *      A-owned product whose category was cross-linked to B under the current
 *      single-column FK, and a product under a soft-deleted category.
 *
 * Products and translations are fetched in one statement. The product-side
 * predicates and the category ownership/deletion checks are part of that same
 * statement, and the LEFT JOIN keeps an eligible product with no translation
 * visible. No other store's translation rows are read at all.
 */
export async function listCatalogProductsForStore(
  db: Database,
  scope: StoreScope,
  categoryId?: string,
): Promise<CatalogProductRecordWithRevision[]> {
  assertStoreScope(scope);

  try {
    if (categoryId !== undefined) {
      const ownedCategory = await db
        .select({ id: category.id })
        .from(category)
        .where(
          and(
            eq(category.id, categoryId),
            eq(category.storeId, scope.storeId),
            isNull(category.deletedAt),
          ),
        )
        .limit(1);

      if (ownedCategory.length === 0) {
        return [];
      }
    }

    const conditions = [
      eq(product.storeId, scope.storeId),
      isNull(product.deletedAt),
    ];

    if (categoryId !== undefined) {
      conditions.push(eq(product.categoryId, categoryId));
    }

    const rows = await db
      .select({
        id: product.id,
        categoryId: product.categoryId,
        slug: product.slug,
        price: product.price,
        isActive: product.isActive,
        sortOrder: product.sortOrder,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        revision: productRevisionSql(),
        categoryIsActive: category.isActive,
        translationId: productTranslation.id,
        translationLanguageId: productTranslation.languageId,
        translationLanguageCode: language.code,
        translationName: productTranslation.name,
        translationDescription: productTranslation.description,
        translationDetails: productTranslation.details,
      })
      .from(product)
      .innerJoin(
        category,
        and(
          eq(product.categoryId, category.id),
          eq(category.storeId, scope.storeId),
          isNull(category.deletedAt),
        ),
      )
      .leftJoin(
        productTranslation,
        eq(productTranslation.productId, product.id),
      )
      .leftJoin(language, eq(productTranslation.languageId, language.id))
      .where(and(...conditions))
      .orderBy(
        product.sortOrder,
        product.createdAt,
        product.id,
        productTranslation.languageId,
      );

    const products = new Map<string, CatalogProductRecordWithRevision>();

    for (const row of rows) {
      let record = products.get(row.id);

      if (record === undefined) {
        record = {
          id: row.id,
          categoryId: row.categoryId,
          slug: row.slug,
          price: row.price,
          isActive: row.isActive,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          revision: row.revision,
          categoryIsActive: row.categoryIsActive,
          categoryPathVisible: false,
          translations: {},
        };
        products.set(row.id, record);
      }

      if (
        row.translationId !== null &&
        row.translationLanguageId !== null &&
        row.translationLanguageCode !== null &&
        row.translationName !== null
      ) {
        record.translations[row.translationLanguageCode] = {
          id: row.translationId,
          languageId: row.translationLanguageId,
          name: row.translationName,
          description: row.translationDescription,
          details: row.translationDetails,
        };
      }
    }

    if (products.size > 0) {
      const categories = await db
        .select({
          id: category.id,
          parentId: category.parentId,
          isActive: category.isActive,
        })
        .from(category)
        .where(
          and(
            eq(category.storeId, scope.storeId),
            isNull(category.deletedAt),
          ),
        );
      const categoryById = new Map(
        categories.map((row) => [row.id, row]),
      );
      const pathVisibility = new Map<string, boolean>();

      for (const record of products.values()) {
        let visible = pathVisibility.get(record.categoryId);

        if (visible === undefined) {
          visible = isCategoryAncestryActive(record.categoryId, (id) =>
            categoryById.get(id),
          );
          pathVisibility.set(record.categoryId, visible);
        }

        record.categoryPathVisible = visible;
      }
    }

    return [...products.values()];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * The shared eligibility predicate for scoped product mutations.
 *
 * A write is allowed only when the target product belongs to the scoped store,
 * is not soft-deleted, and sits under a non-deleted category owned by the same
 * store. Keeping this in a private helper means the availability and price
 * mutations cannot drift apart.
 */
function storeOwnedProductWhere(
  db: Database,
  scope: StoreScope,
  productId: string,
) {
  return and(
    eq(product.id, productId),
    eq(product.storeId, scope.storeId),
    isNull(product.deletedAt),
    exists(
      db
        .select({ id: category.id })
        .from(category)
        .where(
          and(
            eq(category.id, product.categoryId),
            eq(category.storeId, scope.storeId),
            isNull(category.deletedAt),
          ),
        ),
    ),
  );
}

/** The target-category predicate shared by the scoped category mutations. */
function storeOwnedCategoryWhere(
  scope: StoreScope,
  categoryId: string,
) {
  return and(
    eq(category.id, categoryId),
    eq(category.storeId, scope.storeId),
    isNull(category.deletedAt),
  );
}

/**
 * Updates one store-owned product's availability in a single guarded write.
 *
 * The `UPDATE` itself requires the target id, the scope's store id, a
 * non-deleted product, and a non-deleted category owned by the same store.
 * There is no authorization `SELECT` before it, so a foreign or missing id is
 * indistinguishable and writes nothing. Only `is_active` is set; price,
 * translations and product actions are left alone, and the database trigger
 * still maintains `updated_at`.
 *
 * Returns `true` when the row was updated and `false` for every no-match case.
 */
export async function updateCatalogProductAvailabilityForStore(
  db: Database,
  scope: StoreScope,
  productId: string,
  isActive: boolean,
): Promise<boolean> {
  assertStoreScope(scope);

  try {
    const updated = await db
      .update(product)
      .set({ isActive })
      .where(storeOwnedProductWhere(db, scope, productId))
      .returning({ id: product.id });

    return updated.length > 0;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Updates one store-owned product's displayed price in a single guarded write.
 *
 * The price is validated with the same exact-decimal rules as the catalog
 * editor (`validatePrice`): a string only, no exponent, no negative value, at
 * most two decimal places, at most 16 integer digits, and zero is allowed.
 * The normalized value (for example `"19.9"` → `"19.90"`) is passed to SQL as
 * a string; it is never converted to a JavaScript number or rounded.
 *
 * The `UPDATE` requires the target id, the scope's store id, a non-deleted
 * product, and a non-deleted category owned by the same store. There is no
 * authorization `SELECT`, so a foreign or missing id is indistinguishable and
 * writes nothing. Only `price` is set; availability, translations, actions,
 * category, slug and ownership are left alone, and the database trigger still
 * maintains `updated_at`.
 *
 * Returns `true` when the row was updated and `false` for every no-match case.
 *
 * This is the Phase 1 scoped primitive used by the catalog-scope acceptance
 * tests. The production merchant path uses
 * `updateCatalogProductPriceForMerchant`, which adds the write-time
 * eligibility predicates to the same guarded statement.
 */
export async function updateCatalogProductPriceForStore(
  db: Database,
  scope: StoreScope,
  productId: string,
  price: unknown,
): Promise<boolean> {
  assertStoreScope(scope);

  const priceResult = validatePrice(price);
  if (!priceResult.success) {
    throw new RabetDataError("INVALID_INPUT", priceResult.error);
  }

  try {
    const updated = await db
      .update(product)
      .set({ price: priceResult.data })
      .where(storeOwnedProductWhere(db, scope, productId))
      .returning({ id: product.id });

    return updated.length > 0;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/** The exact UTC revision expression shared by reads and guarded writes. */
function productRevisionSql() {
  return sql<string>`to_char(${product.updatedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The category revision uses exactly the same lossless timestamp format. */
function categoryRevisionSql() {
  return sql<string>`to_char(${category.updatedAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The server-derived identity required to bind a merchant price write. */
export type MerchantPriceWriteIdentity = {
  userId: string;
  sessionVersion: number;
};

/**
 * The write-time merchant eligibility predicate.
 *
 * This mirrors `resolveMerchantEligibility` inside the same SQL statement as
 * the guarded merchant write, so a membership revocation, session-version
 * change or store suspension committed before this statement starts can never
 * be bypassed by an access result resolved earlier in the request:
 *
 * - the user is active and has the plain `user` platform role;
 * - `app_user.session_version` still matches the session claim;
 * - the user has exactly one active owner membership;
 * - that membership belongs to the scoped store;
 * - the store is in a writable lifecycle state (`onboarding` or `active`).
 *
 * The write statement evaluates these predicates itself; there is no separate
 * authorization read that the write could race against.
 */
export function merchantWriteEligibilityWhere(
  db: Pick<Database, "select">,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
) {
  return and(
    exists(
      db
        .select({ id: appUser.id })
        .from(appUser)
        .where(
          and(
            eq(appUser.id, identity.userId),
            eq(appUser.status, "active"),
            eq(appUser.platformRole, "user"),
            eq(appUser.sessionVersion, identity.sessionVersion),
          ),
        ),
    ),
    exists(
      db
        .select({ id: storeMembership.id })
        .from(storeMembership)
        .innerJoin(store, eq(store.id, storeMembership.storeId))
        .where(
          and(
            eq(storeMembership.userId, identity.userId),
            eq(storeMembership.storeId, scope.storeId),
            eq(storeMembership.role, "owner"),
            eq(storeMembership.status, "active"),
            inArray(store.status, ["onboarding", "active"]),
          ),
        ),
    ),
    sql`(
      select count(*)::int
      from ${storeMembership}
      where ${storeMembership.userId} = ${identity.userId}
        and ${storeMembership.role} = 'owner'
        and ${storeMembership.status} = 'active'
    ) = 1`,
  );
}

/**
 * Updates one product's price only while the merchant write eligibility still
 * holds in the database.
 *
 * The eligible user id, session version and store scope are all server-derived
 * and are supplied as query parameters. The product/category ownership and
 * deletion predicates are the same used by the scoped catalog mutations, so a
 * missing, foreign, deleted or otherwise ineligible product and a merchant
 * whose eligibility changed all produce the same no-match result.
 *
 * Only `price` is set; availability, translations, actions, category, slug and
 * ownership are left alone, and the database trigger still maintains
 * `updated_at`.
 */
export type MerchantPriceWriteResult = {
  price: string;
  revision: string;
};

export async function updateCatalogProductPriceForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  productId: string,
  price: unknown,
  expectedRevision: string,
): Promise<MerchantPriceWriteResult | null> {
  assertStoreScope(scope);

  const priceResult = validatePrice(price);
  if (!priceResult.success) {
    throw new RabetDataError("INVALID_INPUT", priceResult.error);
  }

  try {
    const updated = await db
      .update(product)
      .set({ price: priceResult.data })
      .where(
        and(
          storeOwnedProductWhere(db, scope, productId),
          merchantWriteEligibilityWhere(db, scope, identity),
          eq(productRevisionSql(), expectedRevision),
        ),
      )
      .returning({
        price: product.price,
        revision: productRevisionSql(),
      });

    return updated[0] ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads the latest authorized price and revision after a guarded write lost its
 * revision precondition.
 *
 * The same product/category and merchant eligibility predicates gate this read,
 * so a revoked membership, suspended store, foreign product or ineligible row
 * yields `null` and never discloses another row's price or revision.
 */
export async function readCatalogProductPriceForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  productId: string,
): Promise<MerchantPriceWriteResult | null> {
  assertStoreScope(scope);

  try {
    const rows = await db
      .select({
        price: product.price,
        revision: productRevisionSql(),
      })
      .from(product)
      .where(
        and(
          storeOwnedProductWhere(db, scope, productId),
          merchantWriteEligibilityWhere(db, scope, identity),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type MerchantAvailabilityWriteResult = {
  isActive: boolean;
  revision: string;
};

/**
 * Updates one product's availability only while the merchant write eligibility
 * still holds in the database.
 *
 * The statement carries the same product/category ownership and deletion
 * predicates as the scoped catalog mutations, the full write-time merchant
 * eligibility predicate, and the exact expected product revision. A stale
 * revision, a revoked membership, a session-version change, a suspended store,
 * a foreign product or a deleted category all produce the same no-match result.
 *
 * Only `is_active` is set; price, translations, actions, category, slug and
 * ownership are left alone, and the database trigger still maintains
 * `updated_at`.
 */
export async function updateCatalogProductAvailabilityForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  productId: string,
  isActive: boolean,
  expectedRevision: string,
): Promise<MerchantAvailabilityWriteResult | null> {
  assertStoreScope(scope);

  try {
    const updated = await db
      .update(product)
      .set({ isActive })
      .where(
        and(
          storeOwnedProductWhere(db, scope, productId),
          merchantWriteEligibilityWhere(db, scope, identity),
          eq(productRevisionSql(), expectedRevision),
        ),
      )
      .returning({
        isActive: product.isActive,
        revision: productRevisionSql(),
      });

    return updated[0] ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads the latest authorized availability and revision after a guarded write
 * lost its revision precondition.
 *
 * The same product/category and merchant eligibility predicates gate this read,
 * so a revoked membership, suspended store, foreign product or ineligible row
 * yields `null` and never discloses another row's availability or revision.
 */
export async function readCatalogProductAvailabilityForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  productId: string,
): Promise<MerchantAvailabilityWriteResult | null> {
  assertStoreScope(scope);

  try {
    const rows = await db
      .select({
        isActive: product.isActive,
        revision: productRevisionSql(),
      })
      .from(product)
      .where(
        and(
          storeOwnedProductWhere(db, scope, productId),
          merchantWriteEligibilityWhere(db, scope, identity),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type MerchantCategoryAvailabilityWriteResult = {
  isActive: boolean;
  revision: string;
};

/**
 * Updates one category's own availability only while the merchant write
 * eligibility still holds in the database.
 *
 * The statement requires the target category to belong to the scoped store and
 * not be soft-deleted, carries the full write-time merchant eligibility
 * predicate, and compares the exact expected category revision. A foreign,
 * missing, deleted or otherwise ineligible category, a stale revision, a
 * revoked membership, a session-version change and a suspended store all
 * produce the same no-match result.
 *
 * Only `is_active` is set. Descendants, products, prices, store status and
 * connection state are untouched, and the database trigger maintains the
 * category's own `updated_at` revision.
 */
export async function updateCatalogCategoryAvailabilityForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  categoryId: string,
  isActive: boolean,
  expectedRevision: string,
): Promise<MerchantCategoryAvailabilityWriteResult | null> {
  assertStoreScope(scope);

  try {
    const updated = await db
      .update(category)
      .set({ isActive })
      .where(
        and(
          storeOwnedCategoryWhere(scope, categoryId),
          merchantWriteEligibilityWhere(db, scope, identity),
          eq(categoryRevisionSql(), expectedRevision),
        ),
      )
      .returning({
        isActive: category.isActive,
        revision: categoryRevisionSql(),
      });

    return updated[0] ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads the latest authorized category availability and revision after a
 * guarded write lost its revision precondition.
 *
 * The scoped ownership and merchant eligibility predicates gate this read, so
 * a foreign or missing category yields `null` and never discloses its saved
 * status or revision.
 */
export async function readCatalogCategoryAvailabilityForMerchant(
  db: Database,
  scope: StoreScope,
  identity: MerchantPriceWriteIdentity,
  categoryId: string,
): Promise<MerchantCategoryAvailabilityWriteResult | null> {
  assertStoreScope(scope);

  try {
    const rows = await db
      .select({
        isActive: category.isActive,
        revision: categoryRevisionSql(),
      })
      .from(category)
      .where(
        and(
          storeOwnedCategoryWhere(scope, categoryId),
          merchantWriteEligibilityWhere(db, scope, identity),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
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
      .select({
        id: category.id,
        parentId: category.parentId,
        slug: category.slug,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
      })
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
      .select({
        id: product.id,
        categoryId: product.categoryId,
        slug: product.slug,
        price: product.price,
        isActive: product.isActive,
        sortOrder: product.sortOrder,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
      })
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    // 1. If parentId is specified, verify it exists and is not soft-deleted
    if (input.parentId !== null) {
      const parentRows = await db
        .select({
          id: category.id,
          storeId: category.storeId,
          deletedAt: category.deletedAt,
        })
        .from(category)
        .where(eq(category.id, input.parentId));

      if (parentRows.length === 0 || parentRows[0].deletedAt !== null) {
        throw new RabetDataError(
          "NOT_FOUND",
          "The selected parent category does not exist or has been deleted.",
        );
      }

      assertOwnershipCompatible(
        storeId,
        parentRows[0].storeId,
        "The parent category belongs to a different store.",
      );
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
      storeId,
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
  translations?: Array<{
    languageId: string;
    name: string;
    description?: string | null;
  }> | null;
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const existing = await db
      .select({
        id: category.id,
        storeId: category.storeId,
        deletedAt: category.deletedAt,
      })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      existing[0].storeId,
      "The category belongs to a different store.",
    );

    const categoryUpdate = db
      .update(category)
      .set({
        slug: input.slug,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(and(eq(category.id, input.categoryId), isNull(category.deletedAt)));

    const queries: unknown[] = [categoryUpdate];

    const translationsToPersist =
      input.translations ?? (input.translation ? [input.translation] : []);

    for (const translation of translationsToPersist) {
      queries.push(
        db
          .insert(categoryTranslation)
          .values({
            id: globalThis.crypto.randomUUID(),
            categoryId: input.categoryId,
            languageId: translation.languageId,
            name: translation.name,
            description: translation.description ?? null,
          })
          .onConflictDoUpdate({
            target: [
              categoryTranslation.categoryId,
              categoryTranslation.languageId,
            ],
            set: {
              name: translation.name,
              description: translation.description ?? null,
              updatedAt: sql`now()`,
            },
          }),
      );
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const existing = await db
      .select({
        id: category.id,
        storeId: category.storeId,
        deletedAt: category.deletedAt,
      })
      .from(category)
      .where(eq(category.id, categoryId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      existing[0].storeId,
      "The category belongs to a different store.",
    );

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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const catRows = await db
      .select({
        id: category.id,
        storeId: category.storeId,
        deletedAt: category.deletedAt,
      })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (catRows.length === 0 || catRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The category does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      catRows[0].storeId,
      "The category belongs to a different store.",
    );

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

export interface CreateProductDefaultInquiryInput {
  translations: Array<{
    languageId: string;
    label: string;
  }>;
}

export interface CreateProductInput {
  categoryId: string;
  slug: string;
  price: string;
  translations: CreateProductTranslationInput[];
  defaultInquiry?: CreateProductDefaultInquiryInput | null;
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const catRows = await db
      .select({
        id: category.id,
        storeId: category.storeId,
        deletedAt: category.deletedAt,
      })
      .from(category)
      .where(eq(category.id, input.categoryId));

    if (catRows.length === 0 || catRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The target category does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      catRows[0].storeId,
      "The target category belongs to a different store.",
    );

    const [maxRow] = await db
      .select({ maxOrder: sql<number | null>`max(${product.sortOrder})` })
      .from(product)
      .where(eq(product.categoryId, input.categoryId));
    const max = maxRow?.maxOrder;
    const nextOrder = typeof max === "number" ? max + 1 : 0;

    const productId = globalThis.crypto.randomUUID();

    const productInsert = db.insert(product).values({
      id: productId,
      storeId,
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

    const defaultInquiryQueries: unknown[] = [];
    if (input.defaultInquiry && input.defaultInquiry.translations.length > 0) {
      const actionId = globalThis.crypto.randomUUID();

      defaultInquiryQueries.push(
        db.insert(productAction).values({
          id: actionId,
          productId,
          parentActionId: null,
          actionType: "START_INQUIRY",
          sortOrder: 0,
          isActive: true,
        }),
      );

      for (const translation of input.defaultInquiry.translations) {
        defaultInquiryQueries.push(
          db.insert(productActionTranslation).values({
            id: globalThis.crypto.randomUUID(),
            actionId,
            languageId: translation.languageId,
            label: translation.label,
          }),
        );
      }
    }

    await executeAtomicBatch(db, [
      productInsert,
      ...translationInserts,
      ...defaultInquiryQueries,
    ]);

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
  categoryId?: string;
  slug: string;
  price: string;
  isActive: boolean;
  translation?: {
    languageId: string;
    name: string;
    description?: string | null;
    details?: string | null;
  } | null;
  translations?: Array<{
    languageId: string;
    name: string;
    description?: string | null;
    details?: string | null;
  }> | null;
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const existing = await db
      .select({
        id: product.id,
        storeId: product.storeId,
        categoryId: product.categoryId,
        deletedAt: product.deletedAt,
      })
      .from(product)
      .where(eq(product.id, input.productId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      existing[0].storeId,
      "The product belongs to a different store.",
    );

    if (input.categoryId && input.categoryId !== existing[0].categoryId) {
      const [targetCategory] = await db
        .select({
          id: category.id,
          storeId: category.storeId,
          deletedAt: category.deletedAt,
        })
        .from(category)
        .where(eq(category.id, input.categoryId))
        .limit(1);

      if (!targetCategory || targetCategory.deletedAt !== null) {
        throw new RabetDataError(
          "NOT_FOUND",
          "The selected category does not exist or has been deleted.",
        );
      }

      assertOwnershipCompatible(
        existing[0].storeId,
        targetCategory.storeId,
        "The product and the selected category belong to different stores.",
      );
      assertOwnershipCompatible(
        storeId,
        targetCategory.storeId,
        "The selected category belongs to a different store.",
      );
    }

    const productUpdate = db
      .update(product)
      .set({
        categoryId: input.categoryId ?? existing[0].categoryId,
        slug: input.slug,
        price: input.price,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(and(eq(product.id, input.productId), isNull(product.deletedAt)));

    const queries: unknown[] = [productUpdate];

    const translationsToPersist =
      input.translations ?? (input.translation ? [input.translation] : []);

    for (const translation of translationsToPersist) {
      queries.push(
        db
          .insert(productTranslation)
          .values({
            id: globalThis.crypto.randomUUID(),
            productId: input.productId,
            languageId: translation.languageId,
            name: translation.name,
            description: translation.description ?? null,
            details: translation.details ?? null,
          })
          .onConflictDoUpdate({
            target: [
              productTranslation.productId,
              productTranslation.languageId,
            ],
            set: {
              name: translation.name,
              description: translation.description ?? null,
              details: translation.details ?? null,
              updatedAt: sql`now()`,
            },
          }),
      );
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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const existing = await db
      .select({
        id: product.id,
        storeId: product.storeId,
        deletedAt: product.deletedAt,
      })
      .from(product)
      .where(eq(product.id, productId));

    if (existing.length === 0 || existing[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      existing[0].storeId,
      "The product belongs to a different store.",
    );

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
    const storeId = await resolveLegacyStoreIdForWrite(db);

    const prodRows = await db
      .select({
        id: product.id,
        storeId: product.storeId,
        deletedAt: product.deletedAt,
      })
      .from(product)
      .where(eq(product.id, input.productId));

    if (prodRows.length === 0 || prodRows[0].deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "The product does not exist or has been deleted.",
      );
    }

    assertOwnershipCompatible(
      storeId,
      prodRows[0].storeId,
      "The product belongs to a different store.",
    );

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
