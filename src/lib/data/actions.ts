import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
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
 * Server-only product action data access functions (Phase 05-B1).
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
  translations: Array<{
    languageId: string;
    languageCode: string;
    label: string;
    menuText?: string | null;
  }>;
}

export interface EditProductActionData {
  actionId: string;
  productId: string;
  actionType: SupportedActionType;
  isActive: boolean;
  translation?: {
    languageId: string;
    languageCode: string;
    label: string;
    menuText?: string | null;
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

      // 4. Active child limit check
      if (isActive) {
        const [activeCountRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(productAction)
          .where(
            and(
              eq(productAction.parentActionId, parentId),
              eq(productAction.isActive, true),
            ),
          );

        if ((activeCountRow?.count ?? 0) >= MAX_ACTIVE_CHILDREN) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `Active child limit reached (${MAX_ACTIVE_CHILDREN} buttons). Cannot activate another button under this submenu.`,
          );
        }
      }
    } else {
      // Root button: check active root limit
      if (isActive) {
        const [activeRootRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(productAction)
          .where(
            and(
              eq(productAction.productId, input.productId),
              isNull(productAction.parentActionId),
              eq(productAction.isActive, true),
            ),
          );

        if ((activeRootRow?.count ?? 0) >= MAX_ACTIVE_CHILDREN) {
          throw new RabetDataError(
            "INVALID_INPUT",
            `Active root button limit reached (${MAX_ACTIVE_CHILDREN} buttons). Cannot activate another root button.`,
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

    // 6. Build atomic batch
    const actionInsert = db.insert(productAction).values({
      id: actionId,
      productId: input.productId,
      parentActionId: parentId,
      actionType: input.actionType,
      sortOrder: nextSortOrder,
      isActive,
      actionConfig: sql`'{}'::jsonb`,
      url: null,
      navigateCategoryId: null,
      navigateProductId: null,
    });

    const translationInserts = input.translations.map((t) =>
      db.insert(productActionTranslation).values({
        id: globalThis.crypto.randomUUID(),
        actionId,
        languageId: t.languageId,
        label: t.label,
        menuText: input.actionType === "OPEN_SUBMENU" ? (t.menuText ?? null) : null,
        templateBody: null,
      }),
    );

    await executeAtomicBatch(db, [actionInsert, ...translationInserts]);

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
    // 1. Verify action exists and belongs to the specified product
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

    // 2. Prevent changing actionType away from OPEN_SUBMENU if children exist
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

    // 3. Active limit check if activating
    if (!existing.isActive && input.isActive) {
      const siblingCondition = existing.parentActionId
        ? eq(productAction.parentActionId, existing.parentActionId)
        : and(
            eq(productAction.productId, input.productId),
            isNull(productAction.parentActionId),
          );

      const [activeSiblingRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(productAction)
        .where(
          and(
            siblingCondition,
            eq(productAction.isActive, true),
            sql`${productAction.id} <> ${input.actionId}`,
          ),
        );

      if ((activeSiblingRow?.count ?? 0) >= MAX_ACTIVE_CHILDREN) {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Active button limit reached (${MAX_ACTIVE_CHILDREN} buttons). Deactivate an existing button before activating this one.`,
        );
      }
    }

    // 4. Build atomic queries
    const queries: unknown[] = [];

    const actionUpdate = db
      .update(productAction)
      .set({
        actionType: input.actionType,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(eq(productAction.id, input.actionId));

    queries.push(actionUpdate);

    if (input.translation) {
      const translationUpsert = db
        .insert(productActionTranslation)
        .values({
          id: globalThis.crypto.randomUUID(),
          actionId: input.actionId,
          languageId: input.translation.languageId,
          label: input.translation.label,
          menuText:
            input.actionType === "OPEN_SUBMENU"
              ? (input.translation.menuText ?? null)
              : null,
          templateBody: null,
        })
        .onConflictDoUpdate({
          target: [
            productActionTranslation.actionId,
            productActionTranslation.languageId,
          ],
          set: {
            label: input.translation.label,
            menuText:
              input.actionType === "OPEN_SUBMENU"
                ? (input.translation.menuText ?? null)
                : null,
            updatedAt: sql`now()`,
          },
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
    throw mapDatabaseError(error);
  }
}
