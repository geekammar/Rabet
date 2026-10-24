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
import type { CatalogViewData } from "./types";

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

  // Active language tab in editors (defaults to 'en')
  const [activeLangTab, setActiveLangTab] = useState<string>("en");

  // Dialog / Modal states
  const [isCreateCategoryOpen, setIsCreateCategoryOpen] = useState(false);

  const [isCreateProductOpen, setIsCreateProductOpen] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

  // Pending transition for action executions
  const [isPending, startTransition] = useTransition();

  // Feedback states
  const [actionFeedback, setActionFeedback] = useState<CatalogActionResult | null>(null);

  // Languages metadata
  const arabicRegistered = languages.some((l) => l.code === "ar");
  const arabicRow = languages.find((l) => l.code === "ar");
  const arabicDisabled = arabicRow ? !arabicRow.isEnabled : false;
  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel = defaultLanguage?.label ?? "English";

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
  const [catDraftSlug, setCatDraftSlug] = useState("");
  const [catDraftIsActive, setCatDraftIsActive] = useState(false);
  const [catDraftTranslations, setCatDraftTranslations] = useState<
    Record<string, { name: string; description: string }>
  >({});

  // When selected category changes, initialize draft values
  const syncCategoryDraft = (node: HierarchyCategoryNode | null) => {
    if (!node) return;
    setCatDraftSlug(node.slug);
    setCatDraftIsActive(node.isActive);
    const trans: Record<string, { name: string; description: string }> = {};
    for (const [code, t] of Object.entries(node.translations)) {
      trans[code] = {
        name: t.name ?? "",
        description: t.description ?? "",
      };
    }
    setCatDraftTranslations(trans);
    setActionFeedback(null);
  };

  const handleSelectCategory = (node: HierarchyCategoryNode) => {
    setSelectedCategoryId(node.id);
    setEditingProductId(null);
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
  const [newCatNameEn, setNewCatNameEn] = useState("");
  const [newCatDescEn, setNewCatDescEn] = useState("");
  const [newCatNameAr, setNewCatNameAr] = useState("");
  const [newCatDescAr, setNewCatDescAr] = useState("");
  const [newCatErrors, setNewCatErrors] = useState<Record<string, string>>({});

  const handleOpenCreateCategory = (parentId: string | null = null) => {
    setNewCatParentId(parentId);
    setNewCatSlug("");
    setNewCatNameEn("");
    setNewCatDescEn("");
    setNewCatNameAr("");
    setNewCatDescAr("");
    setNewCatErrors({});
    setIsCreateCategoryOpen(true);
  };

  const handleCreateCategorySubmit = () => {
    setNewCatErrors({});
    startTransition(async () => {
      const res = await createCategoryAction({
        parentId: newCatParentId,
        slug: newCatSlug,
        name: newCatNameEn,
        description: newCatDescEn,
        arabicName: newCatNameAr,
        arabicDescription: newCatDescAr,
      });

      if (!res.success) {
        if (res.errors) setNewCatErrors(res.errors);
        setActionFeedback(res);
        return;
      }

      // Add to local categories state
      const newCatId = res.categoryId!;
      const newCatRecord = {
        id: newCatId,
        parentId: newCatParentId,
        slug: newCatSlug.toLowerCase().trim(),
        sortOrder: categories.length,
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          en: {
            id: `trans-${newCatId}-en`,
            languageId: "lang-en",
            name: newCatNameEn.trim(),
            description: newCatDescEn.trim() || null,
          },
          ...(newCatNameAr.trim()
            ? {
                ar: {
                  id: `trans-${newCatId}-ar`,
                  languageId: "lang-ar",
                  name: newCatNameAr.trim(),
                  description: newCatDescAr.trim() || null,
                },
              }
            : {}),
        },
      };

      setCategories((prev) => [...prev, newCatRecord]);
      setSelectedCategoryId(newCatId);
      setExpandedNodeIds((prev) => new Set([...prev, newCatId]));
      setIsCreateCategoryOpen(false);
      setActionFeedback({ success: true, message: "Category created successfully." });
    });
  };

  // ==========================================
  // Save Category Edit
  // ==========================================
  const handleSaveCategory = () => {
    if (!selectedNode) return;
    startTransition(async () => {
      const activeTrans = catDraftTranslations[activeLangTab] ?? { name: "", description: "" };
      const res = await updateCategoryAction({
        categoryId: selectedNode.id,
        slug: catDraftSlug,
        isActive: catDraftIsActive,
        languageCode: activeLangTab,
        name: activeTrans.name,
        description: activeTrans.description,
      });

      setActionFeedback(res);

      if (res.success) {
        setCategories((prev) =>
          prev.map((c) => {
            if (c.id !== selectedNode.id) return c;
            const existingTrans = { ...c.translations };
            if (activeTrans.name.trim()) {
              existingTrans[activeLangTab] = {
                id: existingTrans[activeLangTab]?.id ?? `trans-${c.id}-${activeLangTab}`,
                languageId: `lang-${activeLangTab}`,
                name: activeTrans.name.trim(),
                description: activeTrans.description.trim() || null,
              };
            }
            return {
              ...c,
              slug: catDraftSlug.toLowerCase().trim(),
              isActive: catDraftIsActive,
              translations: existingTrans,
              updatedAt: new Date(),
            };
          }),
        );
      }
    });
  };

  // ==========================================
  // Create Product Form State
  // ==========================================
  const [newProdCatId, setNewProdCatId] = useState<string>("");
  const [newProdSlug, setNewProdSlug] = useState("");
  const [newProdPrice, setNewProdPrice] = useState("");
  const [newProdNameEn, setNewProdNameEn] = useState("");
  const [newProdDescEn, setNewProdDescEn] = useState("");
  const [newProdDetailsEn, setNewProdDetailsEn] = useState("");
  const [newProdNameAr, setNewProdNameAr] = useState("");
  const [newProdDescAr, setNewProdDescAr] = useState("");
  const [newProdDetailsAr, setNewProdDetailsAr] = useState("");
  const [newProdErrors, setNewProdErrors] = useState<Record<string, string>>({});

  const handleOpenCreateProduct = () => {
    setNewProdCatId(selectedCategoryId ?? (categories[0]?.id || ""));
    setNewProdSlug("");
    setNewProdPrice("");
    setNewProdNameEn("");
    setNewProdDescEn("");
    setNewProdDetailsEn("");
    setNewProdNameAr("");
    setNewProdDescAr("");
    setNewProdDetailsAr("");
    setNewProdErrors({});
    setIsCreateProductOpen(true);
  };

  const handleCreateProductSubmit = () => {
    setNewProdErrors({});
    startTransition(async () => {
      const res = await createProductAction({
        categoryId: newProdCatId,
        slug: newProdSlug,
        price: newProdPrice,
        name: newProdNameEn,
        description: newProdDescEn,
        details: newProdDetailsEn,
        arabicName: newProdNameAr,
        arabicDescription: newProdDescAr,
        arabicDetails: newProdDetailsAr,
      });

      if (!res.success) {
        if (res.errors) setNewProdErrors(res.errors);
        setActionFeedback(res);
        return;
      }

      const newProdId = res.productId!;
      const newProdRecord = {
        id: newProdId,
        categoryId: newProdCatId,
        slug: newProdSlug.toLowerCase().trim(),
        price: newProdPrice.includes(".") ? newProdPrice : `${newProdPrice}.00`,
        isActive: false,
        sortOrder: products.length,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {
          en: {
            id: `trans-${newProdId}-en`,
            languageId: "lang-en",
            name: newProdNameEn.trim(),
            description: newProdDescEn.trim() || null,
            details: newProdDetailsEn.trim() || null,
          },
          ...(newProdNameAr.trim()
            ? {
                ar: {
                  id: `trans-${newProdId}-ar`,
                  languageId: "lang-ar",
                  name: newProdNameAr.trim(),
                  description: newProdDescAr.trim() || null,
                  details: newProdDetailsAr.trim() || null,
                },
              }
            : {}),
        },
      };

      setProducts((prev) => [...prev, newProdRecord]);
      setIsCreateProductOpen(false);
      setActionFeedback({ success: true, message: "Product created successfully." });
    });
  };

  // ==========================================
  // Save Product Edit
  // ==========================================
  const handleSaveProduct = () => {
    if (!selectedProduct) return;
    startTransition(async () => {
      const activeTrans = prodDraftTranslations[activeLangTab] ?? {
        name: "",
        description: "",
        details: "",
      };

      const res = await updateProductAction({
        productId: selectedProduct.id,
        slug: prodDraftSlug,
        price: prodDraftPrice,
        isActive: prodDraftIsActive,
        languageCode: activeLangTab,
        name: activeTrans.name,
        description: activeTrans.description,
        details: activeTrans.details,
      });

      setActionFeedback(res);

      if (res.success) {
        setProducts((prev) =>
          prev.map((p) => {
            if (p.id !== selectedProduct.id) return p;
            const existingTrans = { ...p.translations };
            if (activeTrans.name.trim()) {
              existingTrans[activeLangTab] = {
                id: existingTrans[activeLangTab]?.id ?? `trans-${p.id}-${activeLangTab}`,
                languageId: `lang-${activeLangTab}`,
                name: activeTrans.name.trim(),
                description: activeTrans.description.trim() || null,
                details: activeTrans.details.trim() || null,
              };
            }
            return {
              ...p,
              slug: prodDraftSlug.toLowerCase().trim(),
              price: prodDraftPrice,
              isActive: prodDraftIsActive,
              translations: existingTrans,
              updatedAt: new Date(),
            };
          }),
        );
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
                      <label htmlFor="cat-status-input" className="text-xs font-medium">
                        Customer Visibility State
                      </label>
                      <div className="flex items-center gap-3 pt-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer min-h-11">
                          <input
                            id="cat-status-input"
                            type="checkbox"
                            checked={catDraftIsActive}
                            onChange={(e) => setCatDraftIsActive(e.target.checked)}
                            className="size-4 rounded border-gray-300 text-primary"
                          />
                          <span>Category is Active</span>
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
                        <label htmlFor="prod-status-input" className="text-xs font-medium">
                          Active State
                        </label>
                        <div className="pt-2">
                          <label className="flex items-center gap-2 text-sm cursor-pointer min-h-11">
                            <input
                              id="prod-status-input"
                              type="checkbox"
                              checked={prodDraftIsActive}
                              onChange={(e) => setProdDraftIsActive(e.target.checked)}
                              className="size-4 rounded border-gray-300 text-primary"
                            />
                            <span>Product is Active</span>
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
                          Product Name ({activeLangTab.toUpperCase()})
                        </label>
                        <input
                          id="prod-name-input"
                          type="text"
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

                    <div className="flex justify-end gap-2 pt-2">
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

              {/* English translation (required default) */}
              <div className="space-y-3 rounded-xl border p-4 bg-muted/20">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Language (English)
                </h3>
                <div className="space-y-1.5">
                  <label htmlFor="create-cat-name-en" className="text-xs font-medium">
                    Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-cat-name-en"
                    data-testid="create-category-name"
                    type="text"
                    value={newCatNameEn}
                    onChange={(e) => setNewCatNameEn(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newCatErrors.name ? "border-destructive" : ""
                    }`}
                    placeholder="Category Name"
                  />
                  {newCatErrors.name && (
                    <p className="text-xs text-destructive">{newCatErrors.name}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-cat-desc-en" className="text-xs font-medium">
                    Description
                  </label>
                  <textarea
                    id="create-cat-desc-en"
                    rows={2}
                    value={newCatDescEn}
                    onChange={(e) => setNewCatDescEn(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder="Optional short description..."
                  />
                </div>
              </div>

              {/* Optional Arabic */}
              {arabicRegistered && (
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

              {/* Default Language (English) content */}
              <div className="space-y-3 rounded-xl border p-4 bg-muted/20">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Default Language (English)
                </h3>
                <div className="space-y-1.5">
                  <label htmlFor="create-prod-name-en" className="text-xs font-medium">
                    Name <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="create-prod-name-en"
                    data-testid="create-product-name"
                    type="text"
                    value={newProdNameEn}
                    onChange={(e) => setNewProdNameEn(e.target.value)}
                    className={`w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11 ${
                      newProdErrors.name ? "border-destructive" : ""
                    }`}
                    placeholder="Product Name"
                  />
                  {newProdErrors.name && (
                    <p className="text-xs text-destructive">{newProdErrors.name}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-prod-desc-en" className="text-xs font-medium">
                    Short Description
                  </label>
                  <input
                    id="create-prod-desc-en"
                    type="text"
                    value={newProdDescEn}
                    onChange={(e) => setNewProdDescEn(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder="Short summary for card"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="create-prod-details-en" className="text-xs font-medium">
                    Details
                  </label>
                  <textarea
                    id="create-prod-details-en"
                    rows={2}
                    value={newProdDetailsEn}
                    onChange={(e) => setNewProdDetailsEn(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-11"
                    placeholder="Full product details..."
                  />
                </div>
              </div>

              {/* Optional Arabic content */}
              {arabicRegistered && (
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
