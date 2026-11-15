"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  Package,
  PackagePlus,
  Save,
  Search,
  X,
} from "lucide-react";

import {
  createProductAction,
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
  buildAdminProductRows,
  filterAdminProductRows,
} from "@/lib/catalog/admin";
import { buildCategoryHierarchy } from "@/lib/catalog/tree";
import { createProductEditDraft } from "@/lib/catalog/product-draft";
import { collectChangedTranslations } from "@/lib/catalog/translation-draft";
import { getCatalogLanguageTabs, getTranslationStatus } from "@/lib/catalog/language-tabs";
import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
  LanguageRow,
  ResolvedLanguage,
} from "./types";

interface ProductsAdminProps {
  settings: {
    displayName: string;
    currency: string;
  };
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  categories: CatalogCategoryRecord[];
  products: CatalogProductRecord[];
}

type ActiveFilter = "all" | "active" | "inactive";

interface ProductFormState {
  mode: "create" | "edit";
  productId: string | null;
  categoryId: string;
  slug: string;
  price: string;
  isActive: boolean;
  allowInquiry: boolean;
  activeLangTab: string;
  translations: Record<
    string,
    { name: string; description: string; details: string }
  >;
  initialTranslations: Record<
    string,
    { name: string; description: string; details: string }
  >;
  errors: Record<string, string>;
  initialSnapshot: string;
}

function snapshotForm(form: ProductFormState): string {
  return JSON.stringify({
    categoryId: form.categoryId,
    slug: form.slug,
    price: form.price,
    isActive: form.isActive,
    allowInquiry: form.allowInquiry,
    translations: form.translations,
  });
}

function statusBadge(row: ReturnType<typeof buildAdminProductRows>[number]) {
  if (row.status === "active") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
      >
        Active
      </Badge>
    );
  }

  if (row.status === "hidden") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-700"
      >
        Active (hidden by category)
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      Inactive
    </Badge>
  );
}

export function ProductsAdmin({
  settings,
  defaultLanguage,
  languages,
  categories,
  products: initialProducts,
}: ProductsAdminProps) {
  const [products, setProducts] = useState(initialProducts);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [feedback, setFeedback] = useState<CatalogActionResult | null>(null);
  const [form, setForm] = useState<ProductFormState | null>(null);
  const [isPending, startTransition] = useTransition();
  const saveInFlightRef = useRef(false);

  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel =
    defaultLanguage?.label ?? (defaultLangCode === "ar" ? "العربية" : "English");
  const defaultLangDir =
    defaultLanguage?.textDirection ?? (defaultLangCode === "ar" ? "rtl" : "ltr");
  const languageTabs = useMemo(() => {
    const tabs = getCatalogLanguageTabs(languages, defaultLanguage);
    if (tabs.length > 0) return tabs;

    return [
      {
        code: defaultLangCode,
        label: defaultLangLabel,
        isRtl: defaultLangDir === "rtl",
        isDefault: true,
      },
    ];
  }, [defaultLanguage, defaultLangCode, defaultLangDir, defaultLangLabel, languages]);

  const { flattened } = useMemo(
    () =>
      buildCategoryHierarchy(categories, {
        preferredLanguage: defaultLangCode,
        defaultLanguage: defaultLangCode,
      }),
    [categories, defaultLangCode],
  );

  const rows = useMemo(
    () =>
      buildAdminProductRows(products, categories, {
        preferredLanguage: defaultLangCode,
        defaultLanguage: defaultLangCode,
      }),
    [products, categories, defaultLangCode],
  );

  const filteredRows = useMemo(
    () =>
      filterAdminProductRows(rows, {
        query,
        categoryId: categoryFilter,
        active: activeFilter,
      }),
    [rows, query, categoryFilter, activeFilter],
  );

  const categoryOptions = flattened.map((categoryNode) => ({
    id: categoryNode.id,
    label: `${categoryNode.breadcrumb} (${categoryNode.slug})`,
  }));

  const openCreateForm = () => {
    if (categories.length === 0) return;

    const translations: Record<
      string,
      { name: string; description: string; details: string }
    > = {};
    for (const tab of languageTabs) {
      translations[tab.code] = { name: "", description: "", details: "" };
    }

    const nextForm: ProductFormState = {
      mode: "create",
      productId: null,
      categoryId:
        categoryFilter && categories.some((category) => category.id === categoryFilter)
          ? categoryFilter
          : flattened[0]?.id ?? "",
      slug: "",
      price: "",
      isActive: false,
      allowInquiry: true,
      activeLangTab: defaultLangCode,
      translations,
      initialTranslations: translations,
      errors: {},
      initialSnapshot: "",
    };

    nextForm.initialSnapshot = snapshotForm(nextForm);
    setFeedback(null);
    setForm(nextForm);
  };

  const openEditForm = (product: CatalogProductRecord) => {
    const draft = createProductEditDraft(product);
    const translations: Record<
      string,
      { name: string; description: string; details: string }
    > = {};

    for (const [code, translation] of Object.entries(draft.translations)) {
      translations[code] = {
        name: translation.name ?? "",
        description: translation.description ?? "",
        details: translation.details ?? "",
      };
    }

    for (const tab of languageTabs) {
      if (!translations[tab.code]) {
        translations[tab.code] = { name: "", description: "", details: "" };
      }
    }

    const preferredTab = languageTabs.some((tab) => tab.code === defaultLangCode)
      ? defaultLangCode
      : languageTabs[0]?.code ?? defaultLangCode;

    const nextForm: ProductFormState = {
      mode: "edit",
      productId: product.id,
      categoryId: draft.categoryId,
      slug: draft.slug,
      price: draft.price,
      isActive: draft.isActive,
      allowInquiry: false,
      activeLangTab: preferredTab,
      translations,
      initialTranslations: { ...translations },
      errors: {},
      initialSnapshot: "",
    };

    nextForm.initialSnapshot = snapshotForm(nextForm);
    setFeedback(null);
    setForm(nextForm);
  };

  const closeForm = () => {
    if (!form || isPending || saveInFlightRef.current) return;
    if (
      snapshotForm(form) !== form.initialSnapshot &&
      typeof window !== "undefined" &&
      !window.confirm("Discard this unsaved product draft?")
    ) {
      return;
    }
    setForm(null);
    setFeedback(null);
  };

  const updateForm = (patch: Partial<ProductFormState>) => {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const updateTranslation = (
    languageCode: string,
    patch: Partial<{ name: string; description: string; details: string }>,
  ) => {
    setForm((previous) => {
      if (!previous) return previous;
      const current = previous.translations[languageCode] ?? {
        name: "",
        description: "",
        details: "",
      };
      return {
        ...previous,
        translations: {
          ...previous.translations,
          [languageCode]: { ...current, ...patch },
        },
      };
    });
  };

  const clearFilters = () => {
    setQuery("");
    setCategoryFilter("");
    setActiveFilter("all");
  };

  const handleSave = () => {
    if (!form || saveInFlightRef.current) return;
    saveInFlightRef.current = true;

    startTransition(async () => {
      try {
        if (form.mode === "create") {
          const translations = languageTabs
            .map((tab) => {
              const values = form.translations[tab.code] ?? {
                name: "",
                description: "",
                details: "",
              };
              const hasContent =
                values.name.trim() ||
                values.description.trim() ||
                values.details.trim();

              if (tab.code !== defaultLangCode && !hasContent) return null;

              return {
                languageCode: tab.code,
                name: values.name,
                description: values.description,
                details: values.details,
              };
            })
            .filter((translation) => translation !== null);

          const result = await createProductAction({
            categoryId: form.categoryId,
            slug: form.slug,
            price: form.price,
            translations,
            allowInquiry: form.allowInquiry,
          });

          if (!result.success) {
            setForm((previous) =>
              previous
                ? { ...previous, errors: result.errors ?? {} }
                : previous,
            );
            setFeedback(result);
            return;
          }

          if (result.product) {
            setProducts((previous) => [...previous, result.product!]);
          }
          setFeedback({
            success: true,
            message: form.allowInquiry
              ? "Product created with an inquiry button. Customers can start a conversation when they tap it."
              : "Product created. It is inactive until you activate it.",
          });
          setForm(null);
          return;
        }

        const changedTranslations = collectChangedTranslations(
          form.translations,
          form.initialTranslations,
        );

        const result = await updateProductAction({
          productId: form.productId,
          categoryId: form.categoryId,
          slug: form.slug,
          price: form.price,
          isActive: form.isActive,
          translations: changedTranslations,
        });

        if (!result.success) {
          setForm((previous) =>
            previous ? { ...previous, errors: result.errors ?? {} } : previous,
          );
          setFeedback(result);
          return;
        }

        if (result.product) {
          setProducts((previous) =>
            previous.map((productRecord) =>
              productRecord.id === result.product!.id
                ? result.product!
                : productRecord,
            ),
          );
        }
        const updatedLanguages = changedTranslations.map((translation) =>
          translation.languageCode.toUpperCase(),
        );
        setFeedback({
          success: true,
          message:
            updatedLanguages.length > 0
              ? `Product saved. Updated ${updatedLanguages.join(", ")} content; other translations were preserved.`
              : "Product saved. No translation changes were needed.",
        });
        setForm(null);
      } catch {
        setFeedback({
          success: false,
          message:
            "A communication or server error occurred. Your inputs have been preserved. Please try again.",
        });
      } finally {
        saveInFlightRef.current = false;
      }
    });
  };

  const feedbackBanner = feedback ? (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border p-4 text-sm font-medium ${
        feedback.success
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
          : "border-destructive/20 bg-destructive/10 text-destructive"
      }`}
    >
      {feedback.success ? (
        <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />
      ) : (
        <AlertCircle className="size-5 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 space-y-1">
        <p>{feedback.message}</p>
        {feedback.errors ? (
          <ul className="list-inside list-disc space-y-0.5 text-xs">
            {Object.entries(feedback.errors).map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  ) : null;

  if (form) {
    const isDirty = snapshotForm(form) !== form.initialSnapshot;
    const formTitle = form.mode === "create" ? "Add product" : "Edit product";
    const activeLanguageTab =
      languageTabs.find((tab) => tab.code === form.activeLangTab) ??
      languageTabs[0];
    const activeTranslation = form.translations[activeLanguageTab.code] ?? {
      name: "",
      description: "",
      details: "",
    };
    const translationError = (field: "name" | "description" | "details") => {
      const direct = form.errors[`translations.${activeLanguageTab.code}.${field}`];
      if (direct) return direct;
      if (activeLanguageTab.isDefault) return form.errors[field] ?? "";
      if (activeLanguageTab.code === "ar") {
        const legacyKey =
          field === "name"
            ? "arabicName"
            : field === "description"
              ? "arabicDescription"
              : "arabicDetails";
        return form.errors[legacyKey] ?? "";
      }
      return "";
    };
    const tabHasError = (languageCode: string) =>
      Object.keys(form.errors).some(
        (key) =>
          key === `translations.${languageCode}` ||
          key.startsWith(`translations.${languageCode}.`),
      );

    return (
      <div
        className="min-w-0 space-y-6 overflow-x-clip"
        data-testid="product-form"
      >
        <PageHeader
          title={formTitle}
          description={
            form.mode === "create"
              ? "Choose a category, then add the product details customers will see."
              : "Update the product, its category, price and active state."
          }
        >
          <Button
            type="button"
            variant="outline"
            onClick={closeForm}
            disabled={isPending}
            className="min-h-11 gap-2"
          >
            <ArrowLeft className="size-4" />
            <span>Back to products</span>
          </Button>
        </PageHeader>

        {feedbackBanner}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {form.mode === "create" ? "Product details" : form.slug}
            </CardTitle>
            <CardDescription>
              Prices are displayed quotes in {settings.currency}; no payment is
              charged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="product-category" className="text-sm font-medium">
                  Category <span className="text-destructive">*</span>
                </label>
                <select
                  id="product-category"
                  data-testid="product-category-select"
                  value={form.categoryId}
                  disabled={isPending}
                  onChange={(event) => updateForm({ categoryId: event.target.value })}
                  className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select a category</option>
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {form.errors.categoryId ? (
                  <p className="text-xs text-destructive">{form.errors.categoryId}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="product-slug" className="text-sm font-medium">
                  Slug <span className="text-destructive">*</span>
                </label>
                <input
                  id="product-slug"
                  data-testid="product-slug-input"
                  type="text"
                  value={form.slug}
                  disabled={isPending}
                  onChange={(event) => updateForm({ slug: event.target.value })}
                  className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                    form.errors.slug ? "border-destructive" : ""
                  }`}
                  placeholder="e.g. iphone-15"
                />
                {form.errors.slug ? (
                  <p className="text-xs text-destructive">{form.errors.slug}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="product-price" className="text-sm font-medium">
                  Displayed price ({settings.currency}){" "}
                  <span className="text-destructive">*</span>
                </label>
                <input
                  id="product-price"
                  data-testid="product-price-input"
                  type="text"
                  inputMode="decimal"
                  value={form.price}
                  disabled={isPending}
                  onChange={(event) => updateForm({ price: event.target.value })}
                  className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                    form.errors.price ? "border-destructive" : ""
                  }`}
                  placeholder="0.00"
                />
                {form.errors.price ? (
                  <p className="text-xs text-destructive">{form.errors.price}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <span className="text-sm font-medium">Active state</span>
                {form.mode === "edit" ? (
                  <div className="flex min-h-11 items-center gap-3">
                    <input
                      id="product-active"
                      data-testid="product-active-input"
                      type="checkbox"
                      checked={form.isActive}
                      disabled={isPending}
                      onChange={(event) =>
                        updateForm({ isActive: event.target.checked })
                      }
                      className="size-5 rounded border-gray-300 text-primary"
                    />
                    <label
                      htmlFor="product-active"
                      className="flex min-h-11 cursor-pointer select-none items-center text-sm"
                    >
                      Product is active
                    </label>
                  </div>
                ) : (
                  <div className="flex min-h-11 items-start gap-2 text-sm text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0" />
                    <span>
                      New products start inactive. Save it, then turn on the
                      active state when you are ready for customers to see it.
                    </span>
                  </div>
                )}
              </div>
            </div>

            {form.mode === "create" ? (
              <div className="rounded-xl border bg-muted/20 p-4">
                <label
                  htmlFor="product-allow-inquiry"
                  className="flex min-h-11 cursor-pointer items-start gap-3"
                >
                  <input
                    id="product-allow-inquiry"
                    data-testid="product-allow-inquiry-input"
                    type="checkbox"
                    checked={form.allowInquiry}
                    disabled={isPending}
                    onChange={(event) =>
                      updateForm({ allowInquiry: event.target.checked })
                    }
                    className="mt-0.5 size-5 rounded border-gray-300 text-primary"
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">
                      Allow customers to inquire about this product
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Adds an &quot;Ask about this product&quot; button. No
                      inquiry is created until a customer taps it.
                    </span>
                  </span>
                </label>
                {form.errors.allowInquiry ? (
                  <p className="mt-2 text-xs text-destructive">
                    {form.errors.allowInquiry}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2" role="tablist">
                {languageTabs.map((tab) => {
                  const status = getTranslationStatus(form.translations[tab.code]);
                  const isActive = form.activeLangTab === tab.code;

                  return (
                    <Button
                      key={tab.code}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      variant={isActive ? "default" : "outline"}
                      onClick={() => updateForm({ activeLangTab: tab.code })}
                      className="min-h-11 gap-1.5"
                      data-testid={`language-tab-${tab.code}`}
                    >
                      <span>
                        {tab.label} ({tab.code.toUpperCase()})
                      </span>
                      <span
                        className={`text-xs font-normal ${
                          isActive ? "opacity-80" : "text-muted-foreground"
                        }`}
                      >
                        {status === "complete" ? "Complete" : "Missing"}
                      </span>
                      {tabHasError(tab.code) ? (
                        <span className="text-destructive">!</span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                {form.mode === "edit"
                  ? "Save applies all changed language tabs together. Untouched translations are preserved."
                  : "The default language name is required. Other enabled languages can be filled now or later; blank languages are not created."}
              </p>

              <div
                className="space-y-4"
                dir={activeLanguageTab.isRtl ? "rtl" : "ltr"}
              >
                <div className="space-y-1.5">
                  <label htmlFor="product-name" className="text-sm font-medium">
                    Name ({activeLanguageTab.code.toUpperCase()}){" "}
                    <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="product-name"
                    data-testid="product-name-input"
                    type="text"
                    value={activeTranslation.name}
                    disabled={isPending}
                    onChange={(event) =>
                      updateTranslation(form.activeLangTab, {
                        name: event.target.value,
                      })
                    }
                    className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      translationError("name") ? "border-destructive" : ""
                    }`}
                    placeholder="Product name"
                  />
                  {translationError("name") ? (
                    <p className="text-xs text-destructive">
                      {translationError("name")}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="product-description"
                    className="text-sm font-medium"
                  >
                    Short description ({activeLanguageTab.code.toUpperCase()})
                  </label>
                  <input
                    id="product-description"
                    data-testid="product-description-input"
                    type="text"
                    value={activeTranslation.description}
                    disabled={isPending}
                    onChange={(event) =>
                      updateTranslation(form.activeLangTab, {
                        description: event.target.value,
                      })
                    }
                    className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      translationError("description") ? "border-destructive" : ""
                    }`}
                    placeholder="Short summary shown on the product card"
                  />
                  {translationError("description") ? (
                    <p className="text-xs text-destructive">
                      {translationError("description")}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="product-details" className="text-sm font-medium">
                    Details ({activeLanguageTab.code.toUpperCase()})
                  </label>
                  <textarea
                    id="product-details"
                    data-testid="product-details-input"
                    rows={4}
                    value={activeTranslation.details}
                    disabled={isPending}
                    onChange={(event) =>
                      updateTranslation(form.activeLangTab, {
                        details: event.target.value,
                      })
                    }
                    className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                      translationError("details") ? "border-destructive" : ""
                    }`}
                    placeholder="Full details revealed when a customer asks"
                  />
                  {translationError("details") ? (
                    <p className="text-xs text-destructive">
                      {translationError("details")}
                    </p>
                  ) : null}
                </div>

                {form.errors.arabicName ? (
                  <p className="text-xs text-destructive">{form.errors.arabicName}</p>
                ) : null}
                {form.errors.arabicDescription ? (
                  <p className="text-xs text-destructive">
                    {form.errors.arabicDescription}
                  </p>
                ) : null}
                {form.errors.arabicDetails ? (
                  <p className="text-xs text-destructive">
                    {form.errors.arabicDetails}
                  </p>
                ) : null}
                {form.errors.languageCode ? (
                  <p className="text-xs text-destructive">
                    {form.errors.languageCode}
                  </p>
                ) : null}
                {form.errors.parameters ? (
                  <p className="text-xs text-destructive">{form.errors.parameters}</p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                {isDirty ? "Unsaved changes" : "No unsaved changes"}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeForm}
                  disabled={isPending}
                  className="min-h-11"
                  data-testid="cancel-product-btn"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={isPending}
                  className="min-h-11 gap-2"
                  data-testid="save-product-submit-btn"
                >
                  {isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  <span>
                    {form.mode === "create" ? "Create product" : "Save product"}
                  </span>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 overflow-x-clip" data-testid="products-admin">
      <PageHeader
        title="Products"
        description="Add and edit products directly, without navigating the category tree."
      >
        <Button
          type="button"
          onClick={openCreateForm}
          disabled={categories.length === 0}
          className="min-h-11 gap-2"
          data-testid="add-product-btn"
        >
          <PackagePlus className="size-4" />
          <span>Add product</span>
        </Button>
        <Button asChild variant="outline" className="min-h-11 gap-2">
          <Link href="/categories">
            <Package className="size-4" />
            <span>Categories</span>
          </Link>
        </Button>
        <Button asChild variant="ghost" className="min-h-11 gap-2">
          <Link href="/catalog" target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            <span>Advanced catalog</span>
          </Link>
        </Button>
      </PageHeader>

      {feedbackBanner}

      {categories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <AlertTriangle className="size-8 text-amber-600" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Create a category first</p>
              <p className="text-xs text-muted-foreground">
                Every product needs a category. Add a root category on the
                Categories page, then return here.
              </p>
            </div>
            <Button asChild className="min-h-11">
              <Link href="/categories">Go to Categories</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">All products</CardTitle>
              <CardDescription>
                {filteredRows.length} of {rows.length}{" "}
                {rows.length === 1 ? "product" : "products"} shown
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs">
              Currency: {settings.currency}
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,10rem)]">
            <div className="space-y-1.5">
              <label htmlFor="product-search" className="text-xs font-medium">
                Search products
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="product-search"
                  data-testid="product-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="min-h-11 w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm"
                  placeholder="Name, slug, category, price..."
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="product-category-filter" className="text-xs font-medium">
                Category
              </label>
              <select
                id="product-category-filter"
                data-testid="product-category-filter"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">All categories</option>
                {categoryOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="product-status-filter" className="text-xs font-medium">
                Status
              </label>
              <select
                id="product-status-filter"
                data-testid="product-status-filter"
                value={activeFilter}
                onChange={(event) =>
                  setActiveFilter(event.target.value as ActiveFilter)
                }
                className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Package className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No products yet</p>
                <p className="text-xs text-muted-foreground">
                  Add your first product and choose its category directly.
                </p>
              </div>
              {categories.length > 0 ? (
                <Button
                  type="button"
                  onClick={openCreateForm}
                  className="min-h-11"
                >
                  Add product
                </Button>
              ) : null}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <X className="size-8 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No products match</p>
                <p className="text-xs text-muted-foreground">
                  Try a different search or clear the filters.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={clearFilters}
                className="min-h-11"
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRows.map((row) => (
                <div
                  key={row.product.id}
                  data-testid="product-row"
                  data-product-id={row.product.id}
                  data-product-slug={row.product.slug}
                  className="flex min-w-0 flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-words text-sm font-semibold">
                        {row.name}
                      </span>
                      <Badge variant="secondary" className="max-w-full break-all font-mono text-xs">
                        {row.product.slug}
                      </Badge>
                      {statusBadge(row)}
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      {row.categoryPath}
                    </p>
                    <p className="text-sm font-semibold">
                      {settings.currency} {row.product.price}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => openEditForm(row.product)}
                      className="min-h-11"
                      data-testid="edit-product-btn"
                    >
                      Edit
                    </Button>
                    <Button asChild variant="ghost" className="min-h-11 gap-1.5">
                      <Link
                        href={`/catalog?actionProduct=${encodeURIComponent(row.product.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="product-buttons-link"
                      >
                        <ExternalLink className="size-4" />
                        <span>Buttons</span>
                      </Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
