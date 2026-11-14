import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { category, product, productAction } from "@/db/schema";

/**
 * Shared, channel-independent availability checks for the catalog and the
 * configurable product-action tree.
 *
 * These functions intentionally contain no Telegram (or other channel)
 * concepts: callers resolve an id from their own transport, then re-validate
 * the live hierarchy here before showing anything to a customer.
 */

export const MAX_SAFEGUARD_DEPTH = 64;

/**
 * Checks category existence, active flag, and whether all ancestors are active and not soft-deleted.
 */
export async function isCategoryHierarchyActive(
  db: Database,
  categoryId: string,
): Promise<{ valid: boolean; categoryRow?: typeof category.$inferSelect }> {
  let currentId: string | null = categoryId;
  let depth = 0;
  let targetRow: typeof category.$inferSelect | undefined;

  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return { valid: false };
    }
    visited.add(currentId);

    const [row] = await db
      .select()
      .from(category)
      .where(and(eq(category.id, currentId), isNull(category.deletedAt)))
      .limit(1);

    if (!row || !row.isActive) {
      return { valid: false };
    }

    if (currentId === categoryId) {
      targetRow = row;
    }

    currentId = row.parentId;
    depth += 1;
  }

  if (currentId !== null || !targetRow) {
    return { valid: false };
  }

  return { valid: true, categoryRow: targetRow };
}

/**
 * Checks product existence, active flag, and whether its category hierarchy is fully active.
 */
export async function isProductHierarchyActive(
  db: Database,
  productId: string,
): Promise<{ valid: boolean; productRow?: typeof product.$inferSelect }> {
  const [prod] = await db
    .select()
    .from(product)
    .where(and(eq(product.id, productId), isNull(product.deletedAt)))
    .limit(1);

  if (!prod || !prod.isActive) {
    return { valid: false };
  }

  const categoryCheck = await isCategoryHierarchyActive(db, prod.categoryId);
  if (!categoryCheck.valid) {
    return { valid: false };
  }

  return { valid: true, productRow: prod };
}

export type ActionHierarchyRow = {
  id: string;
  productId: string;
  parentActionId: string | null;
  actionType: (typeof productAction.$inferSelect)["actionType"];
  isActive: boolean;
  url: string | null;
  navigateCategoryId: string | null;
  navigateProductId: string | null;
  actionConfig: unknown;
  sortOrder: number;
};

/**
 * Checks action existence, active flag, ancestor actions active and OPEN_SUBMENU,
 * and product/category hierarchy fully active.
 */
export async function isActionHierarchyActive(
  db: Database,
  actionId: string,
): Promise<{
  valid: boolean;
  actionRow?: ActionHierarchyRow;
  productRow?: typeof product.$inferSelect;
  ancestors?: ActionHierarchyRow[];
}> {
  let currentId: string | null = actionId;
  let depth = 0;
  let targetRow: ActionHierarchyRow | undefined;
  const ancestors: ActionHierarchyRow[] = [];

  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return { valid: false };
    }
    visited.add(currentId);

    const [row] = await db
      .select({
        id: productAction.id,
        productId: productAction.productId,
        parentActionId: productAction.parentActionId,
        actionType: productAction.actionType,
        isActive: productAction.isActive,
        url: productAction.url,
        navigateCategoryId: productAction.navigateCategoryId,
        navigateProductId: productAction.navigateProductId,
        actionConfig: productAction.actionConfig,
        sortOrder: productAction.sortOrder,
      })
      .from(productAction)
      .where(eq(productAction.id, currentId))
      .limit(1);

    if (!row || !row.isActive) {
      return { valid: false };
    }

    if (currentId === actionId) {
      targetRow = row;
    } else if (row.actionType !== "OPEN_SUBMENU") {
      return { valid: false };
    } else {
      ancestors.push(row);
    }

    currentId = row.parentActionId;
    depth += 1;
  }

  if (currentId !== null || !targetRow) {
    return { valid: false };
  }

  const productCheck = await isProductHierarchyActive(db, targetRow.productId);
  if (!productCheck.valid || !productCheck.productRow) {
    return { valid: false };
  }

  ancestors.reverse();
  return {
    valid: true,
    actionRow: targetRow,
    productRow: productCheck.productRow,
    ancestors,
  };
}
