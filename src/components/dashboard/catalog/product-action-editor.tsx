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
  Info,
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
  ACTION_MESSAGE_PLACEHOLDERS,
  MAX_ACTION_LABEL_LENGTH,
  MAX_ACTION_MENU_TEXT_LENGTH,
  MAX_ACTION_TEMPLATE_BODY_LENGTH,
  MAX_ACTIVE_CHILDREN,
  type SupportedActionType,
} from "@/lib/product-actions/constants";
import { resolveActionTranslationStatus } from "@/lib/product-actions/status";
import { interpolateActionTemplate } from "@/lib/product-actions/templates";
import {
  buildActionHierarchy,
  type HierarchyActionNode,
  type RawActionNode,
} from "@/lib/product-actions/tree";
import type { CatalogCategoryRecord, CatalogProductRecord } from "./types";

interface ProductActionEditorProps {
  product: CatalogProductRecord;
  categoryBreadcrumb: string;
  isProductActive: boolean;
  isCategoryActive: boolean;
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  categories?: CatalogCategoryRecord[];
  products?: CatalogProductRecord[];
  settings?: {
    displayName: string;
    currency: string;
    supportCategory?: string[];
  };
  onClose: () => void;
}

export function ProductActionEditor({
  product,
  categoryBreadcrumb,
  isProductActive,
  isCategoryActive,
  defaultLanguage,
  languages,
  categories = [],
  products = [],
  settings,
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
  const loadGenerationRef = useRef(0);
  const isReadActiveRef = useRef(false);
  const isMutationActiveRef = useRef(false);
  const currentProductIdRef = useRef(product.id);
  const editingActionIdRef = useRef<string | null>(null);

  useEffect(() => {
    editingActionIdRef.current = editingActionId;
  }, [editingActionId]);

  const [prevProductId, setPrevProductId] = useState(product.id);

  // Edit Form State
  const [editActionType, setEditActionType] = useState<SupportedActionType>("OPEN_SUBMENU");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editUrl, setEditUrl] = useState("");
  const [editSupportCategory, setEditSupportCategory] = useState("");
  const [editNavTargetKind, setEditNavTargetKind] = useState<"category" | "product">("category");
  const [editNavTargetId, setEditNavTargetId] = useState("");

  const [editDraftTranslations, setEditDraftTranslations] = useState<
    Record<string, { label: string; menuText: string; templateBody: string }>
  >({});

  // Reset local state if product changes
  if (product.id !== prevProductId) {
    setPrevProductId(product.id);
    setActions([]);
    setIsLoading(true);
    setEditingActionId(null);
    setActionFeedback(null);
    setEditDraftTranslations({});
    setIsCreateOpen(false);
  }

  // Combined busy flag for UI controls
  const isBusy = isLoading || isPending;

  const reloadActions = () => {
    if (isReadActiveRef.current || isMutationActiveRef.current || isBusy) {
      return;
    }
    const targetProductId = currentProductIdRef.current;
    const gen = ++loadGenerationRef.current;
    isReadActiveRef.current = true;
    setIsLoading(true);
    setActionFeedback(null);

    loadProductActionsAction(targetProductId)
      .then((res) => {
        if (
          gen !== loadGenerationRef.current ||
          targetProductId !== currentProductIdRef.current
        ) {
          return;
        }
        isReadActiveRef.current = false;
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
        if (
          gen !== loadGenerationRef.current ||
          targetProductId !== currentProductIdRef.current
        ) {
          return;
        }
        isReadActiveRef.current = false;
        setIsLoading(false);
        setActionFeedback({
          success: false,
          message:
            "A communication error occurred while loading buttons. Please try again.",
        });
      });
  };

  useEffect(() => {
    currentProductIdRef.current = product.id;
    const gen = ++loadGenerationRef.current;
    isReadActiveRef.current = false;
    isMutationActiveRef.current = false;
    let isCurrent = true;

    if (!isMutationActiveRef.current) {
      isReadActiveRef.current = true;
      setIsLoading(true);
      setActionFeedback(null);

      loadProductActionsAction(product.id)
        .then((res) => {
          if (
            !isCurrent ||
            gen !== loadGenerationRef.current ||
            product.id !== currentProductIdRef.current
          ) {
            return;
          }
          isReadActiveRef.current = false;
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
          if (
            !isCurrent ||
            gen !== loadGenerationRef.current ||
            product.id !== currentProductIdRef.current
          ) {
            return;
          }
          isReadActiveRef.current = false;
          setIsLoading(false);
          setActionFeedback({
            success: false,
            message:
              "A communication error occurred while loading buttons. Please try again.",
          });
        });
    }

    return () => {
      isCurrent = false;
      isReadActiveRef.current = false;
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

  // Build category paths and ancestor availability for target pickers
  const categoryPaths = useMemo(() => {
    const catMap = new Map<string, CatalogCategoryRecord>(
      categories.map((c) => [c.id, c]),
    );

    const getPathAndStatus = (c: CatalogCategoryRecord): {
      path: string;
      hasInactiveAncestor: boolean;
      inactiveAncestorName?: string;
    } => {
      const names: string[] = [];
      let current: CatalogCategoryRecord | undefined = c;
      const visited = new Set<string>();
      let hasInactiveAncestor = false;
      let inactiveAncestorName: string | undefined = undefined;

      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const name =
          current.translations[defaultLangCode]?.name ||
          current.translations["en"]?.name ||
          current.slug;
        names.unshift(name);

        const parent: CatalogCategoryRecord | undefined = current.parentId
          ? catMap.get(current.parentId)
          : undefined;
        if (parent && !parent.isActive && !hasInactiveAncestor) {
          hasInactiveAncestor = true;
          inactiveAncestorName =
            parent.translations[defaultLangCode]?.name ||
            parent.translations["en"]?.name ||
            parent.slug;
        }
        current = parent;
      }
      return { path: names.join(" > "), hasInactiveAncestor, inactiveAncestorName };
    };

    const result = new Map<
      string,
      {
        path: string;
        record: CatalogCategoryRecord;
        hasInactiveAncestor: boolean;
        inactiveAncestorName?: string;
      }
    >();
    for (const cat of categories) {
      const { path, hasInactiveAncestor, inactiveAncestorName } = getPathAndStatus(cat);
      result.set(cat.id, {
        path,
        record: cat,
        hasInactiveAncestor,
        inactiveAncestorName,
      });
    }
    return result;
  }, [categories, defaultLangCode]);

  // Selected action node
  const selectedNode = useMemo(() => {
    if (!editingActionId) return null;
    return flattened.find((a) => a.id === editingActionId) ?? null;
  }, [flattened, editingActionId]);

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
    setEditUrl(node.url ?? "");

    const config = (node.actionConfig as { support_category?: string } | null) ?? {};
    setEditSupportCategory(config.support_category ?? "");

    if (node.navigateProductId) {
      setEditNavTargetKind("product");
      setEditNavTargetId(node.navigateProductId);
    } else if (node.navigateCategoryId) {
      setEditNavTargetKind("category");
      setEditNavTargetId(node.navigateCategoryId);
    } else {
      setEditNavTargetKind("category");
      setEditNavTargetId("");
    }

    const trans: Record<string, { label: string; menuText: string; templateBody: string }> = {};
    for (const [code, t] of Object.entries(node.translations)) {
      trans[code] = {
        label: t.label ?? "",
        menuText: t.menuText ?? "",
        templateBody: t.templateBody ?? "",
      };
    }
    setEditDraftTranslations(trans);
  };

  const handleStartEdit = (node: HierarchyActionNode) => {
    if (isReadActiveRef.current || isMutationActiveRef.current || isBusy) {
      return;
    }
    setEditingActionId(node.id);
    setActionFeedback(null);
    syncEditDraft(node);
  };

  const handleSaveEdit = () => {
    if (!selectedNode) return;
    if (isReadActiveRef.current || isMutationActiveRef.current || isBusy) {
      return;
    }
    const targetActionId = selectedNode.id;
    const targetProductId = currentProductIdRef.current;
    const targetVersion = ++saveVersionRef.current;
    const submittedLang = activeLangTab;
    const draft = editDraftTranslations[submittedLang] || {
      label: "",
      menuText: "",
      templateBody: "",
    };
    const submittedLabel = draft.label;
    const submittedMenuText = draft.menuText;
    const submittedTemplateBody = draft.templateBody;

    isMutationActiveRef.current = true;

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
          templateBody:
            editActionType === "SEND_TEMPLATE_MESSAGE" ? submittedTemplateBody : null,
          url: editActionType === "OPEN_URL" ? editUrl : null,
          navigateCategoryId:
            editActionType === "NAVIGATE_CATALOG" && editNavTargetKind === "category"
              ? (editNavTargetId || null)
              : null,
          navigateProductId:
            editActionType === "NAVIGATE_CATALOG" && editNavTargetKind === "product"
              ? (editNavTargetId || null)
              : null,
          actionConfig:
            editActionType === "OPEN_SUPPORT"
              ? (editSupportCategory ? { support_category: editSupportCategory } : {})
              : {},
        });

        if (
          targetProductId !== currentProductIdRef.current ||
          targetActionId !== editingActionIdRef.current ||
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
          setEditUrl(authoritative.url ?? "");

          const authoritativeConfig =
            (authoritative.actionConfig as { support_category?: string } | null) ?? {};
          setEditSupportCategory(authoritativeConfig.support_category ?? "");

          if (authoritative.navigateProductId) {
            setEditNavTargetKind("product");
            setEditNavTargetId(authoritative.navigateProductId);
          } else if (authoritative.navigateCategoryId) {
            setEditNavTargetKind("category");
            setEditNavTargetId(authoritative.navigateCategoryId);
          }

          // Reconcile ONLY submitted language draft, preserving text entered after submission
          setEditDraftTranslations((prev) => {
            const currentDraft = prev[submittedLang];
            if (
              currentDraft &&
              (currentDraft.label !== submittedLabel ||
                currentDraft.menuText !== submittedMenuText ||
                currentDraft.templateBody !== submittedTemplateBody)
            ) {
              return prev; // User entered new text during save; do not overwrite!
            }
            const savedTrans = authoritative.translations[submittedLang];
            return {
              ...prev,
              [submittedLang]: {
                label: savedTrans?.label ?? "",
                menuText: savedTrans?.menuText ?? "",
                templateBody: savedTrans?.templateBody ?? "",
              },
            };
          });
        }
      } catch {
        if (
          targetProductId === currentProductIdRef.current &&
          targetActionId === editingActionIdRef.current &&
          targetVersion === saveVersionRef.current
        ) {
          setActionFeedback({
            success: false,
            message:
              "A communication or server error occurred. Your changes have been preserved. Please try again.",
          });
        }
      } finally {
        isMutationActiveRef.current = false;
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
  const [createTemplateBody, setCreateTemplateBody] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createSupportCategory, setCreateSupportCategory] = useState("");
  const [createNavTargetKind, setCreateNavTargetKind] = useState<"category" | "product">("category");
  const [createNavTargetId, setCreateNavTargetId] = useState("");

  const [createArabicLabel, setCreateArabicLabel] = useState("");
  const [createArabicMenuText, setCreateArabicMenuText] = useState("");
  const [createArabicTemplateBody, setCreateArabicTemplateBody] = useState("");

  const handleOpenCreate = (parentId: string | null = null) => {
    if (isReadActiveRef.current || isMutationActiveRef.current || isBusy) {
      return;
    }
    setCreateParentActionId(parentId);
    setCreateType("OPEN_SUBMENU");
    setCreateIsActive(true);
    setCreateLabel("");
    setCreateMenuText("");
    setCreateTemplateBody("");
    setCreateUrl("");
    setCreateSupportCategory("");
    setCreateNavTargetKind("category");
    setCreateNavTargetId("");
    setCreateArabicLabel("");
    setCreateArabicMenuText("");
    setCreateArabicTemplateBody("");
    setIsCreateOpen(true);
    setActionFeedback(null);
  };

  const handleCreateAction = () => {
    if (isReadActiveRef.current || isMutationActiveRef.current || isBusy) {
      return;
    }
    const targetProductId = currentProductIdRef.current;
    isMutationActiveRef.current = true;

    startTransition(async () => {
      try {
        const res = await createProductActionAction({
          productId: targetProductId,
          parentActionId: createParentActionId,
          actionType: createType,
          isActive: createIsActive,
          label: createLabel,
          menuText: createType === "OPEN_SUBMENU" ? createMenuText : null,
          templateBody:
            createType === "SEND_TEMPLATE_MESSAGE" ? createTemplateBody : null,
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
          arabicTemplateBody:
            createType === "SEND_TEMPLATE_MESSAGE" &&
            arabicRegistered &&
            defaultLangCode !== "ar" &&
            createArabicTemplateBody.trim().length > 0
              ? createArabicTemplateBody
              : undefined,
          url: createType === "OPEN_URL" ? createUrl : null,
          navigateCategoryId:
            createType === "NAVIGATE_CATALOG" && createNavTargetKind === "category"
              ? (createNavTargetId || null)
              : null,
          navigateProductId:
            createType === "NAVIGATE_CATALOG" && createNavTargetKind === "product"
              ? (createNavTargetId || null)
              : null,
          actionConfig:
            createType === "OPEN_SUPPORT"
              ? (createSupportCategory ? { support_category: createSupportCategory } : {})
              : {},
        });

        if (targetProductId !== currentProductIdRef.current) {
          return;
        }

        setActionFeedback(res);

        if (res.success && res.action) {
          setActions((prev) => [...prev, res.action!]);
          setIsCreateOpen(false);
          if (createParentActionId) {
            setExpandedNodeIds((prev) => new Set([...prev, createParentActionId]));
          }
        }
      } catch {
        if (targetProductId === currentProductIdRef.current) {
          setActionFeedback({
            success: false,
            message:
              "A communication or server error occurred. Your inputs have been preserved. Please try again.",
          });
        }
      } finally {
        isMutationActiveRef.current = false;
      }
    });
  };

  // Helper sample context for template live preview
  const sampleContext = useMemo(() => {
    const storeName = settings?.displayName?.trim() || "Acme Digital";
    const prodName =
      product.translations[activeLangTab]?.name ||
      product.translations[defaultLangCode]?.name ||
      product.slug;
    const currency = settings?.currency ?? "USD";
    const price = `${currency} ${product.price}`;

    return {
      store_name: storeName,
      product_name: prodName,
      customer_name: "Sarah Ahmed",
      price,
    };
  }, [settings, product, activeLangTab, defaultLangCode]);

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
              disabled={isBusy}
              className="flex min-w-0 min-h-11 flex-1 items-center gap-2 text-left py-2 disabled:opacity-60"
              aria-label={`Edit button ${node.translations[activeLangTab]?.label || node.actionType}`}
              data-testid="select-action-btn"
            >
              <FolderTree className="size-4 shrink-0 text-primary/70" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
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
                      : node.actionType === "SEND_TEMPLATE_MESSAGE"
                      ? "Message"
                      : node.actionType === "OPEN_URL"
                      ? "URL"
                      : node.actionType === "OPEN_SUPPORT"
                      ? "Support"
                      : node.actionType === "NAVIGATE_CATALOG"
                      ? "Navigate"
                      : node.actionType}
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
                disabled={node.isAtMaxDepth || isBusy}
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
    <div className="space-y-6 w-full min-w-0 overflow-x-hidden" data-testid="product-action-editor">
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
            disabled={isBusy}
            className="size-11"
            aria-label="Refresh buttons"
            title="Refresh buttons"
          >
            <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>

          <Button
            type="button"
            onClick={() => handleOpenCreate(null)}
            disabled={isBusy}
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
                      Create buttons to let customers interact with this product in Telegram.
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => handleOpenCreate(null)}
                    disabled={isBusy}
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
                {/* Type transition warning */}
                {selectedNode.actionType !== editActionType && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800"
                  >
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                    <span>
                      Changing action type will remove incompatible saved configuration (such as message bodies, URLs, or navigation targets) upon saving.
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
                      isBusy ||
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
                    <option value="SEND_TEMPLATE_MESSAGE">SEND_TEMPLATE_MESSAGE (Send customized message)</option>
                    <option value="OPEN_URL">OPEN_URL (Open external HTTPS web link)</option>
                    <option value="OPEN_SUPPORT">OPEN_SUPPORT (Open general support conversation)</option>
                    <option value="NAVIGATE_CATALOG">NAVIGATE_CATALOG (Jump to category or product)</option>
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
                    data-testid="edit-action-is-active"
                    checked={editIsActive}
                    disabled={isBusy}
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

                {/* Submenu child limit notice */}
                {selectedNode.actionType === "OPEN_SUBMENU" && (
                  <p className="text-xs text-muted-foreground">
                    Children: {selectedNode.activeChildCount} active / {selectedNode.childCount} total (limit {MAX_ACTIVE_CHILDREN} active)
                  </p>
                )}

                {/* TYPE-SPECIFIC CONFIGURATION: OPEN_URL */}
                {editActionType === "OPEN_URL" && (
                  <div className="space-y-1.5 pt-2 border-t">
                    <label htmlFor="edit-action-url" className="text-xs font-semibold">
                      HTTPS Web Link <span className="text-destructive">*</span>
                    </label>
                    <input
                      id="edit-action-url"
                      data-testid="edit-action-url-input"
                      type="url"
                      value={editUrl}
                      disabled={isBusy}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="https://example.com/info"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Opens an external web page. Must use HTTPS. Cannot be used for payments or checkout.
                    </p>
                  </div>
                )}

                {/* TYPE-SPECIFIC CONFIGURATION: OPEN_SUPPORT */}
                {editActionType === "OPEN_SUPPORT" && (
                  <div className="space-y-1.5 pt-2 border-t">
                    <label htmlFor="edit-action-support-category" className="text-xs font-semibold">
                      Support Category (Optional)
                    </label>
                    <select
                      id="edit-action-support-category"
                      data-testid="edit-action-support-category-select"
                      value={editSupportCategory}
                      disabled={isBusy}
                      onChange={(e) => setEditSupportCategory(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    >
                      <option value="">General Support (No category)</option>
                      {(settings?.supportCategory ?? []).map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                      {/* Truthfully show unavailable category if previously configured but deleted in settings */}
                      {editSupportCategory &&
                        !(settings?.supportCategory ?? []).includes(editSupportCategory) && (
                          <option value={editSupportCategory}>
                            [Unavailable] {editSupportCategory}
                          </option>
                        )}
                    </select>
                    {editSupportCategory &&
                      !(settings?.supportCategory ?? []).includes(editSupportCategory) && (
                        <p className="text-[11px] text-amber-600">
                          Previously configured category &quot;{editSupportCategory}&quot; is no longer configured in store settings. You may clear or replace it.
                        </p>
                      )}
                  </div>
                )}

                {/* TYPE-SPECIFIC CONFIGURATION: NAVIGATE_CATALOG */}
                {editActionType === "NAVIGATE_CATALOG" && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="space-y-1.5">
                      <label htmlFor="edit-action-nav-kind" className="text-xs font-semibold">
                        Navigation Destination Kind
                      </label>
                      <select
                        id="edit-action-nav-kind"
                        data-testid="edit-action-nav-kind-select"
                        value={editNavTargetKind}
                        disabled={isBusy}
                        onChange={(e) => {
                          setEditNavTargetKind(e.target.value as "category" | "product");
                          setEditNavTargetId("");
                        }}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                      >
                        <option value="category">Category</option>
                        <option value="product">Product</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="edit-action-nav-target" className="text-xs font-semibold">
                        Select Target {editNavTargetKind === "category" ? "Category" : "Product"} <span className="text-destructive">*</span>
                      </label>
                      <select
                        id="edit-action-nav-target"
                        data-testid="edit-action-nav-target-select"
                        value={editNavTargetId}
                        disabled={isBusy}
                        onChange={(e) => setEditNavTargetId(e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                      >
                        <option value="">-- Choose destination --</option>
                        {editNavTargetKind === "category" &&
                          Boolean(
                            editNavTargetId &&
                              !categories.some((c) => c.id === editNavTargetId),
                          ) && (
                            <option value={editNavTargetId}>
                              (Unavailable / Deleted category)
                            </option>
                          )}
                        {editNavTargetKind === "product" &&
                          Boolean(
                            editNavTargetId &&
                              !products.some((p) => p.id === editNavTargetId),
                          ) && (
                            <option value={editNavTargetId}>
                              (Unavailable / Deleted product)
                            </option>
                          )}
                        {editNavTargetKind === "category"
                          ? categories.map((cat) => {
                              const catInfo = categoryPaths.get(cat.id);
                              const path = catInfo?.path || cat.slug;
                              const statusBadge = !cat.isActive
                                ? "(Inactive)"
                                : catInfo?.hasInactiveAncestor
                                ? "(Hidden - Inactive ancestor)"
                                : "";
                              return (
                                <option key={cat.id} value={cat.id}>
                                  {path} {statusBadge}
                                </option>
                              );
                            })
                          : products.map((prod) => {
                              const name =
                                prod.translations[defaultLangCode]?.name ||
                                prod.translations["en"]?.name ||
                                prod.slug;
                              const catInfo = prod.categoryId
                                ? categoryPaths.get(prod.categoryId)
                                : undefined;
                              const catPath = catInfo?.path ? `(${catInfo.path})` : "";
                              const statusBadge = !prod.isActive
                                ? "(Inactive)"
                                : catInfo && !catInfo.record.isActive
                                ? "(Hidden - Inactive category)"
                                : catInfo?.hasInactiveAncestor
                                ? "(Hidden - Inactive category ancestor)"
                                : "";
                              return (
                                <option key={prod.id} value={prod.id}>
                                  {name} {catPath} {statusBadge}
                                </option>
                              );
                            })}
                      </select>
                    </div>

                    {/* Target status / warning */}
                    {(() => {
                      if (!editNavTargetId) {
                        return (
                          <p className="text-[11px] text-muted-foreground">
                            Catalog navigation jumps customer to the selected item.
                          </p>
                        );
                      }
                      if (editNavTargetKind === "category") {
                        const cat = categories.find((c) => c.id === editNavTargetId);
                        if (!cat) {
                          return (
                            <p className="text-[11px] text-destructive">
                              Target category no longer exists or has been deleted. Action cannot be activated until a new destination is selected.
                            </p>
                          );
                        }
                        const catInfo = categoryPaths.get(cat.id);
                        if (!cat.isActive) {
                          return (
                            <p className="text-[11px] text-amber-600">
                              Selected category is currently inactive and hidden from customers.
                            </p>
                          );
                        }
                        if (catInfo?.hasInactiveAncestor) {
                          return (
                            <p className="text-[11px] text-amber-600">
                              Selected category is active, but hidden from customers because ancestor &quot;{catInfo.inactiveAncestorName}&quot; is inactive.
                            </p>
                          );
                        }
                      } else {
                        const prod = products.find((p) => p.id === editNavTargetId);
                        if (!prod) {
                          return (
                            <p className="text-[11px] text-destructive">
                              Target product no longer exists or has been deleted. Action cannot be activated until a new destination is selected.
                            </p>
                          );
                        }
                        const prodCatInfo = prod.categoryId
                          ? categoryPaths.get(prod.categoryId)
                          : undefined;
                        if (!prod.isActive) {
                          return (
                            <p className="text-[11px] text-amber-600">
                              Selected product is currently inactive and hidden from customers.
                            </p>
                          );
                        }
                        if (prodCatInfo && !prodCatInfo.record.isActive) {
                          return (
                            <p className="text-[11px] text-amber-600">
                              Selected product is active, but hidden from customers because category &quot;{prodCatInfo.record.translations[defaultLangCode]?.name || prodCatInfo.record.translations["en"]?.name || prodCatInfo.record.slug}&quot; is inactive.
                            </p>
                          );
                        }
                        if (prodCatInfo?.hasInactiveAncestor) {
                          return (
                            <p className="text-[11px] text-amber-600">
                              Selected product is active, but hidden from customers because category ancestor &quot;{prodCatInfo.inactiveAncestorName}&quot; is inactive.
                            </p>
                          );
                        }
                      }
                      return null;
                    })()}
                  </div>
                )}

                {/* Language Tabs & Localized Content */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold">Localized Content</label>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant={activeLangTab === defaultLangCode ? "default" : "outline"}
                        size="sm"
                        disabled={isBusy}
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
                          disabled={isBusy}
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
                      actionType: editActionType,
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
                      disabled={isBusy}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const val = e.target.value;
                        setEditDraftTranslations((prev) => ({
                          ...prev,
                          [activeLangTab]: {
                            label: val,
                            menuText: prev[activeLangTab]?.menuText ?? "",
                            templateBody: prev[activeLangTab]?.templateBody ?? "",
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
                  {editActionType === "OPEN_SUBMENU" && (
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
                        disabled={isBusy}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                          const val = e.target.value;
                          setEditDraftTranslations((prev) => ({
                            ...prev,
                            [activeLangTab]: {
                              label: prev[activeLangTab]?.label ?? "",
                              menuText: val,
                              templateBody: prev[activeLangTab]?.templateBody ?? "",
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
                  )}

                  {/* Localized Template Body (SEND_TEMPLATE_MESSAGE only) */}
                  {editActionType === "SEND_TEMPLATE_MESSAGE" && (
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <label
                          htmlFor="edit-action-template-body"
                          className="text-xs font-medium"
                        >
                          Message Body ({activeLangTab.toUpperCase()}){" "}
                          {activeLangTab === defaultLangCode && (
                            <span className="text-destructive">*</span>
                          )}
                        </label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {Array.from(editDraftTranslations[activeLangTab]?.templateBody || "").length}/
                          {MAX_ACTION_TEMPLATE_BODY_LENGTH}
                        </span>
                      </div>
                      <textarea
                        id="edit-action-template-body"
                        data-testid="edit-action-template-body-input"
                        dir={activeLangTab === "ar" ? "rtl" : "ltr"}
                        value={editDraftTranslations[activeLangTab]?.templateBody ?? ""}
                        disabled={isBusy}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                          const val = e.target.value;
                          setEditDraftTranslations((prev) => ({
                            ...prev,
                            [activeLangTab]: {
                              label: prev[activeLangTab]?.label ?? "",
                              menuText: prev[activeLangTab]?.menuText ?? "",
                              templateBody: val,
                            },
                          }));
                        }}
                        rows={4}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60 font-mono text-xs"
                        placeholder={
                          activeLangTab === "ar"
                            ? "أهلاً {{customer_name}}! تفاصيل المنتج: {{product_name}} بسعر {{price}}."
                            : "Hello {{customer_name}}! Here are details for {{product_name}} priced at {{price}}."
                        }
                      />

                      {/* Supported Placeholder helper chips */}
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          Supported placeholders (click to insert):
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {ACTION_MESSAGE_PLACEHOLDERS.map((ph) => (
                            <button
                              key={ph}
                              type="button"
                              disabled={isBusy}
                              onClick={() => {
                                const current = editDraftTranslations[activeLangTab]?.templateBody ?? "";
                                const updated = `${current}{{${ph}}}`;
                                setEditDraftTranslations((prev) => ({
                                  ...prev,
                                  [activeLangTab]: {
                                    label: prev[activeLangTab]?.label ?? "",
                                    menuText: prev[activeLangTab]?.menuText ?? "",
                                    templateBody: updated,
                                  },
                                }));
                              }}
                              className="text-xs font-mono px-3 py-2.5 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md border bg-muted/60 hover:bg-muted text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                            >
                              {`{{${ph}}}`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Safe Preview Box */}
                      {(() => {
                        const currentDraft =
                          editDraftTranslations[activeLangTab]?.templateBody ?? "";
                        const hasCurrentDraft = currentDraft.trim().length > 0;
                        const activeLanguageObj = languages.find(
                          (l) => l.code === activeLangTab
                        );
                        const activeLangDir: "ltr" | "rtl" =
                          activeLanguageObj?.textDirection === "rtl" ||
                          activeLangTab === "ar"
                            ? "rtl"
                            : "ltr";

                        const savedDefaultTrans =
                          selectedNode.translations[defaultLangCode];
                        const savedDefaultBody =
                          savedDefaultTrans?.templateBody?.trim() || null;

                        let previewHeader = `Preview with sample values (not Telegram delivery):`;
                        let previewText = "";
                        let previewDir: "ltr" | "rtl" = activeLangDir;

                        if (hasCurrentDraft) {
                          previewHeader = `Sample preview of current ${activeLangTab.toUpperCase()} draft (not Telegram delivery):`;
                          previewText = interpolateActionTemplate(
                            currentDraft,
                            sampleContext
                          );
                          previewDir = activeLangDir;
                        } else if (activeLangTab === defaultLangCode) {
                          previewHeader = `Default language message body (required for active button):`;
                          previewText = "";
                          previewDir = defaultLangDir;
                        } else if (savedDefaultBody) {
                          previewHeader = `Draft fallback preview from saved ${defaultLangLabel} message body (applies if saved empty):`;
                          previewText = interpolateActionTemplate(
                            savedDefaultBody,
                            sampleContext
                          );
                          previewDir = defaultLangDir;
                        } else {
                          previewHeader = `Message body preview (${activeLangTab.toUpperCase()}):`;
                          previewText = "";
                          previewDir = activeLangDir;
                        }

                        return (
                          <div className="rounded-xl border bg-muted/30 p-3 space-y-1">
                            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                              <Info className="size-3.5" />
                              <span data-testid="edit-action-template-body-preview-header">
                                {previewHeader}
                              </span>
                            </div>
                            <div
                              className="text-xs p-2.5 rounded bg-background border whitespace-pre-wrap break-words"
                              dir={previewDir}
                              data-testid="edit-action-template-body-preview"
                            >
                              {previewText || (
                                <span className="text-muted-foreground italic">
                                  {activeLangTab === defaultLangCode
                                    ? "No message content entered"
                                    : "No saved default message body to fall back to"}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Read-only explanations for SHOW_DETAILS & START_INQUIRY */}
                  {(editActionType === "SHOW_DETAILS" || editActionType === "START_INQUIRY") && (
                    <div className="rounded-xl border bg-muted/40 p-3 text-xs text-muted-foreground">
                      {editActionType === "SHOW_DETAILS" ? (
                        <p>
                          <strong>SHOW_DETAILS:</strong> Displays the product&apos;s localized description and details. No custom menu message is needed.
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
                    disabled={isBusy}
                    className="min-h-11"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleSaveEdit}
                    disabled={isBusy}
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
                  disabled={isBusy}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setCreateType(e.target.value as SupportedActionType)
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                >
                  <option value="OPEN_SUBMENU">OPEN_SUBMENU (Submenu with child buttons)</option>
                  <option value="SHOW_DETAILS">SHOW_DETAILS (Display product description & details)</option>
                  <option value="START_INQUIRY">START_INQUIRY (Customer thread for this product)</option>
                  <option value="SEND_TEMPLATE_MESSAGE">SEND_TEMPLATE_MESSAGE (Send customized message)</option>
                  <option value="OPEN_URL">OPEN_URL (Open external HTTPS web link)</option>
                  <option value="OPEN_SUPPORT">OPEN_SUPPORT (Open general support conversation)</option>
                  <option value="NAVIGATE_CATALOG">NAVIGATE_CATALOG (Jump to category or product)</option>
                </select>
              </div>

              {/* Active Toggle */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="create-is-active"
                  data-testid="create-action-is-active"
                  checked={createIsActive}
                  disabled={isBusy}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateIsActive(e.target.checked)}
                  className="size-5 rounded border-gray-300 text-primary focus:ring-primary min-h-11 min-w-11 disabled:opacity-60"
                />
                <label
                  htmlFor="create-is-active"
                  className="text-sm font-medium cursor-pointer"
                >
                  Create as Active
                </label>
              </div>

              {/* TYPE-SPECIFIC CREATE FIELDS: OPEN_URL */}
              {createType === "OPEN_URL" && (
                <div className="space-y-1.5 pt-2 border-t">
                  <label htmlFor="create-action-url" className="text-xs font-semibold">
                    HTTPS Web Link <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-action-url"
                    data-testid="create-action-url-input"
                    type="url"
                    value={createUrl}
                    disabled={isBusy}
                    onChange={(e) => setCreateUrl(e.target.value)}
                    placeholder="https://example.com/info"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    External link for information pages. Must use HTTPS. Cannot be used for payments or checkout.
                  </p>
                </div>
              )}

              {/* TYPE-SPECIFIC CREATE FIELDS: OPEN_SUPPORT */}
              {createType === "OPEN_SUPPORT" && (
                <div className="space-y-1.5 pt-2 border-t">
                  <label htmlFor="create-action-support-category" className="text-xs font-semibold">
                    Support Category (Optional)
                  </label>
                  <select
                    id="create-action-support-category"
                    data-testid="create-action-support-category-select"
                    value={createSupportCategory}
                    disabled={isBusy}
                    onChange={(e) => setCreateSupportCategory(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                  >
                    <option value="">General Support (No category)</option>
                    {(settings?.supportCategory ?? []).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* TYPE-SPECIFIC CREATE FIELDS: NAVIGATE_CATALOG */}
              {createType === "NAVIGATE_CATALOG" && (
                <div className="space-y-3 pt-2 border-t">
                  <div className="space-y-1.5">
                    <label htmlFor="create-action-nav-kind" className="text-xs font-semibold">
                      Navigation Destination Kind
                    </label>
                    <select
                      id="create-action-nav-kind"
                      data-testid="create-action-nav-kind-select"
                      value={createNavTargetKind}
                      disabled={isBusy}
                      onChange={(e) => {
                        setCreateNavTargetKind(e.target.value as "category" | "product");
                        setCreateNavTargetId("");
                      }}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    >
                      <option value="category">Category</option>
                      <option value="product">Product</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-action-nav-target" className="text-xs font-semibold">
                      Select Target {createNavTargetKind === "category" ? "Category" : "Product"} <span className="text-destructive">*</span>
                    </label>
                    <select
                      id="create-action-nav-target"
                      data-testid="create-action-nav-target-select"
                      value={createNavTargetId}
                      disabled={isBusy}
                      onChange={(e) => setCreateNavTargetId(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    >
                      <option value="">-- Choose destination --</option>
                      {createNavTargetKind === "category"
                        ? categories.map((cat) => {
                            const catInfo = categoryPaths.get(cat.id);
                            const path = catInfo?.path || cat.slug;
                            const statusBadge = !cat.isActive
                              ? "(Inactive)"
                              : catInfo?.hasInactiveAncestor
                              ? "(Hidden - Inactive ancestor)"
                              : "";
                            return (
                              <option key={cat.id} value={cat.id}>
                                {path} {statusBadge}
                              </option>
                            );
                          })
                        : products.map((prod) => {
                            const name =
                              prod.translations[defaultLangCode]?.name ||
                              prod.translations["en"]?.name ||
                              prod.slug;
                            const catInfo = prod.categoryId
                              ? categoryPaths.get(prod.categoryId)
                              : undefined;
                            const catPath = catInfo?.path ? `(${catInfo.path})` : "";
                            const statusBadge = !prod.isActive
                              ? "(Inactive)"
                              : catInfo && !catInfo.record.isActive
                              ? "(Hidden - Inactive category)"
                              : catInfo?.hasInactiveAncestor
                              ? "(Hidden - Inactive category ancestor)"
                              : "";
                            return (
                              <option key={prod.id} value={prod.id}>
                                {name} {catPath} {statusBadge}
                              </option>
                            );
                          })}
                    </select>
                  </div>
                </div>
              )}

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
                  disabled={isBusy}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateLabel(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
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
                    disabled={isBusy}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateMenuText(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                    placeholder={
                      defaultLangCode === "ar"
                        ? "رسالة اختيارية يتم إرسالها قبل أزرار القائمة الفرعية"
                        : "Optional message sent before this submenu's buttons"
                    }
                  />
                </div>
              )}

              {/* Default Language Template Body (SEND_TEMPLATE_MESSAGE only) */}
              {createType === "SEND_TEMPLATE_MESSAGE" && (
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label
                      htmlFor="create-action-template-body"
                      className="text-xs font-semibold"
                    >
                      Message Body ({defaultLangLabel}) <span className="text-destructive">*</span>
                    </label>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {Array.from(createTemplateBody).length}/{MAX_ACTION_TEMPLATE_BODY_LENGTH}
                    </span>
                  </div>
                  <textarea
                    id="create-action-template-body"
                    data-testid="create-action-template-body-input"
                    dir={defaultLangDir}
                    value={createTemplateBody}
                    disabled={isBusy}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateTemplateBody(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60 font-mono text-xs"
                    placeholder={
                      defaultLangCode === "ar"
                        ? "أهلاً {{customer_name}}! تفاصيل المنتج: {{product_name}} بسعر {{price}}."
                        : "Hello {{customer_name}}! Here are details for {{product_name}} priced at {{price}}."
                    }
                  />

                  {/* Placeholder chips */}
                  <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground font-medium">
                      Supported placeholders:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {ACTION_MESSAGE_PLACEHOLDERS.map((ph) => (
                        <button
                          key={ph}
                          type="button"
                          disabled={isBusy}
                          onClick={() => setCreateTemplateBody((prev) => `${prev}{{${ph}}}`)}
                          className="text-xs font-mono px-3 py-2.5 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md border bg-muted/60 hover:bg-muted text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                        >
                          {`{{${ph}}}`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Preview Box */}
                  <div className="rounded-xl border bg-muted/30 p-2.5 space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                      <Info className="size-3.5" />
                      <span>Preview with sample values:</span>
                    </div>
                    <div
                      className="text-xs p-2 rounded bg-background border whitespace-pre-wrap break-words"
                      dir={defaultLangDir}
                    >
                      {interpolateActionTemplate(createTemplateBody, sampleContext) || (
                        <span className="text-muted-foreground italic">No message content</span>
                      )}
                    </div>
                  </div>
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
                      disabled={isBusy}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateArabicLabel(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
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
                        disabled={isBusy}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateArabicMenuText(e.target.value)}
                        rows={2}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60"
                        placeholder="رسالة اختيارية يتم إرسالها قبل أزرار القائمة الفرعية"
                      />
                    </div>
                  )}

                  {createType === "SEND_TEMPLATE_MESSAGE" && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="create-action-ar-template-body"
                        className="text-xs font-medium"
                      >
                        Message Body (Arabic)
                      </label>
                      <textarea
                        id="create-action-ar-template-body"
                        data-testid="create-action-ar-template-body-input"
                        dir="rtl"
                        value={createArabicTemplateBody}
                        disabled={isBusy}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCreateArabicTemplateBody(e.target.value)}
                        rows={3}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 disabled:opacity-60 font-mono text-xs"
                        placeholder="أهلاً {{customer_name}}! تفاصيل المنتج: {{product_name}} بسعر {{price}}."
                      />
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          Supported placeholders:
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {ACTION_MESSAGE_PLACEHOLDERS.map((ph) => (
                            <button
                              key={ph}
                              type="button"
                              disabled={isBusy}
                              onClick={() => setCreateArabicTemplateBody((prev) => `${prev}{{${ph}}}`)}
                              className="text-xs font-mono px-3 py-2.5 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md border bg-muted/60 hover:bg-muted text-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                            >
                              {`{{${ph}}}`}
                            </button>
                          ))}
                        </div>
                      </div>
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
                disabled={isPending}
                className="min-h-11"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCreateAction}
                disabled={isBusy || createLabel.trim().length === 0}
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
