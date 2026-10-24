/**
 * Category hierarchy and tree traversal logic.
 *
 * Implements:
 * - Runtime traversal safeguard (MAX_CATEGORY_DEPTH_SAFEGUARD = 64)
 * - Cycle protection during traversal
 * - Breadcrumb and hierarchical context to distinguish identically or similarly named categories
 * - Truthful customer visibility calculation: an active child is NEVER implied to be customer-visible
 *   when any ancestor is inactive.
 */

export const MAX_CATEGORY_DEPTH_SAFEGUARD = 64;

export interface RawCategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  translations: Record<
    string,
    { id: string; name: string; description: string | null }
  >;
}

export interface HierarchyCategoryNode extends RawCategoryNode {
  depth: number;
  breadcrumb: string;
  ancestorIds: string[];
  ancestorNames: string[];
  effectiveVisibility: boolean;
  hasInactiveAncestor: boolean;
  inactiveAncestorName: string | null;
  children: HierarchyCategoryNode[];
}

/**
 * Resolves the primary localized name of a category for display in the dashboard,
 * preferring the requested language, then the default language ("en"), then any saved translation,
 * and finally falling back to the slug.
 */
export function resolveCategoryDisplayName(
  category: RawCategoryNode,
  preferredLanguage = "en",
  defaultLanguage = "en",
): string {
  const pref = category.translations[preferredLanguage]?.name?.trim();
  if (pref) return pref;

  const def = category.translations[defaultLanguage]?.name?.trim();
  if (def) return def;

  for (const trans of Object.values(category.translations)) {
    const n = trans?.name?.trim();
    if (n) return n;
  }

  return category.slug;
}

/**
 * Builds a validated, cycle-checked, depth-limited hierarchy tree from raw category rows.
 *
 * Rules:
 * 1. Roots are categories with `parentId === null` or referencing an unknown parent.
 * 2. Ancestor walk is bounded by `MAX_CATEGORY_DEPTH_SAFEGUARD`.
 * 3. Children are sorted by `sortOrder ASC`, `createdAt ASC`, `id ASC`.
 * 4. `effectiveVisibility` is true ONLY if the node is active AND all its ancestors are active.
 */
export function buildCategoryHierarchy(
  categories: RawCategoryNode[],
  options?: {
    preferredLanguage?: string;
    defaultLanguage?: string;
  },
): {
  tree: HierarchyCategoryNode[];
  flattened: HierarchyCategoryNode[];
} {
  const preferredLang = options?.preferredLanguage ?? "en";
  const defaultLang = options?.defaultLanguage ?? "en";

  const byId = new Map<string, RawCategoryNode>();
  for (const cat of categories) {
    byId.set(cat.id, cat);
  }

  // Group children by parentId
  const childrenByParent = new Map<string | null, RawCategoryNode[]>();
  for (const cat of categories) {
    const parentKey = cat.parentId && byId.has(cat.parentId) ? cat.parentId : null;
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(cat);
    childrenByParent.set(parentKey, list);
  }

  // Sort sibling lists
  const sortSiblings = (nodes: RawCategoryNode[]) => {
    return [...nodes].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      const timeA = a.createdAt.getTime();
      const timeB = b.createdAt.getTime();
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });
  };

  const flattened: HierarchyCategoryNode[] = [];

  function traverse(
    rawNode: RawCategoryNode,
    ancestors: HierarchyCategoryNode[],
    depth: number,
  ): HierarchyCategoryNode {
    // Check runtime depth safeguard
    if (depth >= MAX_CATEGORY_DEPTH_SAFEGUARD) {
      console.warn(
        `Category ${rawNode.id} reached maximum traversal depth of ${MAX_CATEGORY_DEPTH_SAFEGUARD}. Truncating branch.`,
      );
    }

    const ancestorIds = ancestors.map((a) => a.id);
    const ancestorNames = ancestors.map((a) =>
      resolveCategoryDisplayName(a, preferredLang, defaultLang),
    );

    const displayName = resolveCategoryDisplayName(
      rawNode,
      preferredLang,
      defaultLang,
    );
    const breadcrumb = [...ancestorNames, displayName].join(" › ");

    // Check ancestors for active state
    const firstInactiveAncestor = ancestors.find((a) => !a.isActive);
    const hasInactiveAncestor = firstInactiveAncestor !== undefined;
    const inactiveAncestorName = firstInactiveAncestor
      ? resolveCategoryDisplayName(
          firstInactiveAncestor,
          preferredLang,
          defaultLang,
        )
      : null;

    // Truthful visibility rule:
    // A category is customer-visible only if it is active AND has no inactive ancestors.
    const effectiveVisibility = rawNode.isActive && !hasInactiveAncestor;

    const rawChildren = childrenByParent.get(rawNode.id) ?? [];
    const sortedRawChildren = sortSiblings(rawChildren);

    const node: HierarchyCategoryNode = {
      ...rawNode,
      depth,
      breadcrumb,
      ancestorIds,
      ancestorNames,
      effectiveVisibility,
      hasInactiveAncestor,
      inactiveAncestorName,
      children: [],
    };

    flattened.push(node);

    // Prevent cycle in tree traversal: do not visit children that are already in ancestor chain
    const safeChildren = depth < MAX_CATEGORY_DEPTH_SAFEGUARD
      ? sortedRawChildren.filter((child) => !ancestorIds.includes(child.id) && child.id !== rawNode.id)
      : [];

    node.children = safeChildren.map((child) =>
      traverse(child, [...ancestors, node], depth + 1),
    );

    return node;
  }

  const rawRoots = childrenByParent.get(null) ?? [];
  const sortedRoots = sortSiblings(rawRoots);

  const tree = sortedRoots.map((root) => traverse(root, [], 0));

  return { tree, flattened };
}
