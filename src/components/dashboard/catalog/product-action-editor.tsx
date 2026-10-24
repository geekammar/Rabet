"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";

import {
  createProductActionAction,
  loadProductActionsAction,
  type ProductActionResult,
  updateProductActionAction,
} from "@/app/actions/product-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LanguageRow, ResolvedLanguage } from "@/lib/data";
import {
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
  MAX_ACTIVE_CHILDREN,
  SUPPORTED_ACTION_TYPES,
  type SupportedActionType,
} from "@/lib/product-actions/constants";
import { resolveActionTranslationStatus } from "@/lib/product-actions/status";
import {
  buildActionHierarchy,
  type HierarchyActionNode,
  type RawActionNode,
} from "@/lib/product-actions/tree";
import type { CatalogProductRecord } from "./types";

interface ProductActionEditorProps {
  product: CatalogProductRecord;
  categoryBreadcrumb: string;
  isProductActive: boolean;
  isCategoryActive: boolean;
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  onClose: () => void;
}

export function ProductActionEditor({
  product,
  categoryBreadcrumb,
  isProductActive,
  isCategoryActive,
  defaultLanguage,
  languages,
  onClose,
}: ProductActionEditorProps) {
  const [actions, setActions] = useState<RawActionNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [actionFeedback, setActionFeedback] = useState<ProductActionResult | null>(null);

  // Expanded nodes for collapse/expand
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());

  // Selected action being edited
  const [editingActionId, setEditingActionId] = useState<string | null>(null);

  // Creation modal state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createParentActionId, setCreateParentActionId] = useState<string | null>(null);

  // Store language info
  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel =
    defaultLanguage?.label ?? (defaultLangCode === "ar" ? "العربية" : "English");
  const defaultLangDir =
    defaultLanguage?.textDirection ?? (defaultLangCode === "ar" ? "rtl" : "ltr");
  const arabicRegistered = languages.some((l) => l.code === "ar");

  // Active language tab in edit drawer
  const [activeLangTab, setActiveLangTab] = useState<string>(defaultLangCode);

  const saveVersionRef = useRef(0);
  const [prevProductId, setPrevProductId] = useState(product.id);

  // Edit Form Draft State
  const [editActionType, setEditActionType] = useState<SupportedActionType>("OPEN_SUBMENU");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editDraftTranslations, setEditDraftTranslations] = useState<
    Record<string, { label: string; menuText: string }>
  >({});

  // Reset local state if product changes
  if (product.id !== prevProductId) {
    setPrevProductId(product.id);
    setActions([]);
    setIsLoading(true);
    setEditingActionId(null);
    setActionFeedback(null);
    setEditDraftTranslations({});
  }

  // Fetch actions on mount / product change
  const reloadActions = () => {
    const targetProductId = product.id;
    setIsLoading(true);
    setActionFeedback(null);
    loadProductActionsAction(targetProductId)
      .then((res) => {
        if (product.id !== targetProductId) return;
        setIsLoading(false);
        if (res.success && res.actions) {
          setActions(res.actions);
          setExpandedNodeIds(new Set(res.actions.map((a) => a.id)));
        } else {
          setActionFeedback({
            success: false,
            message: res.message || "Failed to load product buttons.",
          });
        }
      })
      .catch(() => {
        if (product.id !== targetProductId) return;
        setIsLoading(false);
        setActionFeedback({
          success: false,
          message:
            "A communication error occurred while loading buttons. Please try again.",
        });
      });
  };

  useEffect(() => {
    let isMounted = true;

    loadProductActionsAction(product.id)
      .then((res) => {
        if (!isMounted) return;
        setIsLoading(false);
        if (res.success && res.actions) {
          setActions(res.actions);
          setExpandedNodeIds(new Set(res.actions.map((a) => a.id)));
        } else {
          setActionFeedback({
            success: false,
            message: res.message || "Failed to load product buttons.",
          });
        }
      })
      .catch(() => {
        if (!isMounted) return;
        setIsLoading(false);
        setActionFeedback({
          success: false,
          message:
            "A communication error occurred while loading buttons. Please try again.",
        });
      });

    return () => {
      isMounted = false;
    };
  }, [product.id]);

  // Build hierarchy tree
  const { tree, flattened, hasAnyDepthWarning } = useMemo(() => {
    return buildActionHierarchy(actions, {
      isProductActive,
      isCategoryActive,
      preferredLanguage: activeLangTab,
      defaultLanguage: defaultLangCode,
    });
  }, [actions, isProductActive, isCategoryActive, activeLangTab, defaultLangCode]);

  // Selected action node
  const selectedNode = useMemo(() => {
    if (!editingActionId) return null;
    return flattened.find((a) => a.id === editingActionId) ?? null;
  }, [flattened, editingActionId]);

  const isSelectedUnsupported =
    selectedNode !== null &&
    !SUPPORTED_ACTION_TYPES.includes(selectedNode.actionType as SupportedActionType);

  const toggleExpand = (id: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const syncEditDraft = (node: HierarchyActionNode) => {
    setEditActionType(node.actionType as SupportedActionType);
    setEditIsActive(node.isActive);
    const trans: Record<string, { label: string; menuText: string }> = {};
    for (const [code, t] of Object.entries(node.translations)) {
      trans[code] = {
        label: t.label ?? "",
        menuText: t.menuText ?? "",
      };
    }
    setEditDraftTranslations(trans);
  };

  const handleStartEdit = (node: HierarchyActionNode) => {
    setEditingActionId(node.id);
    setActionFeedback(null);
    syncEditDraft(node);
  };

  const handleSaveEdit = () => {
    if (!selectedNode) return;
    const targetActionId = selectedNode.id;
    const targetProductId = product.id;
    const targetVersion = ++saveVersionRef.current;
    const submittedLang = activeLangTab;
    const draft = editDraftTranslations[submittedLang] || { label: "", menuText: "" };
    const submittedLabel = draft.label;
    const submittedMenuText = draft.menuText;

    startTransition(async () => {
      try {
        const res = await updateProductActionAction({
          actionId: targetActionId,
          productId: targetProductId,
          actionType: editActionType,
          isActive: editIsActive,
          languageCode: submittedLang,
          label: submittedLabel,
          menuText: editActionType === "OPEN_SUBMENU" ? submittedMenuText : null,
        });

        if (
          targetProductId !== product.id ||
          targetActionId !== editingActionId ||
          targetVersion !== saveVersionRef.current
        ) {
          // Stale request response; do not mutate active editor state
          return;
        }

        setActionFeedback(res);

        if (res.success && res.action) {
          const authoritative = res.action;
          setActions((prev) =>
            prev.map((a) => (a.id === authoritative.id ? authoritative : a)),
          );

          setEditActionType(authoritative.actionType as SupportedActionType);
          setEditIsActive(authoritative.isActive);

          // Reconcile ONLY submitted language draft, preserving text entered after submission
          setEditDraftTranslations((prev) => {
            const currentDraft = prev[submittedLang];
            if (
              currentDraft &&
              (currentDraft.label !== submittedLabel ||
                currentDraft.menuText !== submittedMenuText)
            ) {
              return prev; // User entered new text during save; do not overwrite!
            }
            const savedTrans = authoritative.translations[submittedLang];
            return {
              ...prev,
              [submittedLang]: {
                label: savedTrans?.label ?? "",
                menuText: savedTrans?.menuText ?? "",
              },
            };
          });
        }
      } catch {
        if (
          targetProductId === product.id &&
          targetActionId === editingActionId &&
          targetVersion === saveVersionRef.current
        ) {
          setActionFeedback({
            success: false,
            message:
              "A communication or server error occurred. Your changes have been preserved. Please try again.",
          });
        }
      }
    });
  };

  // ==========================================
  // Create Modal Draft State
  // ==========================================
  const [createType, setCreateType] = useState<SupportedActionType>("OPEN_SUBMENU");
  const [createIsActive, setCreateIsActive] = useState(true);
  const [createLabel, setCreateLabel] = useState("");
  const [createMenuText, setCreateMenuText] = useState("");
  const [createArabicLabel, setCreateArabicLabel] = useState("");
  const [createArabicMenuText, setCreateArabicMenuText] = useState("");

  const handleOpenCreate = (parentId: string | null = null) => {
    setCreateParentActionId(parentId);
    setCreateType("OPEN_SUBMENU");
    setCreateIsActive(true);
    setCreateLabel("");
    setCreateMenuText("");
    setCreateArabicLabel("");
    setCreateArabicMenuText("");
    setIsCreateOpen(true);
    setActionFeedback(null);
  };

  const handleCreateAction = () => {
    startTransition(async () => {
      try {
        const res = await createProductActionAction({
          productId: product.id,
          parentActionId: createParentActionId,
          actionType: createType,
          isActive: createIsActive,
          label: createLabel,
          menuText: createType === "OPEN_SUBMENU" ? createMenuText : null,
          arabicLabel:
            arabicRegistered && defaultLangCode !== "ar" && createArabicLabel.trim().length > 0
              ? createArabicLabel
              : undefined,
          arabicMenuText:
            createType === "OPEN_SUBMENU" &&
            arabicRegistered &&
            defaultLangCode !== "ar" &&
            createArabicMenuText.trim().length > 0
              ? createArabicMenuText
              : undefined,
        });

        setActionFeedback(res);

        if (res.success && res.action) {
          setActions((prev) => [...prev, res.action!]);
          setIsCreateOpen(false);
          // Automatically expand parent if created under parent
          if (createParentActionId) {
            setExpandedNodeIds((prev) => new Set([...prev, createParentActionId]));
          }
        }
      } catch {
        setActionFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your inputs have been preserved. Please try again.",
        });
      }
    });
  };

  // Render Action Node
  const renderActionNode = (node: HierarchyActionNode) => {
    const isSelected = node.id === editingActionId;
    const isExpanded = expandedNodeIds.has(node.id);
    const hasChildren = node.children.length > 0;
    const isMenuType = node.actionType === "OPEN_SUBMENU";
    const paddingLeft = `${Math.min(node.depth * 0.75 + 0.25, 2.5)}rem`;

    return (
      <div key={node.id} className="space-y-1 w-full min-w-0 max-w-full">
        <div
          data-testid="action-node"
          data-action-id={node.id}
          data-action-type={node.actionType}
          style={{ paddingLeft }}
          className={`group flex flex-wrap sm:flex-nowrap items-center justify-between gap-1.5 rounded-xl border p-2 transition-colors w-full min-w-0 max-w-full ${
            isSelected
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border/60 hover:border-border hover:bg-muted/40"
          }`}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {hasChildren ? (
              <button
                type="button"
                onClick={() => toggleExpand(node.id)}
                className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={isExpanded ? `Collapse ${node.breadcrumb}` : `Expand ${node.breadcrumb}`}
              >
                {isExpanded ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
              </button>
            ) : (
              <div className="size-11 shrink-0" />
            )}

            <button
              type="button"
              onClick={() => handleStartEdit(node)}
              disabled={isPending}
              className="flex min-w-0 min-h-11 flex-1 items-center gap-2 text-left py-2 disabled:opacity-60"
              aria-label={`Edit button ${node.translations[activeLangTab]?.label || node.actionType}`}
            >
              <FolderTree className="size-4 shrink-0 text-primary/70" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {node.translations[activeLangTab]?.label ||
                      node.translations[defaultLangCode]?.label ||
                      `[${node.actionType}]`}
                  </span>
                  <Badge variant="secondary" className="text-[10px] font-mono shrink-0">
                    {node.actionType === "OPEN_SUBMENU"
                      ? "Submenu"
                      : node.actionType === "SHOW_DETAILS"
                      ? "Details"
                      : node.actionType === "START_INQUIRY"
                      ? "Inquiry"
                      : `Unsupported (${node.actionType})`}
                  </Badge>
                </div>
              </div>
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 ml-auto sm:ml-0">
            {/* Availability Badges */}
            {node.effectiveVisibility ? (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 text-xs"
              >
                Active
              </Badge>
            ) : node.isActive && (node.hasInactiveAncestor || !isProductActive || !isCategoryActive) ? (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-amber-700 text-xs"
                title="Active, but hidden from customers because parent, product, or category is inactive"
              >
                Active (Hidden)
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground text-xs">
                Inactive
              </Badge>
            )}

            {/* Depth Warning Badge */}
            {node.hasDepthWarning && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-700 text-xs gap-1"
                title="Nesting depth exceeds recommended 8 levels for mobile Telegram"
              >
                <AlertTriangle className="size-3" />
                L{node.level}
              </Badge>
            )}

            {/* Add Child button (OPEN_SUBMENU only) */}
            {isMenuType && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={node.isAtMaxDepth}
                onClick={() => handleOpenCreate(node.id)}
                className="size-11 text-muted-foreground hover:text-foreground"
                title={
                  node.isAtMaxDepth
                    ? "Max depth reached (16 levels)"
                    : `Add child button to ${node.translations[defaultLangCode]?.label || "Submenu"}`
                }
                aria-label={`Add child to ${node.translations[defaultLangCode]?.label || "Submenu"}`}
                data-testid="add-child-action-btn"
              >
                <Plus className="size-4" />
              </Button>
            )}
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="space-y-1 w-full min-w-0 max-w-full">
            {node.children.map((child) => renderActionNode(child))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 w-full min-w-0" data-testid="product-action-editor">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="size-11"
              aria-label="Back to Product Details"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h2 className="text-xl font-bold tracking-tight">
                Buttons: {product.slug}
              </h2>
              <p className="text-xs text-muted-foreground">
                Category: {categoryBreadcrumb} • {product.price}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={reloadActions}
            disabled={isLoading}
            className="size-11"
            aria-label="Refresh buttons"
            title="Refresh buttons"
          >
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>

          <Button
            type="button"
            onClick={() => handleOpenCreate(null)}
            className="min-h-11 gap-2"
            data-testid="add-root-action-btn"
          >
            <Plus className="size-4" />
            Add Button
          </Button>
        </div>
      </div>

      {/* Global Inactive Notices */}
      {!isCategoryActive && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <span>
            Parent category is inactive. All buttons will be hidden from customers until the category is activated.
          </span>
        </div>
      )}

      {isCategoryActive && !isProductActive && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <span>
            This product is inactive. Buttons will become customer-visible once the product is activated.
          </span>
        </div>
      )}

      {/* Depth warning banner */}
      {hasAnyDepthWarning && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
        >
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <span>
            Nesting depth warning: Some buttons exceed 8 levels of nesting. We recommend keeping menus shallow for optimal Telegram mobile experience.
          </span>
        </div>
      )}

      {/* Feedback banner */}
      {actionFeedback && (
        <div
          role="alert"
          className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
            actionFeedback.success
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {actionFeedback.success ? (
            <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="size-5 shrink-0 text-destructive" />
          )}
          <div className="space-y-1">
            <p>{actionFeedback.message}</p>
            {actionFeedback.errors && (
              <ul className="list-inside list-disc text-xs space-y-0.5">
                {Object.entries(actionFeedback.errors).map(([field, err]) => (
                  <li key={field}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Main Content Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Tree Column */}
        <div className="lg:col-span-7 space-y-4 min-w-0">
          <Card className="rounded-2xl border-border/60 shadow-sm">
            <CardHeader className="p-4 border-b">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">
                    Interaction Hierarchy
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Ordered Telegram inline buttons and recursive submenus.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-xs font-mono">
                  {actions.length} {actions.length === 1 ? "button" : "buttons"}
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="p-4 space-y-2 min-w-0">
              {isLoading ? (
                <div className="flex items-center justify-center p-12 text-muted-foreground gap-2">
                  <Loader2 className="size-5 animate-spin" />
                  <span>Loading buttons...</span>
                </div>
              ) : tree.length === 0 ? (
                <div className="text-center py-12 px-4 space-y-3">
                  <FolderTree className="size-10 mx-auto text-muted-foreground/60" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      No buttons configured
                    </p>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                      Create a root submenu, product details button, or inquiry button to let customers interact with this product in Telegram.
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => handleOpenCreate(null)}
                    className="min-h-11 gap-2"
                  >
                    <Plus className="size-4" />
                    Add First Button
                  </Button>
                </div>
              ) : (
                <div className="space-y-1 min-w-0">
                  {tree.map((root) => renderActionNode(root))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Edit Drawer Column */}
        <div className="lg:col-span-5 space-y-4 min-w-0">
          {selectedNode ? (
            <Card className="rounded-2xl border-border/60 shadow-sm">
              <CardHeader className="p-4 border-b flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base font-semibold">
                    Edit Button
                  </CardTitle>
                  <CardDescription className="text-xs truncate max-w-[240px]">
                    {selectedNode.breadcrumb}
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setEditingActionId(null)}
                  className="size-11"
                  aria-label="Close button editor"
                >
                  <X className="size-4" />
                </Button>
              </CardHeader>

              <CardContent className="p-4 space-y-4">
                {/* Unsupported action notice */}
                {isSelectedUnsupported && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
                  >
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                    <span>
                      This button has unsupported action type &quot;{selectedNode.actionType}&quot; and cannot be edited in this slice. Its configuration and translations are preserved read-only.
                    </span>
                  </div>
                )}

                {/* Availability guidance if hidden */}
                {!selectedNode.effectiveVisibility && selectedNode.isActive && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
                  >
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                    <span>
                      {selectedNode.hasInactiveAncestor
                        ? `This button is active, but is hidden because ancestor "${selectedNode.inactiveAncestorLabel}" is inactive.`
                        : !isProductActive
                        ? "This button is active, but is hidden because this product is inactive."
                        : "This button is active, but is hidden because the category is inactive."}
                    </span>
                  </div>
                )}

                {/* Action Type Dropdown */}
                <div className="space-y-1.5">
                  <label htmlFor="edit-action-type" className="text-xs font-semibold">
                    Action Type
                  </label>
                  <select
                    id="edit-action-type"
                    value={editActionType}
                    disabled={
                      isPending ||
                      isSelectedUnsupported ||
                      (selectedNode.actionType === "OPEN_SUBMENU" &&
                        selectedNode.children.length > 0)
                    }
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      setEditActionType(e.target.value as SupportedActionType)
                    }
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                  >
                    <option value="OPEN_SUBMENU">OPEN_SUBMENU (Submenu with child buttons)</option>
                    <option value="SHOW_DETAILS">SHOW_DETAILS (Display product description & details)</option>
                    <option value="START_INQUIRY">START_INQUIRY (Customer thread for this product)</option>
                  </select>
                  {selectedNode.actionType === "OPEN_SUBMENU" &&
                    selectedNode.children.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Cannot change type while child buttons exist. Remove child buttons first.
                      </p>
                    )}
                </div>

                {/* Active Toggle */}
                <div className="flex items-center gap-3 pt-1">
                  <input
                    type="checkbox"
                    id="edit-is-active"
                    checked={editIsActive}
                    disabled={isPending || isSelectedUnsupported}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditIsActive(e.target.checked)}
                    className="size-5 rounded border-gray-300 text-primary focus:ring-primary min-h-11 min-w-11 disabled:opacity-60"
                  />
                  <label
                    htmlFor="edit-is-active"
                    className="text-sm font-medium cursor-pointer"
                  >
                    Button is Active
                  </label>
                </div>

                {/* Submenu child limit notice if near limit */}
                {selectedNode.actionType === "OPEN_SUBMENU" && (
                  <p className="text-xs text-muted-foreground">
                    Children: {selectedNode.activeChildCount} active / {selectedNode.childCount} total (limit {MAX_ACTIVE_CHILDREN} active)
                  </p>
                )}

                {/* Language Tabs */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold">Localized Content</label>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant={activeLangTab === defaultLangCode ? "default" : "outline"}
                        size="sm"
                        onClick={() => setActiveLangTab(defaultLangCode)}
                        className="text-xs min-h-11 px-3"
                      >
                        {defaultLangLabel} ({defaultLangCode.toUpperCase()})
                      </Button>
                      {arabicRegistered && defaultLangCode !== "ar" && (
                        <Button
                          type="button"
                          variant={activeLangTab === "ar" ? "default" : "outline"}
                          size="sm"
                          onClick={() => setActiveLangTab("ar")}
                          className="text-xs min-h-11 px-3"
                        >
                          العربية (AR)
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Status indicator */}
                  {(() => {
                    const status = resolveActionTranslationStatus({
                      currentLang: activeLangTab,
                      savedTranslations: selectedNode.translations,
                      defaultLanguageCode: defaultLangCode,
                      defaultLanguageLabel: defaultLangLabel,
                    });
                    return (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge
                          variant="outline"
                          className={
                            status.isSaved
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-700"
                          }
                        >
                          {status.label}
                        </Badge>
                      </div>
                    );
                  })()}

                  {/* Localized Label */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label
                        htmlFor="edit-action-label"
                        className="text-xs font-medium"
                      >
                        Button Text ({activeLangTab.toUpperCase()}){" "}
                        <span className="text-destructive">*</span>
                      </label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {Array.from(editDraftTranslations[activeLangTab]?.label || "").length}/
                        {MAX_ACTION_LABEL_LENGTH}
                      </span>
                    </div>
                    <input
                      id="edit-action-label"
                      data-testid="edit-action-label-input"
                      dir={activeLangTab === "ar" ? "rtl" : "ltr"}
                      value={editDraftTranslations[activeLangTab]?.label ?? ""}
                      disabled={isPending || isSelectedUnsupported}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const val = e.target.value;
                        setEditDraftTranslations((prev) => ({
                          ...prev,
                          [activeLangTab]: {
                            label: val,
                            menuText: prev[activeLangTab]?.menuText ?? "",
                          },
                        }));
                      }}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                      placeholder={
                        activeLangTab === "ar"
                          ? "مثال: عرض الخيارات"
                          : "e.g. Choose Options"
                      }
                      maxLength={MAX_ACTION_LABEL_LENGTH}
                    />
                  </div>

                  {/* Localized Submenu Message (OPEN_SUBMENU only) */}
                  {editActionType === "OPEN_SUBMENU" ? (
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <label
                          htmlFor="edit-action-menu-text"
                          className="text-xs font-medium"
                        >
                          Submenu Message ({activeLangTab.toUpperCase()})
                        </label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {Array.from(editDraftTranslations[activeLangTab]?.menuText || "").length}/
                          {MAX_ACTION_MENU_TEXT_LENGTH}
                        </span>
                      </div>
                      <textarea
                        id="edit-action-menu-text"
                        data-testid="edit-action-menu-text-input"
                        dir={activeLangTab === "ar" ? "rtl" : "ltr"}
                        value={editDraftTranslations[activeLangTab]?.menuText ?? ""}
                        disabled={isPending || isSelectedUnsupported}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                          const val = e.target.value;
                          setEditDraftTranslations((prev) => ({
                            ...prev,
                            [activeLangTab]: {
                              label: prev[activeLangTab]?.label ?? "",
                              menuText: val,
                            },
                          }));
                        }}
                        rows={3}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                        placeholder={
                          activeLangTab === "ar"
                            ? "رسالة اختيارية يتم إرسالها قبل أزرار القائمة الفرعية"
                            : "Optional message sent before this submenu's buttons"
                        }
                      />
                    </div>
                  ) : (
                    <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
                      {editActionType === "SHOW_DETAILS" ? (
                        <p>
                          <strong>SHOW_DETAILS:</strong> Displays the product&apos;s existing localized description and details. No custom menu message is needed.
                        </p>
                      ) : (
                        <p>
                          <strong>START_INQUIRY:</strong> Opens a dedicated customer inquiry thread for this product. No extra configuration is needed.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Drawer Action Buttons */}
                <div className="flex justify-end gap-2 pt-4 border-t">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditingActionId(null)}
                    className="min-h-11"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={isPending || isSelectedUnsupported}
                    className="min-h-11 gap-2"
                    data-testid="save-action-btn"
                  >
                    {isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )}
                    Save Button
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="rounded-2xl border-dashed border-border/80 shadow-none bg-muted/10 p-6 text-center text-muted-foreground">
              <p className="text-sm">
                Select a button from the hierarchy to view or edit its details.
              </p>
            </Card>
          )}
        </div>
      </div>

      {/* Creation Modal / Dialog */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-background border shadow-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-semibold">
                  {createParentActionId ? "Add Child Button" : "Add Root Button"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {createParentActionId
                    ? `Nesting under: ${
                        flattened.find((a) => a.id === createParentActionId)?.breadcrumb || "Parent"
                      }`
                    : "Creates a button at the top level of this product."}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setIsCreateOpen(false)}
                className="size-11"
                aria-label="Close dialog"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="space-y-4">
              {/* Action Type */}
              <div className="space-y-1.5">
                <label htmlFor="create-action-type" className="text-xs font-semibold">
                  Action Type
                </label>
                <select
                  id="create-action-type"
                  data-testid="create-action-type-select"
                  value={createType}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setCreateType(e.target.value as SupportedActionType)
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                >
                  <option value="OPEN_SUBMENU">OPEN_SUBMENU (Submenu with child buttons)</option>
                  <option value="SHOW_DETAILS">SHOW_DETAILS (Display product description & details)</option>
                  <option value="START_INQUIRY">START_INQUIRY (Customer thread for this product)</option>
                </select>
              </div>

              {/* Active Toggle */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="create-is-active"
                  data-testid="create-action-is-active"
                  checked={createIsActive}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateIsActive(e.target.checked)}
                  className="size-5 rounded border-gray-300 text-primary focus:ring-primary min-h-11 min-w-11"
                />
                <label
                  htmlFor="create-is-active"
                  className="text-sm font-medium cursor-pointer"
                >
                  Create as Active
                </label>
              </div>

              {/* Default Language Label */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label
                    htmlFor="create-action-label"
                    className="text-xs font-semibold"
                  >
                    Button Label ({defaultLangLabel}){" "}
                    <span className="text-destructive">*</span>
                  </label>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {Array.from(createLabel).length}/{MAX_ACTION_LABEL_LENGTH}
                  </span>
                </div>
                <input
                  id="create-action-label"
                  data-testid="create-action-label-input"
                  dir={defaultLangDir}
                  value={createLabel}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateLabel(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                  placeholder={
                    defaultLangCode === "ar"
                      ? "مثال: عرض الخيارات"
                      : "e.g. Choose Options"
                  }
                  maxLength={MAX_ACTION_LABEL_LENGTH}
                />
              </div>

              {/* Default Language Menu Text (OPEN_SUBMENU only) */}
              {createType === "OPEN_SUBMENU" && (
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label
                      htmlFor="create-action-menu-text"
                      className="text-xs font-semibold"
                    >
                      Submenu Message ({defaultLangLabel}) (Optional)
                    </label>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {Array.from(createMenuText).length}/{MAX_ACTION_MENU_TEXT_LENGTH}
                    </span>
                  </div>
                  <textarea
                    id="create-action-menu-text"
                    data-testid="create-action-menu-text-input"
                    dir={defaultLangDir}
                    value={createMenuText}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateMenuText(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder={
                      defaultLangCode === "ar"
                        ? "رسالة اختيارية يتم إرسالها قبل أزرار القائمة الفرعية"
                        : "Optional message sent before this submenu's buttons"
                    }
                  />
                </div>
              )}

              {/* Optional Arabic fields if registered & default is not Arabic */}
              {arabicRegistered && defaultLangCode !== "ar" && (
                <div className="border-t pt-3 space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground">
                    Optional Arabic Translation (العربية)
                  </p>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="create-action-ar-label"
                      className="text-xs font-medium"
                    >
                      Button Label (Arabic)
                    </label>
                    <input
                      id="create-action-ar-label"
                      data-testid="create-action-ar-label-input"
                      dir="rtl"
                      value={createArabicLabel}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateArabicLabel(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="مثال: عرض الخيارات"
                      maxLength={MAX_ACTION_LABEL_LENGTH}
                    />
                  </div>

                  {createType === "OPEN_SUBMENU" && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="create-action-ar-menu-text"
                        className="text-xs font-medium"
                      >
                        Submenu Message (Arabic)
                      </label>
                      <textarea
                        id="create-action-ar-menu-text"
                        data-testid="create-action-ar-menu-text-input"
                        dir="rtl"
                        value={createArabicMenuText}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateArabicMenuText(e.target.value)}
                        rows={2}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                        placeholder="رسالة اختيارية يتم إرسالها قبل أزرار القائمة الفرعية"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateOpen(false)}
                className="min-h-11"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCreateAction}
                disabled={isPending || createLabel.trim().length === 0}
                className="min-h-11 gap-2"
                data-testid="submit-create-action-btn"
              >
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Create Button
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
