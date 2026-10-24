import "server-only";

import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  botSetting,
  category,
  language,
  product,
  productAction,
  productActionTranslation,
} from "@/db/schema";
import {
  MAX_ACTION_DEPTH,
  MAX_ACTIVE_CHILDREN,
  type SupportedActionType,
} from "@/lib/product-actions/constants";
import { executeAtomicBatch } from "./catalog";
import { mapDatabaseError, RabetDataError } from "./errors";

/**
 * ===========================================================================
 * Server-only product action data access functions (Phase 05-B1 & Phase 05-B2).
 * ===========================================================================
 */

export interface ProductActionRecord {
  id: string;
  productId: string;
  parentActionId: string | null;
  actionType: (typeof productAction.actionType.enumValues)[number];
  sortOrder: number;
  isActive: boolean;
  url: string | null;
  navigateCategoryId: string | null;
  navigateProductId: string | null;
  actionConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
  translations: Record<
    string,
    {
      id: string;
      languageId: string;
      label: string;
      menuText: string | null;
      templateBody: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >;
}

export interface CreateProductActionData {
  productId: string;
  parentActionId?: string | null;
  actionType: SupportedActionType;
  isActive?: boolean;
  url?: string | null;
  navigateCategoryId?: string | null;
  navigateProductId?: string | null;
  actionConfig?: Record<string, unknown>;
  translations: Array<{
    languageId: string;
    languageCode: string;
    label: string;
    menuText?: string | null;
    templateBody?: string | null;
  }>;
}

export interface EditProductActionData {
  actionId: string;
  productId: string;
  actionType: SupportedActionType;
  isActive: boolean;
  url?: string | null;
  navigateCategoryId?: string | null;
  navigateProductId?: string | null;
  actionConfig?: Record<string, unknown>;
  translation?: {
    languageId: string;
    languageCode: string;
    label: string;
    menuText?: string | null;
    templateBody?: string | null;
  };
}

/**
 * Lists all actions for a product with their translations, ordered by sortOrder ASC, createdAt ASC.
 */
export async function listProductActions(
  db: Database,
  productId: string,
): Promise<ProductActionRecord[]> {
  try {
    // 1. Verify referenced product exists and is not soft-deleted
    const [targetProduct] = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, productId))
      .limit(1);

    if (!targetProduct || targetProduct.deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "Referenced product does not exist or has been deleted.",
      );
    }

    const actionRows = await db
      .select()
      .from(productAction)
      .where(eq(productAction.productId, productId))
      .orderBy(productAction.sortOrder, productAction.createdAt);

    if (actionRows.length === 0) {
      return [];
    }

    const actionIds = actionRows.map((a) => a.id);

    const transRows = await db
      .select({
        id: productActionTranslation.id,
        actionId: productActionTranslation.actionId,
        languageId: productActionTranslation.languageId,
        languageCode: language.code,
        label: productActionTranslation.label,
        menuText: productActionTranslation.menuText,
        templateBody: productActionTranslation.templateBody,
        createdAt: productActionTranslation.createdAt,
        updatedAt: productActionTranslation.updatedAt,
      })
      .from(productActionTranslation)
      .innerJoin(language, eq(productActionTranslation.languageId, language.id))
      .where(
        sql`${productActionTranslation.actionId} IN (${sql.join(
          actionIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );

    const translationsByAction = new Map<
      string,
      Record<string, ProductActionRecord["translations"][string]>
    >();

    for (const row of transRows) {
      const list = translationsByAction.get(row.actionId) ?? {};
      list[row.languageCode] = {
        id: row.id,
        languageId: row.languageId,
        label: row.label,
        menuText: row.menuText,
        templateBody: row.templateBody,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      translationsByAction.set(row.actionId, list);
    }

    return actionRows.map((row) => ({
      ...row,
      translations: translationsByAction.get(row.id) ?? {},
    }));
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Reads a single action by id with its translations.
 */
export async function readProductAction(
  db: Database,
  actionId: string,
): Promise<ProductActionRecord | null> {
  try {
    const [actionRow] = await db
      .select()
      .from(productAction)
      .where(eq(productAction.id, actionId))
      .limit(1);

    if (!actionRow) return null;

    const transRows = await db
      .select({
        id: productActionTranslation.id,
        actionId: productActionTranslation.actionId,
        languageId: productActionTranslation.languageId,
        languageCode: language.code,
        label: productActionTranslation.label,
        menuText: productActionTranslation.menuText,
        templateBody: productActionTranslation.templateBody,
        createdAt: productActionTranslation.createdAt,
        updatedAt: productActionTranslation.updatedAt,
      })
      .from(productActionTranslation)
      .innerJoin(language, eq(productActionTranslation.languageId, language.id))
      .where(eq(productActionTranslation.actionId, actionId));

    const translations: ProductActionRecord["translations"] = {};
    for (const row of transRows) {
      translations[row.languageCode] = {
        id: row.id,
        languageId: row.languageId,
        label: row.label,
        menuText: row.menuText,
        templateBody: row.templateBody,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }

    return {
      ...actionRow,
      translations,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Creates a new product action and its required initial translations atomically.
 */
export async function createProductAction(
  db: Database,
  input: CreateProductActionData,
): Promise<{ actionId: string; action: ProductActionRecord }> {
  try {
    // 1. Verify referenced product exists and is not soft-deleted
    const [targetProduct] = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, input.productId))
      .limit(1);

    if (!targetProduct || targetProduct.deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "Referenced product does not exist or has been deleted.",
      );
    }

    const parentId = input.parentActionId?.trim() || null;
    const isActive = input.isActive ?? true;

    // 2. Validate parent if specified
    if (parentId) {
      const [parentAction] = await db
        .select({
          id: productAction.id,
          productId: productAction.productId,
          parentActionId: productAction.parentActionId,
          actionType: productAction.actionType,
        })
        .from(productAction)
        .where(eq(productAction.id, parentId))
        .limit(1);

      if (!parentAction) {
        throw new RabetDataError("NOT_FOUND", "Referenced parent button does not exist.");
      }

      if (parentAction.productId !== input.productId) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "Parent button belongs to a different product.",
        );
      }

      if (parentAction.actionType !== "OPEN_SUBMENU") {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Only OPEN_SUBMENU buttons can have children. Parent has type "${parentAction.actionType}".`,
        );
      }

      // 3. Ancestor walk: cycle check and MAX_ACTION_DEPTH safeguard
      let currentParentId: string | null = parentAction.parentActionId;
      let depth = 2; // parent is at least depth 1, so new child will be at least depth 2 (level 2)
      const visited = new Set<string>([parentId]);

      while (currentParentId) {
        if (visited.has(currentParentId)) {
          throw new RabetDataError("INVALID_INPUT", "Action hierarchy cycle detected.");
        }
        visited.add(currentParentId);

        const [ancestor] = await db
          .select({
            id: productAction.id,
            productId: productAction.productId,
            parentActionId: productAction.parentActionId,
          })
          .from(productAction)
          .where(eq(productAction.id, currentParentId))
          .limit(1);

        if (!ancestor) break;
        if (ancestor.productId !== input.productId) {
          throw new RabetDataError(
            "INVALID_INPUT",
            "Ancestor button belongs to a different product.",
          );
        }

        depth++;
        if (depth > MAX_ACTION_DEPTH) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `Maximum action hierarchy depth exceeded (${MAX_ACTION_DEPTH} levels).`,
          );
        }

        currentParentId = ancestor.parentActionId;
      }
    }

    // 4. Type-specific pre-insert target validation
    if (input.actionType === "NAVIGATE_CATALOG") {
      const catId = input.navigateCategoryId?.trim() || null;
      const prodId = input.navigateProductId?.trim() || null;

      if (!catId && !prodId) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "NAVIGATE_CATALOG requires either a category or a product navigation target.",
        );
      }
      if (catId && prodId) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "Cannot specify both a category and a product navigation target.",
        );
      }

      if (catId) {
        const [targetCat] = await db
          .select({ id: category.id, deletedAt: category.deletedAt })
          .from(category)
          .where(eq(category.id, catId))
          .limit(1);

        if (!targetCat || targetCat.deletedAt !== null) {
          throw new RabetDataError(
            "NOT_FOUND",
            "Referenced navigation target category does not exist or has been deleted.",
          );
        }
      }

      if (prodId) {
        const [targetProd] = await db
          .select({ id: product.id, deletedAt: product.deletedAt })
          .from(product)
          .where(eq(product.id, prodId))
          .limit(1);

        if (!targetProd || targetProd.deletedAt !== null) {
          throw new RabetDataError(
            "NOT_FOUND",
            "Referenced navigation target product does not exist or has been deleted.",
          );
        }
      }
    }

    if (input.actionType === "OPEN_SUPPORT" && input.actionConfig) {
      const cat = (input.actionConfig as { support_category?: string }).support_category;
      if (cat && typeof cat === "string" && cat.trim().length > 0) {
        const [settings] = await db
          .select({ supportCategory: botSetting.supportCategory })
          .from(botSetting)
          .where(eq(botSetting.id, 1))
          .limit(1);

        const configured = settings?.supportCategory ?? [];
        if (!configured.includes(cat.trim())) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `Support category "${cat.trim()}" is not configured in store settings.`,
          );
        }
      }
    }

    // 5. Deterministic next sibling sort order
    const [maxOrderRow] = await db
      .select({ maxOrder: sql<number | null>`max(${productAction.sortOrder})` })
      .from(productAction)
      .where(
        parentId
          ? eq(productAction.parentActionId, parentId)
          : and(
              eq(productAction.productId, input.productId),
              isNull(productAction.parentActionId),
            ),
      );

    const nextSortOrder = (maxOrderRow?.maxOrder ?? -1) + 1;
    const actionId = globalThis.crypto.randomUUID();

    // 6. Build atomic batch with concurrency-safe active limit check
    const batchQueries: unknown[] = [];

    if (isActive) {
      if (parentId) {
        batchQueries.push(
          db
            .select({ id: productAction.id })
            .from(productAction)
            .where(eq(productAction.id, parentId))
            .for("update"),
        );
        batchQueries.push(
          db
            .select({
              check: sql`CASE
                WHEN count(*)::int >= ${MAX_ACTIVE_CHILDREN}
                THEN (count(*)::int || '_ACTIVE_LIMIT_EXCEEDED_child')::integer
                ELSE 0
              END`,
            })
            .from(productAction)
            .where(
              and(
                eq(productAction.parentActionId, parentId),
                eq(productAction.isActive, true),
              ),
            ),
        );
      } else {
        batchQueries.push(
          db
            .select({ id: product.id })
            .from(product)
            .where(eq(product.id, input.productId))
            .for("update"),
        );
        batchQueries.push(
          db
            .select({
              check: sql`CASE
                WHEN count(*)::int >= ${MAX_ACTIVE_CHILDREN}
                THEN (count(*)::int || '_ACTIVE_LIMIT_EXCEEDED_root')::integer
                ELSE 0
              END`,
            })
            .from(productAction)
            .where(
              and(
                eq(productAction.productId, input.productId),
                isNull(productAction.parentActionId),
                eq(productAction.isActive, true),
              ),
            ),
        );
      }
    }

    const actionInsert = db.insert(productAction).values({
      id: actionId,
      productId: input.productId,
      parentActionId: parentId,
      actionType: input.actionType,
      sortOrder: nextSortOrder,
      isActive,
      url: input.actionType === "OPEN_URL" ? (input.url?.trim() ?? null) : null,
      navigateCategoryId:
        input.actionType === "NAVIGATE_CATALOG"
          ? (input.navigateCategoryId?.trim() ?? null)
          : null,
      navigateProductId:
        input.actionType === "NAVIGATE_CATALOG"
          ? (input.navigateProductId?.trim() ?? null)
          : null,
      actionConfig:
        input.actionType === "OPEN_SUPPORT" && input.actionConfig
          ? input.actionConfig
          : sql`'{}'::jsonb`,
    });

    const translationInserts = input.translations.map((t) =>
      db.insert(productActionTranslation).values({
        id: globalThis.crypto.randomUUID(),
        actionId,
        languageId: t.languageId,
        label: t.label,
        menuText: input.actionType === "OPEN_SUBMENU" ? (t.menuText ?? null) : null,
        templateBody:
          input.actionType === "SEND_TEMPLATE_MESSAGE"
            ? (t.templateBody ?? null)
            : null,
      }),
    );

    batchQueries.push(actionInsert, ...translationInserts);

    await executeAtomicBatch(db, batchQueries);

    const createdRecord = await readProductAction(db, actionId);
    if (!createdRecord) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read action after creation.",
      );
    }

    return { actionId, action: createdRecord };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string" &&
      (error as { message: string }).message.includes("ACTIVE_LIMIT_EXCEEDED")
    ) {
      const msg = (error as { message: string }).message.includes("root")
        ? `Active root button limit reached (${MAX_ACTIVE_CHILDREN} buttons). Cannot activate another root button.`
        : `Active child limit reached (${MAX_ACTIVE_CHILDREN} buttons). Cannot activate another button under this submenu.`;
      throw new RabetDataError("INVALID_INPUT", msg);
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      throw new RabetDataError(
        "CONFLICT",
        "Another action was created concurrently. Please try again.",
      );
    }
    throw mapDatabaseError(error);
  }
}

/**
 * Updates a product action and its submitted translation atomically.
 */
export async function editProductAction(
  db: Database,
  input: EditProductActionData,
): Promise<{ action: ProductActionRecord }> {
  try {
    // 1. Verify referenced product exists and is not soft-deleted
    const [targetProduct] = await db
      .select({ id: product.id, deletedAt: product.deletedAt })
      .from(product)
      .where(eq(product.id, input.productId))
      .limit(1);

    if (!targetProduct || targetProduct.deletedAt !== null) {
      throw new RabetDataError(
        "NOT_FOUND",
        "Referenced product does not exist or has been deleted.",
      );
    }

    // 2. Verify action exists and belongs to the specified product
    const existing = await readProductAction(db, input.actionId);
    if (!existing) {
      throw new RabetDataError("NOT_FOUND", "Button action not found.");
    }

    if (existing.productId !== input.productId) {
      throw new RabetDataError(
        "INVALID_INPUT",
        "Action does not belong to the specified product.",
      );
    }

    // 3. Prevent changing actionType away from OPEN_SUBMENU if children exist
    const isTypeChange = existing.actionType !== input.actionType;
    if (
      existing.actionType === "OPEN_SUBMENU" &&
      input.actionType !== "OPEN_SUBMENU"
    ) {
      const [childCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(productAction)
        .where(eq(productAction.parentActionId, input.actionId));

      const childCount = childCountRow?.count ?? 0;
      if (childCount > 0) {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Button has ${childCount} child button(s), so its type cannot change away from OPEN_SUBMENU.`,
        );
      }
    }

    // 4. Validate destination type parameters and targets
    let urlToSet: string | null = null;
    let navCatToSet: string | null = null;
    let navProdToSet: string | null = null;
    let configToSet: unknown = sql`'{}'::jsonb`;

    if (input.actionType === "OPEN_URL") {
      urlToSet =
        input.url !== undefined
          ? (input.url?.trim() ?? null)
          : (isTypeChange ? null : existing.url);

      if (input.isActive && (!urlToSet || urlToSet.trim().length === 0)) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "URL is required before an OPEN_URL action can be activated.",
        );
      }
    } else if (input.actionType === "NAVIGATE_CATALOG") {
      navCatToSet =
        input.navigateCategoryId !== undefined
          ? (input.navigateCategoryId?.trim() ?? null)
          : (isTypeChange ? null : existing.navigateCategoryId);

      navProdToSet =
        input.navigateProductId !== undefined
          ? (input.navigateProductId?.trim() ?? null)
          : (isTypeChange ? null : existing.navigateProductId);

      if (navCatToSet && navProdToSet) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "Cannot specify both a category and a product navigation target.",
        );
      }

      if (input.isActive) {
        if (!navCatToSet && !navProdToSet) {
          throw new RabetDataError(
            "INVALID_INPUT",
            "A valid category or product navigation target is required before activating NAVIGATE_CATALOG.",
          );
        }

        if (navCatToSet) {
          const [targetCat] = await db
            .select({ id: category.id, deletedAt: category.deletedAt })
            .from(category)
            .where(eq(category.id, navCatToSet))
            .limit(1);

          if (!targetCat || targetCat.deletedAt !== null) {
            throw new RabetDataError(
              "INVALID_INPUT",
              "Cannot activate action: target category does not exist or has been deleted.",
            );
          }
        }

        if (navProdToSet) {
          const [targetProd] = await db
            .select({ id: product.id, deletedAt: product.deletedAt })
            .from(product)
            .where(eq(product.id, navProdToSet))
            .limit(1);

          if (!targetProd || targetProd.deletedAt !== null) {
            throw new RabetDataError(
              "INVALID_INPUT",
              "Cannot activate action: target product does not exist or has been deleted.",
            );
          }
        }
      } else {
        // Safe deactivation: if target was explicitly submitted, validate it
        if (input.navigateCategoryId !== undefined && navCatToSet) {
          const [targetCat] = await db
            .select({ id: category.id, deletedAt: category.deletedAt })
            .from(category)
            .where(eq(category.id, navCatToSet))
            .limit(1);

          if (!targetCat || targetCat.deletedAt !== null) {
            throw new RabetDataError(
              "NOT_FOUND",
              "Referenced navigation target category does not exist or has been deleted.",
            );
          }
        }

        if (input.navigateProductId !== undefined && navProdToSet) {
          const [targetProd] = await db
            .select({ id: product.id, deletedAt: product.deletedAt })
            .from(product)
            .where(eq(product.id, navProdToSet))
            .limit(1);

          if (!targetProd || targetProd.deletedAt !== null) {
            throw new RabetDataError(
              "NOT_FOUND",
              "Referenced navigation target product does not exist or has been deleted.",
            );
          }
        }
      }
    } else if (input.actionType === "OPEN_SUPPORT") {
      if (input.actionConfig !== undefined) {
        configToSet = input.actionConfig ?? {};
      } else {
        configToSet = isTypeChange ? {} : existing.actionConfig;
      }

      if (
        configToSet &&
        typeof configToSet === "object" &&
        "support_category" in (configToSet as Record<string, unknown>)
      ) {
        const cat = (configToSet as { support_category?: string }).support_category;
        if (cat && typeof cat === "string" && cat.trim().length > 0 && input.actionConfig !== undefined) {
          const [settings] = await db
            .select({ supportCategory: botSetting.supportCategory })
            .from(botSetting)
            .where(eq(botSetting.id, 1))
            .limit(1);

          const configured = settings?.supportCategory ?? [];
          if (!configured.includes(cat.trim())) {
            throw new RabetDataError(
              "INVALID_INPUT",
              `Support category "${cat.trim()}" is not configured in store settings.`,
            );
          }
        }
      }
    }

    // 5. Build atomic queries with concurrency-safe active limit check
    const queries: unknown[] = [];

    if (input.isActive) {
      if (existing.parentActionId) {
        queries.push(
          db
            .select({ id: productAction.id })
            .from(productAction)
            .where(eq(productAction.id, existing.parentActionId))
            .for("update"),
        );
        queries.push(
          db
            .select({
              check: sql`CASE
                WHEN count(*)::int >= ${MAX_ACTIVE_CHILDREN}
                THEN (count(*)::int || '_ACTIVE_LIMIT_EXCEEDED_child')::integer
                ELSE 0
              END`,
            })
            .from(productAction)
            .where(
              and(
                eq(productAction.parentActionId, existing.parentActionId),
                eq(productAction.isActive, true),
                ne(productAction.id, input.actionId),
              ),
            ),
        );
      } else {
        queries.push(
          db
            .select({ id: product.id })
            .from(product)
            .where(eq(product.id, input.productId))
            .for("update"),
        );
        queries.push(
          db
            .select({
              check: sql`CASE
                WHEN count(*)::int >= ${MAX_ACTIVE_CHILDREN}
                THEN (count(*)::int || '_ACTIVE_LIMIT_EXCEEDED_root')::integer
                ELSE 0
              END`,
            })
            .from(productAction)
            .where(
              and(
                eq(productAction.productId, input.productId),
                isNull(productAction.parentActionId),
                eq(productAction.isActive, true),
                ne(productAction.id, input.actionId),
              ),
            ),
        );
      }
    }

    // 6. Base action update
    const actionUpdate = db
      .update(productAction)
      .set({
        actionType: input.actionType,
        isActive: input.isActive,
        url: urlToSet,
        navigateCategoryId: navCatToSet,
        navigateProductId: navProdToSet,
        actionConfig: configToSet,
        updatedAt: sql`now()`,
      })
      .where(eq(productAction.id, input.actionId));

    queries.push(actionUpdate);

    // 7. Type transition cleanup across ALL existing translations
    if (isTypeChange) {
      if (input.actionType !== "OPEN_SUBMENU" && existing.actionType === "OPEN_SUBMENU") {
        queries.push(
          db
            .update(productActionTranslation)
            .set({ menuText: null, updatedAt: sql`now()` })
            .where(eq(productActionTranslation.actionId, input.actionId)),
        );
      }
      if (
        input.actionType !== "SEND_TEMPLATE_MESSAGE" &&
        existing.actionType === "SEND_TEMPLATE_MESSAGE"
      ) {
        queries.push(
          db
            .update(productActionTranslation)
            .set({ templateBody: null, updatedAt: sql`now()` })
            .where(eq(productActionTranslation.actionId, input.actionId)),
        );
      }
    }

    // 8. Update or upsert the submitted translation
    if (input.translation) {
      const existingTrans = existing.translations[input.translation.languageCode];

      let menuTextToSet: string | null = null;
      if (input.actionType === "OPEN_SUBMENU") {
        if (input.translation.menuText !== undefined) {
          menuTextToSet = input.translation.menuText ?? null;
        } else {
          menuTextToSet = isTypeChange ? null : (existingTrans?.menuText ?? null);
        }
      }

      let templateBodyToSet: string | null = null;
      if (input.actionType === "SEND_TEMPLATE_MESSAGE") {
        if (input.translation.templateBody !== undefined) {
          templateBodyToSet = input.translation.templateBody ?? null;
        } else {
          templateBodyToSet = isTypeChange ? null : (existingTrans?.templateBody ?? null);
        }
      }

      const updateSet: Record<string, unknown> = {
        label: input.translation.label,
        updatedAt: sql`now()`,
      };

      if (input.actionType === "OPEN_SUBMENU") {
        if (input.translation.menuText !== undefined || isTypeChange) {
          updateSet.menuText = menuTextToSet;
        }
      } else {
        updateSet.menuText = null;
      }

      if (input.actionType === "SEND_TEMPLATE_MESSAGE") {
        if (input.translation.templateBody !== undefined || isTypeChange) {
          updateSet.templateBody = templateBodyToSet;
        }
      } else {
        updateSet.templateBody = null;
      }

      const translationUpsert = db
        .insert(productActionTranslation)
        .values({
          id: globalThis.crypto.randomUUID(),
          actionId: input.actionId,
          languageId: input.translation.languageId,
          label: input.translation.label,
          menuText: menuTextToSet,
          templateBody: templateBodyToSet,
        })
        .onConflictDoUpdate({
          target: [
            productActionTranslation.actionId,
            productActionTranslation.languageId,
          ],
          set: updateSet,
        });

      queries.push(translationUpsert);
    }

    await executeAtomicBatch(db, queries);

    const updated = await readProductAction(db, input.actionId);
    if (!updated) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read action after update.",
      );
    }

    return { action: updated };
  } catch (error) {
    if (error instanceof RabetDataError) {
      throw error;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string" &&
      (error as { message: string }).message.includes("ACTIVE_LIMIT_EXCEEDED")
    ) {
      const msg = (error as { message: string }).message.includes("root")
        ? `Active root button limit reached (${MAX_ACTIVE_CHILDREN} buttons). Cannot activate another root button.`
        : `Active button limit reached (${MAX_ACTIVE_CHILDREN} buttons). Deactivate an existing button before activating this one.`;
      throw new RabetDataError("INVALID_INPUT", msg);
    }
    throw mapDatabaseError(error);
  }
}
