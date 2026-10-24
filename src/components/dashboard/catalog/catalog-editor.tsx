"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  FolderTree,
  Globe,
  Info,
  Loader2,
  Package,
  PackagePlus,
  Plus,
  Save,
  Tag,
  X,
} from "lucide-react";

import {
  createCategoryAction,
  createProductAction,
  updateCategoryAction,
  updateProductAction,
  type CatalogActionResult,
} from "@/app/actions/catalog";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  buildCategoryHierarchy,
  type HierarchyCategoryNode,
} from "@/lib/catalog/tree";
import { resolveCatalogTranslationStatus } from "@/lib/catalog/status";
import { ProductActionEditor } from "./product-action-editor";
import type { CatalogCategoryRecord, CatalogViewData } from "./types";

export function CatalogEditor({
  settings,
  defaultLanguage,
  languages,
  categories: initialCategories,
  products: initialProducts,
}: CatalogViewData) {
  // Categories & Products state
  const [categories, setCategories] = useState(initialCategories);
  const [products, setProducts] = useState(initialProducts);

  // Selected Category (defaults to first root if any)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    initialCategories[0]?.id ?? null,
  );

  // Expanded nodes set for tree
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => {
    return new Set(initialCategories.map((c) => c.id));
  });

  // Languages metadata
  const arabicRegistered = languages.some((l) => l.code === "ar");
  const arabicRow = languages.find((l) => l.code === "ar");
  const arabicDisabled = arabicRow ? !arabicRow.isEnabled : false;
  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel = defaultLanguage?.label ?? (defaultLangCode === "ar" ? "العربية" : "English");
  const defaultLangDir = defaultLanguage?.textDirection ?? (defaultLangCode === "ar" ? "rtl" : "ltr");

  // Active language tab in editors (defaults to configured default language)
  const [activeLangTab, setActiveLangTab] = useState<string>(defaultLangCode);

  // Dialog / Modal states
  const [isCreateCategoryOpen, setIsCreateCategoryOpen] = useState(false);

  const [isCreateProductOpen, setIsCreateProductOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("actionProduct");
    }
    return null;
  });
  const [isActionEditorOpen, setIsActionEditorOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return Boolean(new URLSearchParams(window.location.search).get("actionProduct"));
    }
    return false;
  });

  const handleOpenActionEditor = (prodId: string) => {
    setEditingProductId(prodId);
    setIsActionEditorOpen(true);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("actionProduct", prodId);
      window.history.replaceState({}, "", url.toString());
    }
  };

  const handleCloseActionEditor = () => {
    setIsActionEditorOpen(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("actionProduct");
      window.history.replaceState({}, "", url.toString());
    }
  };

  // Pending transition for action executions
  const [isPending, startTransition] = useTransition();

  // Feedback states
  const [actionFeedback, setActionFeedback] = useState<CatalogActionResult | null>(null);

  // Build hierarchy tree
  const { tree, flattened } = useMemo(() => {
    return buildCategoryHierarchy(categories, {
      preferredLanguage: activeLangTab,
      defaultLanguage: defaultLangCode,
    });
  }, [categories, activeLangTab, defaultLangCode]);

  // Selected category node
  const selectedNode = useMemo(() => {
    if (!selectedCategoryId) return null;
    return flattened.find((c) => c.id === selectedCategoryId) ?? null;
  }, [flattened, selectedCategoryId]);

  // Products belonging to the selected category
  const categoryProducts = useMemo(() => {
    if (!selectedCategoryId) return [];
    return products.filter((p) => p.categoryId === selectedCategoryId);
  }, [products, selectedCategoryId]);

  // Selected product being edited
  const selectedProduct = useMemo(() => {
    if (!editingProductId) return null;
    return products.find((p) => p.id === editingProductId) ?? null;
  }, [products, editingProductId]);

  const toggleExpand = (id: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ==========================================
  // Category Edit Draft State
  // ==========================================
  const getCategoryDraft = (cat: CatalogCategoryRecord | null) => {
    if (!cat) return { slug: "", isActive: false, translations: {} };
    const trans: Record<string, { name: string; description: string }> = {};
    for (const [code, t] of Object.entries(cat.translations)) {
      const transItem = t as { name?: string | null; description?: string | null };
      trans[code] = {
        name: transItem?.name ?? "",
        description: transItem?.description ?? "",
      };
    }
    return {
      slug: cat.slug,
      isActive: cat.isActive,
      translations: trans,
    };
  };

  const initialCatDraft = getCategoryDraft(initialCategories[0] ?? null);
  const [catDraftSlug, setCatDraftSlug] = useState(initialCatDraft.slug);
  const [catDraftIsActive, setCatDraftIsActive] = useState(initialCatDraft.isActive);
  const [catDraftTranslations, setCatDraftTranslations] = useState<
    Record<string, { name: string; description: string }>
  >(initialCatDraft.translations);

  // When selected category changes, initialize draft values
  const syncCategoryDraft = (node: HierarchyCategoryNode | CatalogCategoryRecord | null) => {
    if (!node) return;
    setCatDraftSlug(node.slug);
    setCatDraftIsActive(node.isActive);
    const trans: Record<string, { name: string; description: string }> = {};
    for (const [code, t] of Object.entries(node.translations)) {
      const transItem = t as { name?: string | null; description?: string | null };
      trans[code] = {
        name: transItem?.name ?? "",
        description: transItem?.description ?? "",
      };
    }
    setCatDraftTranslations(trans);
  };

  const handleSelectCategory = (node: HierarchyCategoryNode) => {
    setSelectedCategoryId(node.id);
    setEditingProductId(null);
    setIsActionEditorOpen(false);
    setActionFeedback(null);
    syncCategoryDraft(node);
  };

  // ==========================================
  // Product Edit Draft State
  // ==========================================
  const [prodDraftSlug, setProdDraftSlug] = useState("");
  const [prodDraftPrice, setProdDraftPrice] = useState("");
  const [prodDraftIsActive, setProdDraftIsActive] = useState(false);
  const [prodDraftTranslations, setProdDraftTranslations] = useState<
    Record<string, { name: string; description: string; details: string }>
  >({});

  const handleStartEditProduct = (prod: (typeof products)[0]) => {
    setEditingProductId(prod.id);
    setProdDraftSlug(prod.slug);
    setProdDraftPrice(prod.price);
    setProdDraftIsActive(prod.isActive);
    const trans: Record<string, { name: string; description: string; details: string }> = {};
    for (const [code, t] of Object.entries(prod.translations)) {
      trans[code] = {
        name: t.name ?? "",
        description: t.description ?? "",
        details: t.details ?? "",
      };
    }
    setProdDraftTranslations(trans);
    setActionFeedback(null);
  };

  // ==========================================
  // Create Category Form State
  // ==========================================
  const [newCatParentId, setNewCatParentId] = useState<string | null>(null);
  const [newCatSlug, setNewCatSlug] = useState("");
  const [newCatDefaultName, setNewCatDefaultName] = useState("");
  const [newCatDefaultDesc, setNewCatDefaultDesc] = useState("");
  const [newCatNameAr, setNewCatNameAr] = useState("");
  const [newCatDescAr, setNewCatDescAr] = useState("");
  const [newCatErrors, setNewCatErrors] = useState<Record<string, string>>({});

  const handleOpenCreateCategory = (parentId: string | null = null) => {
    setNewCatParentId(parentId);
    setNewCatSlug("");
    setNewCatDefaultName("");
    setNewCatDefaultDesc("");
    setNewCatNameAr("");
    setNewCatDescAr("");
    setNewCatErrors({});
    setIsCreateCategoryOpen(true);
  };

  const handleCreateCategorySubmit = () => {
    setNewCatErrors({});
    startTransition(async () => {
      try {
        const res = await createCategoryAction({
          parentId: newCatParentId,
          slug: newCatSlug,
          name: newCatDefaultName,
          description: newCatDefaultDesc,
          arabicName: defaultLangCode !== "ar" && newCatNameAr.trim() ? newCatNameAr : undefined,
          arabicDescription: defaultLangCode !== "ar" && newCatDescAr.trim() ? newCatDescAr : undefined,
        });

        if (!res.success) {
          if (res.errors) setNewCatErrors(res.errors);
          setActionFeedback(res);
          return;
        }

        const authoritativeCategory = res.category!;
        setCategories((prev) => [...prev, authoritativeCategory]);
        setSelectedCategoryId(authoritativeCategory.id);
        setExpandedNodeIds((prev) => new Set([...prev, authoritativeCategory.id]));
        syncCategoryDraft(authoritativeCategory);
        setIsCreateCategoryOpen(false);
        setActionFeedback({ success: true, message: "Category created successfully." });
      } catch {
        setActionFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your inputs have been preserved. Please try again.",
        });
      }
    });
  };

  // ==========================================
  // Save Category Edit
  // ==========================================
  const handleSaveCategory = () => {
    if (!selectedNode) return;
    const submittedLang = activeLangTab;
    startTransition(async () => {
      try {
        const activeTrans = catDraftTranslations[submittedLang] ?? { name: "", description: "" };
        const res = await updateCategoryAction({
          categoryId: selectedNode.id,
          slug: catDraftSlug,
          isActive: catDraftIsActive,
          languageCode: submittedLang,
          name: activeTrans.name,
          description: activeTrans.description,
        });

        setActionFeedback(res);

        if (res.success && res.category) {
          const authoritativeCategory = res.category;
          // Update authoritative saved record in category tree
          setCategories((prev) =>
            prev.map((c) => (c.id === authoritativeCategory.id ? authoritativeCategory : c)),
          );
          // Reconcile ONLY submitted fields and submitted language draft
          setCatDraftSlug(authoritativeCategory.slug);
          setCatDraftIsActive(authoritativeCategory.isActive);
          setCatDraftTranslations((prev) => {
            const savedTrans = authoritativeCategory.translations[submittedLang];
            return {
              ...prev,
              [submittedLang]: {
                name: savedTrans?.name ?? "",
                description: savedTrans?.description ?? "",
              },
            };
          });
        }
      } catch {
        setActionFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your changes have been preserved. Please try again.",
        });
      }
    });
  };

  // ==========================================
  // Create Product Form State
  // ==========================================
  const [newProdCatId, setNewProdCatId] = useState<string>("");
  const [newProdSlug, setNewProdSlug] = useState("");
  const [newProdPrice, setNewProdPrice] = useState("");
  const [newProdDefaultName, setNewProdDefaultName] = useState("");
  const [newProdDefaultDesc, setNewProdDefaultDesc] = useState("");
  const [newProdDefaultDetails, setNewProdDefaultDetails] = useState("");
  const [newProdNameAr, setNewProdNameAr] = useState("");
  const [newProdDescAr, setNewProdDescAr] = useState("");
  const [newProdDetailsAr, setNewProdDetailsAr] = useState("");
  const [newProdErrors, setNewProdErrors] = useState<Record<string, string>>({});

  const handleOpenCreateProduct = () => {
    setNewProdCatId(selectedCategoryId ?? (categories[0]?.id || ""));
    setNewProdSlug("");
    setNewProdPrice("");
    setNewProdDefaultName("");
    setNewProdDefaultDesc("");
    setNewProdDefaultDetails("");
    setNewProdNameAr("");
    setNewProdDescAr("");
    setNewProdDetailsAr("");
    setNewProdErrors({});
    setIsCreateProductOpen(true);
  };

  const handleCreateProductSubmit = () => {
    setNewProdErrors({});
    startTransition(async () => {
      try {
        const res = await createProductAction({
          categoryId: newProdCatId,
          slug: newProdSlug,
          price: newProdPrice,
          name: newProdDefaultName,
          description: newProdDefaultDesc,
          details: newProdDefaultDetails,
          arabicName: defaultLangCode !== "ar" && newProdNameAr.trim() ? newProdNameAr : undefined,
          arabicDescription: defaultLangCode !== "ar" && newProdDescAr.trim() ? newProdDescAr : undefined,
          arabicDetails: defaultLangCode !== "ar" && newProdDetailsAr.trim() ? newProdDetailsAr : undefined,
        });

        if (!res.success) {
          if (res.errors) setNewProdErrors(res.errors);
          setActionFeedback(res);
          return;
        }

        const authoritativeProduct = res.product!;
        setProducts((prev) => [...prev, authoritativeProduct]);
        setIsCreateProductOpen(false);
        setActionFeedback({ success: true, message: "Product created successfully." });
      } catch {
        setActionFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your inputs have been preserved. Please try again.",
        });
      }
    });
  };

  // ==========================================
  // Save Product Edit
  // ==========================================
  const handleSaveProduct = () => {
    if (!selectedProduct) return;
    const submittedLang = activeLangTab;
    startTransition(async () => {
      try {
        const activeTrans = prodDraftTranslations[submittedLang] ?? {
          name: "",
          description: "",
          details: "",
        };

        const res = await updateProductAction({
          productId: selectedProduct.id,
          slug: prodDraftSlug,
          price: prodDraftPrice,
          isActive: prodDraftIsActive,
          languageCode: submittedLang,
          name: activeTrans.name,
          description: activeTrans.description,
          details: activeTrans.details,
        });

        setActionFeedback(res);

        if (res.success && res.product) {
          const authoritativeProduct = res.product;
          // Update authoritative saved record in products list
          setProducts((prev) =>
            prev.map((p) => (p.id === authoritativeProduct.id ? authoritativeProduct : p)),
          );
          // Reconcile ONLY submitted fields and submitted language draft
          setProdDraftSlug(authoritativeProduct.slug);
          setProdDraftPrice(authoritativeProduct.price);
          setProdDraftIsActive(authoritativeProduct.isActive);
          setProdDraftTranslations((prev) => {
            const savedTrans = authoritativeProduct.translations[submittedLang];
            return {
              ...prev,
              [submittedLang]: {
                name: savedTrans?.name ?? "",
                description: savedTrans?.description ?? "",
                details: savedTrans?.details ?? "",
              },
            };
          });
        }
      } catch {
        setActionFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your changes have been preserved. Please try again.",
        });
      }
    });
  };

  // Render Category Node in Tree View
  const renderCategoryNode = (node: HierarchyCategoryNode) => {
    const isSelected = node.id === selectedCategoryId;
    const isExpanded = expandedNodeIds.has(node.id);
    const hasChildren = node.children.length > 0;
    const paddingLeft = `${Math.min(node.depth * 0.75 + 0.25, 2)}rem`;

    return (
      <div key={node.id} className="space-y-1 w-full min-w-0 max-w-full">
        <div
          data-testid="category-node"
          data-category-id={node.id}
          data-category-slug={node.slug}
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
                aria-label={isExpanded ? "Collapse" : "Expand"}
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
              onClick={() => handleSelectCategory(node)}
              className="flex min-w-0 min-h-11 flex-1 items-center gap-2 text-left py-2"
            >
              <Folder className="size-4 shrink-0 text-primary/70" />
              <span className="truncate text-sm font-medium">
                {node.translations[activeLangTab]?.name ||
                  node.translations.en?.name ||
                  node.slug}
              </span>
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 ml-auto sm:ml-0">
            {node.effectiveVisibility ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 text-xs">
                Active
              </Badge>
            ) : node.isActive && node.hasInactiveAncestor ? (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 text-xs">
                Active (Hidden)
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground text-xs">
                Inactive
              </Badge>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => handleOpenCreateCategory(node.id)}
              className="size-11 text-muted-foreground hover:text-foreground"
              title="Add child category"
              aria-label={`Add child to ${node.slug}`}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>

        {hasChildren && isExpanded && (
          <div className="space-y-1 w-full min-w-0 max-w-full">
            {node.children.map((child) => renderCategoryNode(child))}
          </div>
        )}
      </div>
    );
  };

  if (isActionEditorOpen && selectedProduct) {
    return (
      <div className="space-y-8" data-testid="catalog-editor">
        <PageHeader
          title="Catalog"
          description="Digital products, categories, displayed prices and customer navigation."
        />
        <ProductActionEditor
          product={selectedProduct}
          categoryBreadcrumb={selectedNode?.breadcrumb ?? ""}
          isProductActive={selectedProduct.isActive}
          isCategoryActive={selectedNode?.effectiveVisibility ?? true}
          defaultLanguage={defaultLanguage}
          languages={languages}
          onClose={handleCloseActionEditor}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="catalog-editor">
      <PageHeader
        title="Catalog"
        description="Digital products, categories, displayed prices and customer navigation."
      />

      {/* Action feedback alert */}
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

      {/* Global Toolbar / Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="gap-1.5 py-1 text-xs font-normal">
            <Tag className="size-3 text-muted-foreground" />
            <span>Store Currency:</span>
            <strong className="font-semibold text-foreground">{settings.currency}</strong>
          </Badge>

          <Badge variant="outline" className="gap-1.5 py-1 text-xs font-normal">
            <Globe className="size-3 text-muted-foreground" />
            <span>Default Language:</span>
            <strong className="font-semibold text-foreground">{defaultLangLabel}</strong>
          </Badge>

          <span className="text-xs text-muted-foreground">
            {categories.length} {categories.length === 1 ? "category" : "categories"} •{" "}
            {products.length} {products.length === 1 ? "product" : "products"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {arabicRegistered && (
            <div className="flex rounded-lg border p-1 bg-muted/30">
              <button
                type="button"
                onClick={() => setActiveLangTab("en")}
                className={`min-h-11 min-w-11 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  activeLangTab === "en" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground"
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => setActiveLangTab("ar")}
                className={`min-h-11 min-w-11 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  activeLangTab === "ar" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground"
                }`}
              >
                العربية (AR)
              </button>
            </div>
          )}

          <Button
            type="button"
            onClick={() => handleOpenCreateCategory(null)}
            className="min-h-11 gap-2"
            data-testid="create-category-btn"
          >
            <FolderPlus className="size-4" />
            <span>New Category</span>
          </Button>
        </div>
      </div>

      {/* Main Grid: Category Tree (Left) + Selected Category Details & Products (Right) */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Categories Hierarchy */}
        <div className="lg:col-span-5 space-y-4">
          <Card>
            <CardHeader className="p-4 pb-2 flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base font-semibold">Categories</CardTitle>
                <CardDescription className="text-xs">
                  Hierarchical category tree
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleOpenCreateCategory(null)}
                className="min-h-11 gap-1.5 text-xs"
              >
                <Plus className="size-3.5" />
                <span>Root</span>
              </Button>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              {tree.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <Folder className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">No categories created yet</p>
                    <p className="text-xs text-muted-foreground">
                      Create your first root category to start building your catalog.
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={() => handleOpenCreateCategory(null)}
                    className="min-h-11 text-xs"
                  >
                    Create Root Category
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">{tree.map((root) => renderCategoryNode(root))}</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Selected Category Details & Products */}
        <div className="lg:col-span-7 space-y-6">
          {selectedNode ? (
            <>
              {/* Category Edit Card */}
              <Card>
                <CardHeader className="p-5 pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg font-semibold truncate">
                          {selectedNode.translations[activeLangTab]?.name ||
                            selectedNode.translations.en?.name ||
                            selectedNode.slug}
                        </CardTitle>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {selectedNode.slug}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate" title={selectedNode.breadcrumb}>
                        Path: {selectedNode.breadcrumb}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        onClick={handleSaveCategory}
                        disabled={isPending}
                        className="min-h-11 gap-2"
                        data-testid="save-category-btn"
                      >
                        {isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Save className="size-4" />
                        )}
                        <span>Save Category</span>
                      </Button>
                    </div>
                  </div>

                  {/* Inactive Ancestor Warning Banner */}
                  {selectedNode.isActive && selectedNode.hasInactiveAncestor && (
                    <div
                      data-testid="inactive-ancestor-notice"
                      role="alert"
                      className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
                    >
                      <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                      <div>
                        <p className="font-semibold">Inactive Ancestor Warning</p>
                        <p>
                          Parent category &quot;{selectedNode.inactiveAncestorName}&quot; is currently inactive.
                          Even though this category is marked active, customers will not see it until all parent
                          categories are activated.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Disabled Arabic banner */}
                  {activeLangTab === "ar" && arabicDisabled && (
                    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-800 dark:text-blue-300">
                      <Info className="size-4 shrink-0 text-blue-600 mt-0.5" />
                      <p>
                        Arabic is registered but currently disabled store-wide. You can edit and save content
                        here without enabling it for customers.
                      </p>
                    </div>
                  )}
                </CardHeader>

                <CardContent className="p-5 pt-0 space-y-4">
                  {/* Language & Translation Status Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                    <div className="flex rounded-md border bg-muted/20 p-1">
                      <button
                        type="button"
                        onClick={() => setActiveLangTab("en")}
                        className={`min-h-11 min-w-11 px-3 py-1 text-xs font-medium rounded ${
                          activeLangTab === "en" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        English
                      </button>
                      {arabicRegistered && (
                        <button
                          type="button"
                          onClick={() => setActiveLangTab("ar")}
                          className={`min-h-11 min-w-11 px-3 py-1 text-xs font-medium rounded ${
                            activeLangTab === "ar" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          العربية (AR)
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {(() => {
                        const status = resolveCatalogTranslationStatus({
                          currentLang: activeLangTab,
                          savedTranslations: selectedNode.translations,
                          defaultLanguageCode: defaultLangCode,
                          defaultLanguageLabel: defaultLangLabel,
                        });
                        return (
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              status.isSaved
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-700"
                            }`}
                          >
                            {status.label}
                          </Badge>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Form fields */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label htmlFor="cat-slug-input" className="text-xs font-medium">
                        Category Slug
                      </label>
                      <input
                        id="cat-slug-input"
                        type="text"
                        disabled={isPending}
                        value={catDraftSlug}
                        onChange={(e) => setCatDraftSlug(e.target.value)}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                        placeholder="e.g. electronics"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Unique URL/key identifier (letters, numbers, hyphens, periods).
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-xs font-medium">Customer Visibility State</span>
                      <div className="flex items-center gap-3 pt-2">
                        <input
                          id="cat-status-input"
                          type="checkbox"
                          disabled={isPending}
                          checked={catDraftIsActive}
                          onChange={(e) => setCatDraftIsActive(e.target.checked)}
                          onClick={(e) => setCatDraftIsActive(e.currentTarget.checked)}
                          className="size-4 rounded border-gray-300 text-primary cursor-pointer"
                        />
                        <label
                          htmlFor="cat-status-input"
                          className="flex items-center text-sm cursor-pointer select-none min-h-11"
                        >
                          Category is Active
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Localized Content for active tab */}
                  <div
                    className="space-y-3 pt-2"
                    dir={activeLangTab === "ar" ? "rtl" : "ltr"}
                  >
                    <div className="space-y-1.5">
                      <label htmlFor="cat-name-input" className="text-xs font-medium">
                        Category Name ({activeLangTab.toUpperCase()}){" "}
                        {activeLangTab === defaultLangCode && <span className="text-destructive">*</span>}
                      </label>
                      <input
                        id="cat-name-input"
                        type="text"
                        disabled={isPending}
                        value={catDraftTranslations[activeLangTab]?.name ?? ""}
                        onChange={(e) =>
                          setCatDraftTranslations((prev) => ({
                            ...prev,
                            [activeLangTab]: {
                              name: e.target.value,
                              description: prev[activeLangTab]?.description ?? "",
                            },
                          }))
                        }
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                        placeholder={
                          activeLangTab === "ar" ? "اسم الفئة بالعربية" : "Category name in English"
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="cat-desc-input" className="text-xs font-medium">
                        Description ({activeLangTab.toUpperCase()})
                      </label>
                      <textarea
                        id="cat-desc-input"
                        rows={2}
                        disabled={isPending}
                        value={catDraftTranslations[activeLangTab]?.description ?? ""}
                        onChange={(e) =>
                          setCatDraftTranslations((prev) => ({
                            ...prev,
                            [activeLangTab]: {
                              name: prev[activeLangTab]?.name ?? "",
                              description: e.target.value,
                            },
                          }))
                        }
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                        placeholder="Optional short description..."
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Products in this category */}
              <Card>
                <CardHeader className="p-4 pb-2 flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      Products in {selectedNode.translations[activeLangTab]?.name || selectedNode.slug}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {categoryProducts.length} {categoryProducts.length === 1 ? "product" : "products"} listed
                    </CardDescription>
                  </div>

                  <Button
                    type="button"
                    onClick={handleOpenCreateProduct}
                    className="min-h-11 gap-1.5 text-xs"
                    data-testid="create-product-btn"
                  >
                    <PackagePlus className="size-3.5" />
                    <span>New Product</span>
                  </Button>
                </CardHeader>

                <CardContent className="p-4 pt-2">
                  {categoryProducts.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                        <Package className="size-5" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">No products in this category</p>
                        <p className="text-xs text-muted-foreground">
                          Add digital goods or services with displayed prices.
                        </p>
                      </div>
                      <Button
                        type="button"
                        onClick={handleOpenCreateProduct}
                        className="min-h-11 text-xs"
                      >
                        Create Product
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {categoryProducts.map((prod) => (
                        <div
                          key={prod.id}
                          data-testid="product-card"
                          data-product-id={prod.id}
                          data-product-slug={prod.slug}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 hover:bg-muted/30 transition-colors"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">
                                {prod.translations[activeLangTab]?.name ||
                                  prod.translations.en?.name ||
                                  prod.slug}
                              </span>
                              <Badge variant="secondary" className="font-mono text-xs">
                                {prod.slug}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="font-semibold text-foreground">
                                {settings.currency} {prod.price}
                              </span>
                              <span>•</span>
                              <span>
                                {prod.isActive && selectedNode.effectiveVisibility ? (
                                  <span className="text-emerald-700">Active</span>
                                ) : prod.isActive ? (
                                  <span className="text-amber-700">Active (Hidden by category)</span>
                                ) : (
                                  <span>Inactive</span>
                                )}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenActionEditor(prod.id)}
                              className="min-h-11 text-xs gap-1.5"
                              data-testid={`product-buttons-btn-${prod.slug}`}
                              title="Configure Buttons"
                            >
                              <FolderTree className="size-3.5 text-muted-foreground" />
                              <span>Buttons</span>
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => handleStartEditProduct(prod)}
                              className="min-h-11 text-xs"
                            >
                              Edit
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Product Edit Card if a product is selected */}
              {selectedProduct && (
                <Card className="border-primary/40 bg-card">
                  <CardHeader className="p-4 pb-2 flex-row items-center justify-between space-y-0">
                    <div className="space-y-1">
                      <CardTitle className="text-base font-semibold">
                        Edit Product: {selectedProduct.slug}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Category: {selectedNode.breadcrumb}
                      </CardDescription>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleOpenActionEditor(selectedProduct.id)}
                        className="min-h-11 text-xs gap-1.5"
                        data-testid="open-product-actions-btn"
                      >
                        <FolderTree className="size-3.5" />
                        <span>Buttons</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditingProductId(null)}
                        className="size-11"
                        aria-label="Close product editor"
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </CardHeader>

                  <CardContent className="p-4 space-y-4">
                    {/* Inactive category warning */}
                    {!selectedNode.effectiveVisibility && selectedProduct.isActive && (
                      <div
                        role="alert"
                        className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
                      >
                        <AlertTriangle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                        <p>
                          Category &quot;{selectedNode.slug}&quot; or an ancestor is inactive. Customers
                          cannot view this product until all parent categories are active.
                        </p>
                      </div>
                    )}

                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <label htmlFor="prod-slug-input" className="text-xs font-medium">
                          Product Slug
                        </label>
                        <input
                          id="prod-slug-input"
                          type="text"
                          disabled={isPending}
                          value={prodDraftSlug}
                          onChange={(e) => setProdDraftSlug(e.target.value)}
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                          placeholder="e.g. iphone-15"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label htmlFor="prod-price-input" className="text-xs font-medium">
                          Displayed Price ({settings.currency})
                        </label>
                        <input
                          id="prod-price-input"
                          data-testid="price-input"
                          type="text"
                          disabled={isPending}
                          value={prodDraftPrice}
                          onChange={(e) => setProdDraftPrice(e.target.value)}
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                          placeholder="0.00"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Exact quote shown in Telegram. Zero is valid.
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <span className="text-xs font-medium">Active State</span>
                        <div className="flex items-center gap-2 pt-2">
                          <input
                            id="prod-status-input"
                            type="checkbox"
                            disabled={isPending}
                            checked={prodDraftIsActive}
                            onChange={(e) => setProdDraftIsActive(e.target.checked)}
                            onClick={(e) => setProdDraftIsActive(e.currentTarget.checked)}
                            className="size-4 rounded border-gray-300 text-primary cursor-pointer"
                          />
                          <label
                            htmlFor="prod-status-input"
                            className="flex items-center text-sm cursor-pointer select-none min-h-11"
                          >
                            Product is Active
                          </label>
                        </div>
                      </div>
                    </div>

                    {/* Localized fields */}
                    <div
                      className="space-y-3 pt-2"
                      dir={activeLangTab === "ar" ? "rtl" : "ltr"}
                    >
                      <div className="space-y-1.5">
                        <label htmlFor="prod-name-input" className="text-xs font-medium">
                          Product Name ({activeLangTab.toUpperCase()}){" "}
                          {activeLangTab === defaultLangCode && <span className="text-destructive">*</span>}
                        </label>
                        <input
                          id="prod-name-input"
                          type="text"
                          disabled={isPending}
                          value={prodDraftTranslations[activeLangTab]?.name ?? ""}
                          onChange={(e) =>
                            setProdDraftTranslations((prev) => ({
                              ...prev,
                              [activeLangTab]: {
                                name: e.target.value,
                                description: prev[activeLangTab]?.description ?? "",
                                details: prev[activeLangTab]?.details ?? "",
                              },
                            }))
                          }
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                          placeholder="Product Name"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label htmlFor="prod-desc-input" className="text-xs font-medium">
                          Short Description ({activeLangTab.toUpperCase()})
                        </label>
                        <input
                          id="prod-desc-input"
                          type="text"
                          disabled={isPending}
                          value={prodDraftTranslations[activeLangTab]?.description ?? ""}
                          onChange={(e) =>
                            setProdDraftTranslations((prev) => ({
                              ...prev,
                              [activeLangTab]: {
                                name: prev[activeLangTab]?.name ?? "",
                                description: e.target.value,
                                details: prev[activeLangTab]?.details ?? "",
                              },
                            }))
                          }
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                          placeholder="Short summary for card"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label htmlFor="prod-details-input" className="text-xs font-medium">
                          Details ({activeLangTab.toUpperCase()})
                        </label>
                        <textarea
                          id="prod-details-input"
                          rows={3}
                          disabled={isPending}
                          value={prodDraftTranslations[activeLangTab]?.details ?? ""}
                          onChange={(e) =>
                            setProdDraftTranslations((prev) => ({
                              ...prev,
                              [activeLangTab]: {
                                name: prev[activeLangTab]?.name ?? "",
                                description: prev[activeLangTab]?.description ?? "",
                                details: e.target.value,
                              },
                            }))
                          }
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                          placeholder="Full product details revealed on tap"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => handleOpenActionEditor(selectedProduct.id)}
                        className="min-h-11 text-xs gap-1.5"
                        data-testid="edit-product-open-actions-btn"
                      >
                        <FolderTree className="size-3.5" />
                        <span>Configure Buttons</span>
                      </Button>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setEditingProductId(null)}
                          className="min-h-11"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          onClick={handleSaveProduct}
                          disabled={isPending}
                          className="min-h-11 gap-2"
                          data-testid="save-product-btn"
                        >
                          {isPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Save className="size-4" />
                          )}
                          <span>Save Product</span>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center p-8 text-center space-y-3">
                <Folder className="size-10 text-muted-foreground" />
                <p className="text-sm font-medium">Select a category to view details and products</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* Create Category Dialog */}
      {/* ========================================================================= */}
      {isCreateCategoryOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h2 className="text-lg font-semibold">Create Category</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setIsCreateCategoryOpen(false)}
                className="size-11"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="space-y-4">
              {/* Parent category selector */}
              <div className="space-y-1.5">
                <label htmlFor="create-cat-parent" className="text-xs font-medium">
                  Parent Category
                </label>
                <select
                  id="create-cat-parent"
                  value={newCatParentId ?? "root"}
                  onChange={(e) =>
                    setNewCatParentId(e.target.value === "root" ? null : e.target.value)
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                >
                  <option value="root">None (Root category)</option>
                  {flattened.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.breadcrumb} ({c.slug})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Parent is selected during creation. Reparenting existing categories is deferred.
                </p>
              </div>

              {/* Slug */}
              <div className="space-y-1.5">
                <label htmlFor="create-cat-slug" className="text-xs font-medium">
                  Slug <span className="text-destructive">*</span>
                </label>
                <input
                  id="create-cat-slug"
                  data-testid="create-category-slug"
                  type="text"
                  value={newCatSlug}
                  onChange={(e) => setNewCatSlug(e.target.value)}
                  className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                    newCatErrors.slug ? "border-destructive" : ""
                  }`}
                  placeholder="e.g. electronics"
                />
                {newCatErrors.slug && (
                  <p className="text-xs text-destructive">{newCatErrors.slug}</p>
                )}
              </div>

              {/* Default Language content */}
              <div
                className="space-y-3 rounded-xl border p-4 bg-muted/20"
                dir={defaultLangDir}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Language ({defaultLangLabel})
                </h3>
                <div className="space-y-1.5">
                  <label htmlFor="create-cat-name-default" className="text-xs font-medium">
                    Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-cat-name-default"
                    data-testid="create-category-name"
                    type="text"
                    value={newCatDefaultName}
                    onChange={(e) => setNewCatDefaultName(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newCatErrors.name ? "border-destructive" : ""
                    }`}
                    placeholder={defaultLangCode === "ar" ? "اسم الفئة" : "Category Name"}
                  />
                  {newCatErrors.name && (
                    <p className="text-xs text-destructive">{newCatErrors.name}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-cat-desc-default" className="text-xs font-medium">
                    Description
                  </label>
                  <textarea
                    id="create-cat-desc-default"
                    rows={2}
                    value={newCatDefaultDesc}
                    onChange={(e) => setNewCatDefaultDesc(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder={
                      defaultLangCode === "ar" ? "وصف اختياري..." : "Optional short description..."
                    }
                  />
                </div>
              </div>

              {/* Optional Arabic (only when Arabic is registered AND not the default language) */}
              {arabicRegistered && defaultLangCode !== "ar" && (
                <div className="space-y-3 rounded-xl border p-4 bg-muted/20" dir="rtl">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    العربية (اختياري)
                  </h3>
                  <div className="space-y-1.5">
                    <label htmlFor="create-cat-name-ar" className="text-xs font-medium">
                      الاسم بالعربية
                    </label>
                    <input
                      id="create-cat-name-ar"
                      type="text"
                      value={newCatNameAr}
                      onChange={(e) => setNewCatNameAr(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="اسم الفئة"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-cat-desc-ar" className="text-xs font-medium">
                      الوصف بالعربية
                    </label>
                    <textarea
                      id="create-cat-desc-ar"
                      rows={2}
                      value={newCatDescAr}
                      onChange={(e) => setNewCatDescAr(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="وصف اختياري..."
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateCategoryOpen(false)}
                className="min-h-11"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCreateCategorySubmit}
                disabled={isPending}
                className="min-h-11 gap-2"
                data-testid="submit-create-category-btn"
              >
                {isPending && <Loader2 className="size-4 animate-spin" />}
                <span>Create Category</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* Create Product Dialog */}
      {/* ========================================================================= */}
      {isCreateProductOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h2 className="text-lg font-semibold">Create Product</h2>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setIsCreateProductOpen(false)}
                className="size-11"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="space-y-4">
              {/* Category selector */}
              <div className="space-y-1.5">
                <label htmlFor="create-prod-cat" className="text-xs font-medium">
                  Category
                </label>
                <select
                  id="create-prod-cat"
                  value={newProdCatId}
                  onChange={(e) => setNewProdCatId(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                >
                  {flattened.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.breadcrumb} ({c.slug})
                    </option>
                  ))}
                </select>
              </div>

              {/* Slug & Displayed Price */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="create-prod-slug" className="text-xs font-medium">
                    Slug <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-prod-slug"
                    data-testid="create-product-slug"
                    type="text"
                    value={newProdSlug}
                    onChange={(e) => setNewProdSlug(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newProdErrors.slug ? "border-destructive" : ""
                    }`}
                    placeholder="e.g. iphone-15"
                  />
                  {newProdErrors.slug && (
                    <p className="text-xs text-destructive">{newProdErrors.slug}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-prod-price" className="text-xs font-medium">
                    Displayed Price ({settings.currency}) <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-prod-price"
                    data-testid="create-product-price"
                    type="text"
                    value={newProdPrice}
                    onChange={(e) => setNewProdPrice(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newProdErrors.price ? "border-destructive" : ""
                    }`}
                    placeholder="0.00"
                  />
                  {newProdErrors.price && (
                    <p className="text-xs text-destructive">{newProdErrors.price}</p>
                  )}
                </div>
              </div>

              {/* Default Language content */}
              <div
                className="space-y-3 rounded-xl border p-4 bg-muted/20"
                dir={defaultLangDir}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Language ({defaultLangLabel})
                </h3>
                <div className="space-y-1.5">
                  <label htmlFor="create-prod-name-default" className="text-xs font-medium">
                    Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-prod-name-default"
                    data-testid="create-product-name"
                    type="text"
                    value={newProdDefaultName}
                    onChange={(e) => setNewProdDefaultName(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newProdErrors.name ? "border-destructive" : ""
                    }`}
                    placeholder={defaultLangCode === "ar" ? "اسم المنتج" : "Product Name"}
                  />
                  {newProdErrors.name && (
                    <p className="text-xs text-destructive">{newProdErrors.name}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-prod-desc-default" className="text-xs font-medium">
                    Short Description
                  </label>
                  <input
                    id="create-prod-desc-default"
                    type="text"
                    value={newProdDefaultDesc}
                    onChange={(e) => setNewProdDefaultDesc(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder={
                      defaultLangCode === "ar" ? "وصف مختصر..." : "Short summary for card"
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-prod-details-default" className="text-xs font-medium">
                    Details
                  </label>
                  <textarea
                    id="create-prod-details-default"
                    rows={2}
                    value={newProdDefaultDetails}
                    onChange={(e) => setNewProdDefaultDetails(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder={
                      defaultLangCode === "ar" ? "تفاصيل المنتج..." : "Full product details..."
                    }
                  />
                </div>
              </div>

              {/* Optional Arabic content (only when Arabic is registered AND not the default language) */}
              {arabicRegistered && defaultLangCode !== "ar" && (
                <div className="space-y-3 rounded-xl border p-4 bg-muted/20" dir="rtl">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    العربية (اختياري)
                  </h3>
                  <div className="space-y-1.5">
                    <label htmlFor="create-prod-name-ar" className="text-xs font-medium">
                      الاسم بالعربية
                    </label>
                    <input
                      id="create-prod-name-ar"
                      type="text"
                      value={newProdNameAr}
                      onChange={(e) => setNewProdNameAr(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="اسم المنتج"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-prod-desc-ar" className="text-xs font-medium">
                      الوصف القصير بالعربية
                    </label>
                    <input
                      id="create-prod-desc-ar"
                      type="text"
                      value={newProdDescAr}
                      onChange={(e) => setNewProdDescAr(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="وصف مختصر..."
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="create-prod-details-ar" className="text-xs font-medium">
                      التفاصيل بالعربية
                    </label>
                    <textarea
                      id="create-prod-details-ar"
                      rows={2}
                      value={newProdDetailsAr}
                      onChange={(e) => setNewProdDetailsAr(e.target.value)}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                      placeholder="تفاصيل المنتج بالعربية..."
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsCreateProductOpen(false)}
                className="min-h-11"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCreateProductSubmit}
                disabled={isPending}
                className="min-h-11 gap-2"
                data-testid="submit-create-product-btn"
              >
                {isPending && <Loader2 className="size-4 animate-spin" />}
                <span>Create Product</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
