/**
 * Pure, channel-independent category ancestry predicate.
 *
 * This module deliberately has no database or server-only imports so both the
 * server data layer and the merchant client can evaluate the same walk. A
 * lookup row carries an optional `parentResolved` flag: `false` means the
 * stored parent could not be resolved inside the supplied scoped snapshot
 * (missing, deleted or foreign), so the path is unavailable even though the
 * parent id itself is not exposed.
 */

export const MAX_SAFEGUARD_DEPTH = 64;

export interface CategoryAncestryNode {
  id: string;
  parentId: string | null;
  isActive: boolean;
  /** Defaults to true. `false` marks an unresolved scoped parent. */
  parentResolved?: boolean;
}

/**
 * Walks one category's ancestor chain through the supplied lookup.
 *
 * The lookup must return `undefined` for missing rows and `parentResolved:
 * false` for an unresolved parent. The walker mirrors
 * `isCategoryHierarchyActive`: at most `MAX_SAFEGUARD_DEPTH` nodes including
 * the target, no cycles, no missing rows, no unresolved parents, and every
 * node active.
 */
export function isCategoryAncestryActive(
  categoryId: string,
  getCategory: (id: string) => CategoryAncestryNode | undefined,
): boolean {
  let currentId: string | null = categoryId;
  let depth = 0;
  const visited = new Set<string>();

  while (currentId !== null && depth < MAX_SAFEGUARD_DEPTH) {
    if (visited.has(currentId)) {
      return false;
    }
    visited.add(currentId);

    const row = getCategory(currentId);
    if (!row || row.parentResolved === false || !row.isActive) {
      return false;
    }

    currentId = row.parentId;
    depth += 1;
  }

  return currentId === null;
}
