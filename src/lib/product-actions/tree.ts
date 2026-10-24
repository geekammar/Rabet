import {
  ACTION_DEPTH_WARNING_THRESHOLD,
  MAX_ACTION_DEPTH,
  MAX_ACTION_DEPTH_SAFEGUARD,
  MAX_ACTIVE_CHILDREN,
} from "./constants";

export interface RawActionTranslation {
  id: string;
  languageId: string;
  label: string;
  menuText: string | null;
  templateBody?: string | null;
}

export interface RawActionNode {
  id: string;
  productId: string;
  parentActionId: string | null;
  actionType: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  url?: string | null;
  navigateCategoryId?: string | null;
  navigateProductId?: string | null;
  actionConfig?: unknown;
  translations: Record<string, RawActionTranslation>;
}

export type InactiveReason =
  | "self_inactive"
  | "inactive_ancestor"
  | "inactive_product"
  | "inactive_category"
  | null;

export interface HierarchyActionNode extends RawActionNode {
  /** 0-based depth in tree (root = 0). */
  depth: number;
  /** 1-based level in tree (root = 1). */
  level: number;
  breadcrumb: string;
  ancestorIds: string[];
  ancestorLabels: string[];
  /** True ONLY if this action, all its ancestors, its product, and its category are active. */
  effectiveVisibility: boolean;
  hasInactiveAncestor: boolean;
  inactiveAncestorLabel: string | null;
  inactiveReason: InactiveReason;
  hasDepthWarning: boolean;
  isAtMaxDepth: boolean;
  childCount: number;
  activeChildCount: number;
  exceedsActiveLimit: boolean;
  children: HierarchyActionNode[];
}

/**
 * Resolves the display label of an action for dashboard presentation,
 * preferring requested language, default language, any saved translation, or actionType.
 */
export function resolveActionDisplayLabel(
  action: RawActionNode,
  preferredLanguage = "en",
  defaultLanguage = "en",
): string {
  const pref = action.translations[preferredLanguage]?.label?.trim();
  if (pref) return pref;

  const def = action.translations[defaultLanguage]?.label?.trim();
  if (def) return def;

  for (const trans of Object.values(action.translations)) {
    const l = trans?.label?.trim();
    if (l) return l;
  }

  return action.actionType;
}

export interface BuildActionHierarchyContext {
  isProductActive?: boolean;
  isCategoryActive?: boolean;
  preferredLanguage?: string;
  defaultLanguage?: string;
}

export function buildActionHierarchy(
  actions: RawActionNode[],
  context?: BuildActionHierarchyContext,
): {
  tree: HierarchyActionNode[];
  flattened: HierarchyActionNode[];
  hasAnyDepthWarning: boolean;
} {
  const isProductActive = context?.isProductActive ?? true;
  const isCategoryActive = context?.isCategoryActive ?? true;
  const preferredLang = context?.preferredLanguage ?? "en";
  const defaultLang = context?.defaultLanguage ?? "en";

  const byId = new Map<string, RawActionNode>();
  for (const act of actions) {
    byId.set(act.id, act);
  }

  // Group children by parentActionId
  const childrenByParent = new Map<string | null, RawActionNode[]>();
  for (const act of actions) {
    // Only treat as child if parent exists in this product's actions
    const parentKey =
      act.parentActionId && byId.has(act.parentActionId)
        ? act.parentActionId
        : null;
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(act);
    childrenByParent.set(parentKey, list);
  }

  // Sort sibling lists deterministically by sortOrder ASC, createdAt ASC, id ASC
  const sortSiblings = (nodes: RawActionNode[]) => {
    return [...nodes].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      const timeDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });
  };

  const flattened: HierarchyActionNode[] = [];
  let hasAnyDepthWarning = false;

  function traverse(
    node: RawActionNode,
    depth: number,
    ancestors: HierarchyActionNode[],
  ): HierarchyActionNode {
    const level = depth + 1;
    const hasDepthWarning = level > ACTION_DEPTH_WARNING_THRESHOLD;
    const isAtMaxDepth = level >= MAX_ACTION_DEPTH;
    if (hasDepthWarning) {
      hasAnyDepthWarning = true;
    }

    const displayLabel = resolveActionDisplayLabel(node, preferredLang, defaultLang);
    const breadcrumb = [...ancestors.map((a) => resolveActionDisplayLabel(a, preferredLang, defaultLang)), displayLabel].join(
      " > ",
    );

    // Inactive ancestor calculation
    const inactiveAncestor = ancestors.find((a) => !a.isActive);
    const hasInactiveAncestor = Boolean(inactiveAncestor);
    const inactiveAncestorLabel = inactiveAncestor
      ? resolveActionDisplayLabel(inactiveAncestor, preferredLang, defaultLang)
      : null;

    let inactiveReason: InactiveReason = null;
    if (!node.isActive) {
      inactiveReason = "self_inactive";
    } else if (hasInactiveAncestor) {
      inactiveReason = "inactive_ancestor";
    } else if (!isProductActive) {
      inactiveReason = "inactive_product";
    } else if (!isCategoryActive) {
      inactiveReason = "inactive_category";
    }

    const effectiveVisibility =
      node.isActive &&
      !hasInactiveAncestor &&
      isProductActive &&
      isCategoryActive;

    const rawChildren = childrenByParent.get(node.id) ?? [];
    const sortedChildren = sortSiblings(rawChildren);
    const childCount = sortedChildren.length;
    const activeChildCount = sortedChildren.filter((c) => c.isActive).length;
    const exceedsActiveLimit = activeChildCount > MAX_ACTIVE_CHILDREN;

    const hierarchyNode: HierarchyActionNode = {
      ...node,
      depth,
      level,
      breadcrumb,
      ancestorIds: ancestors.map((a) => a.id),
      ancestorLabels: ancestors.map((a) => resolveActionDisplayLabel(a, preferredLang, defaultLang)),
      effectiveVisibility,
      hasInactiveAncestor,
      inactiveAncestorLabel,
      inactiveReason,
      hasDepthWarning,
      isAtMaxDepth,
      childCount,
      activeChildCount,
      exceedsActiveLimit,
      children: [],
    };

    // Cycle protection & safety bound
    if (
      depth < MAX_ACTION_DEPTH_SAFEGUARD &&
      !ancestors.some((a) => a.id === node.id)
    ) {
      hierarchyNode.children = sortedChildren.map((child) =>
        traverse(child, depth + 1, [...ancestors, hierarchyNode]),
      );
    }

    flattened.push(hierarchyNode);
    return hierarchyNode;
  }

  const rootNodes = sortSiblings(childrenByParent.get(null) ?? []);
  const tree = rootNodes.map((root) => traverse(root, 0, []));

  return { tree, flattened, hasAnyDepthWarning };
}
