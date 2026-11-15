"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Folder,
  FolderPlus,
  FolderTree,
  Info,
  Loader2,
  Save,
} from "lucide-react";

import {
  createCategoryAction,
  updateCategoryAction,
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
import { buildAdminCategoryRows } from "@/lib/catalog/admin";
import { collectChangedTranslations } from "@/lib/catalog/translation-draft";
import {
  buildCategoryHierarchy,
  resolveCategoryDisplayName,
} from "@/lib/catalog/tree";
import type {
  CatalogCategoryRecord,
  CatalogProductRecord,
  LanguageRow,
  ResolvedLanguage,
} from "./types";

interface CategoriesAdminProps {
  defaultLanguage: ResolvedLanguage | null;
  languages: LanguageRow[];
  categories: CatalogCategoryRecord[];
  products: CatalogProductRecord[];
}

interface CategoryFormState {
  mode: "create" | "edit";
  categoryId: string | null;
  parentId: string | null;
  slug: string;
  isActive: boolean;
  activeLangTab: string;
  translations: Record<string, { name: string; description: string }>;
  initialTranslations: Record<string, { name: string; description: string }>;
  errors: Record<string, string>;
  initialSnapshot: string;
}

function snapshotForm(form: CategoryFormState): string {
  return JSON.stringify({
    parentId: form.parentId,
    slug: form.slug,
    isActive: form.isActive,
    translations: form.translations,
  });
}

function categoryStatusBadge(
  row: ReturnType<typeof buildAdminCategoryRows>[number],
) {
  if (row.node.effectiveVisibility) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
      >
        Active
      </Badge>
    );
  }

  if (row.node.isActive && row.node.hasInactiveAncestor) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-700"
      >
        Active (hidden by parent)
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      Inactive
    </Badge>
  );
}

export function CategoriesAdmin({
  defaultLanguage,
  languages,
  categories: initialCategories,
  products,
}: CategoriesAdminProps) {
  const [categories, setCategories] = useState(initialCategories);
  const [feedback, setFeedback] = useState<CatalogActionResult | null>(null);
  const [form, setForm] = useState<CategoryFormState | null>(null);
  const [isPending, startTransition] = useTransition();
  const saveInFlightRef = useRef(false);

  const defaultLangCode = defaultLanguage?.code ?? "en";
  const defaultLangLabel =
    defaultLanguage?.label ?? (defaultLangCode === "ar" ? "العربية" : "English");
  const defaultLangDir =
    defaultLanguage?.textDirection ?? (defaultLangCode === "ar" ? "rtl" : "ltr");
  const arabicRegistered = languages.some((languageRow) => languageRow.code === "ar");

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
      buildAdminCategoryRows(categories, products, {
        preferredLanguage: defaultLangCode,
        defaultLanguage: defaultLangCode,
      }),
    [categories, products, defaultLangCode],
  );

  const parentOptions = flattened.map((categoryNode) => ({
    id: categoryNode.id,
    label: `${categoryNode.breadcrumb} (${categoryNode.slug})`,
  }));

  const openCreateForm = (parentId: string | null = null) => {
    const translations: Record<string, { name: string; description: string }> = {
      [defaultLangCode]: { name: "", description: "" },
    };
    if (arabicRegistered && defaultLangCode !== "ar") {
      translations.ar = { name: "", description: "" };
    }

    const nextForm: CategoryFormState = {
      mode: "create",
      categoryId: null,
      parentId,
      slug: "",
      isActive: false,
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

  const openEditForm = (categoryRecord: CatalogCategoryRecord) => {
    const translations: Record<string, { name: string; description: string }> = {};
    for (const [code, translation] of Object.entries(categoryRecord.translations)) {
      translations[code] = {
        name: translation.name ?? "",
        description: translation.description ?? "",
      };
    }

    const preferredTab = translations[defaultLangCode]
      ? defaultLangCode
      : Object.keys(translations)[0] ?? defaultLangCode;

    const nextForm: CategoryFormState = {
      mode: "edit",
      categoryId: categoryRecord.id,
      parentId: categoryRecord.parentId,
      slug: categoryRecord.slug,
      isActive: categoryRecord.isActive,
      activeLangTab: preferredTab,
      translations,
      initialTranslations: translations,
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
      !window.confirm("Discard this unsaved category draft?")
    ) {
      return;
    }
    setForm(null);
    setFeedback(null);
  };

  const updateForm = (patch: Partial<CategoryFormState>) => {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
  };

  const updateTranslation = (
    languageCode: string,
    patch: Partial<{ name: string; description: string }>,
  ) => {
    setForm((previous) => {
      if (!previous) return previous;
      const current = previous.translations[languageCode] ?? {
        name: "",
        description: "",
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

  const handleSave = () => {
    if (!form || saveInFlightRef.current) return;
    saveInFlightRef.current = true;

    startTransition(async () => {
      try {
        if (form.mode === "create") {
          const defaultTranslation = form.translations[defaultLangCode] ?? {
            name: "",
            description: "",
          };
          const arabicTranslation =
            arabicRegistered && defaultLangCode !== "ar"
              ? form.translations.ar
              : undefined;

          const result = await createCategoryAction({
            parentId: form.parentId,
            slug: form.slug,
            name: defaultTranslation.name,
            description: defaultTranslation.description,
            arabicName: arabicTranslation?.name.trim()
              ? arabicTranslation.name
              : undefined,
            arabicDescription: arabicTranslation?.description.trim()
              ? arabicTranslation.description
              : undefined,
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

          if (result.category) {
            setCategories((previous) => [...previous, result.category!]);
          }
          setFeedback({
            success: true,
            message: "Category created. It is inactive until you activate it.",
          });
          setForm(null);
          return;
        }

        const changedTranslations = collectChangedTranslations(
          form.translations,
          form.initialTranslations,
        );

        const result = await updateCategoryAction({
          categoryId: form.categoryId,
          slug: form.slug,
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

        if (result.category) {
          setCategories((previous) =>
            previous.map((categoryRecord) =>
              categoryRecord.id === result.category!.id
                ? result.category!
                : categoryRecord,
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
              ? `Category saved. Updated ${updatedLanguages.join(", ")} content; other translations and the parent relationship were preserved.`
              : "Category saved. No translation changes were needed; the parent relationship was preserved.",
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
    const formTitle = form.mode === "create" ? "Add category" : "Edit category";
    const activeTranslation = form.translations[form.activeLangTab] ?? {
      name: "",
      description: "",
    };
    const translationError = (field: "name" | "description") =>
      form.errors[`translations.${form.activeLangTab}.${field}`] ??
      form.errors[field] ??
      "";
    const tabHasError = (languageCode: string) =>
      Object.keys(form.errors).some(
        (key) =>
          key === `translations.${languageCode}` ||
          key.startsWith(`translations.${languageCode}.`),
      );
    const currentParent = form.parentId
      ? flattened.find((categoryNode) => categoryNode.id === form.parentId)
      : null;

    return (
      <div
        className="min-w-0 space-y-6 overflow-x-clip"
        data-testid="category-form"
      >
        <PageHeader
          title={formTitle}
          description={
            form.mode === "create"
              ? "New categories start at the top level unless you choose a parent."
              : "Update the category name, description, slug and active state."
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
            <span>Back to categories</span>
          </Button>
        </PageHeader>

        {feedbackBanner}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {form.mode === "create" ? "Category details" : form.slug}
            </CardTitle>
            <CardDescription>
              Categories organize products. Existing parent relationships are
              never changed by this form.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="category-slug" className="text-sm font-medium">
                  Slug <span className="text-destructive">*</span>
                </label>
                <input
                  id="category-slug"
                  data-testid="category-slug-input"
                  type="text"
                  value={form.slug}
                  disabled={isPending}
                  onChange={(event) => updateForm({ slug: event.target.value })}
                  className={`min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm ${
                    form.errors.slug ? "border-destructive" : ""
                  }`}
                  placeholder="e.g. electronics"
                />
                {form.errors.slug ? (
                  <p className="text-xs text-destructive">{form.errors.slug}</p>
                ) : null}
              </div>

              {form.mode === "create" ? (
                <div className="space-y-1.5">
                  <label htmlFor="category-parent" className="text-sm font-medium">
                    Parent category
                  </label>
                  <select
                    id="category-parent"
                    data-testid="category-parent-select"
                    value={form.parentId ?? "root"}
                    disabled={isPending}
                    onChange={(event) =>
                      updateForm({
                        parentId:
                          event.target.value === "root"
                            ? null
                            : event.target.value,
                      })
                    }
                    className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="root">None (top-level category)</option>
                    {parentOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Leave as top-level for the usual merchant workflow.
                  </p>
                  {form.errors.parentId ? (
                    <p className="text-xs text-destructive">
                      {form.errors.parentId}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Parent category</span>
                  <div className="flex min-h-11 items-center rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    {form.parentId
                      ? currentParent?.breadcrumb ?? form.parentId
                      : "None (top-level category)"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The parent is fixed after creation; existing relationships
                    are preserved.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <span className="text-sm font-medium">Active state</span>
                {form.mode === "edit" ? (
                  <div className="flex min-h-11 items-center gap-3">
                    <input
                      id="category-active"
                      data-testid="category-active-input"
                      type="checkbox"
                      checked={form.isActive}
                      disabled={isPending}
                      onChange={(event) =>
                        updateForm({ isActive: event.target.checked })
                      }
                      className="size-5 rounded border-gray-300 text-primary"
                    />
                    <label
                      htmlFor="category-active"
                      className="flex min-h-11 cursor-pointer select-none items-center text-sm"
                    >
                      Category is active
                    </label>
                  </div>
                ) : (
                  <div className="flex min-h-11 items-start gap-2 text-sm text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0" />
                    <span>
                      New categories start inactive. Save it, then activate it
                      when the products and parents are ready.
                    </span>
                  </div>
                )}
              </div>
            </div>

            {form.mode === "edit" &&
            form.isActive &&
            currentParent &&
            !currentParent.effectiveVisibility ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <p>
                  A parent category is inactive. This category is marked active
                  but stays hidden from customers until every parent is active.
                </p>
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={
                    form.activeLangTab === defaultLangCode ? "default" : "outline"
                  }
                  onClick={() => updateForm({ activeLangTab: defaultLangCode })}
                  className="min-h-11"
                >
                  {defaultLangLabel} ({defaultLangCode.toUpperCase()})
                  {tabHasError(defaultLangCode) ? (
                    <span className="ml-1 text-destructive">!</span>
                  ) : null}
                </Button>
                {arabicRegistered && defaultLangCode !== "ar" ? (
                  <Button
                    type="button"
                    variant={form.activeLangTab === "ar" ? "default" : "outline"}
                    onClick={() => updateForm({ activeLangTab: "ar" })}
                    className="min-h-11"
                  >
                    العربية (AR)
                    {tabHasError("ar") ? (
                      <span className="ml-1 text-destructive">!</span>
                    ) : null}
                  </Button>
                ) : null}
                <Badge variant="outline" className="text-xs">
                  {form.translations[form.activeLangTab]?.name?.trim()
                    ? `Draft (${form.activeLangTab.toUpperCase()})`
                    : `Missing (${form.activeLangTab.toUpperCase()})`}
                </Badge>
              </div>

              {form.mode === "edit" ? (
                <p className="text-xs text-muted-foreground">
                  Saving applies the selected language tab. Other translations
                  are preserved.
                </p>
              ) : null}

              <div
                className="space-y-4"
                dir={form.activeLangTab === "ar" ? "rtl" : defaultLangDir}
              >
                <div className="space-y-1.5">
                  <label htmlFor="category-name" className="text-sm font-medium">
                    Name ({form.activeLangTab.toUpperCase()}){" "}
                    <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="category-name"
                    data-testid="category-name-input"
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
                    placeholder="Category name"
                  />
                  {translationError("name") ? (
                    <p className="text-xs text-destructive">
                      {translationError("name")}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="category-description"
                    className="text-sm font-medium"
                  >
                    Description ({form.activeLangTab.toUpperCase()})
                  </label>
                  <textarea
                    id="category-description"
                    data-testid="category-description-input"
                    rows={3}
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
                    placeholder="Optional description"
                  />
                  {translationError("description") ? (
                    <p className="text-xs text-destructive">
                      {translationError("description")}
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
                {form.errors.languageCode ? (
                  <p className="text-xs text-destructive">
                    {form.errors.languageCode}
                  </p>
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
                  data-testid="cancel-category-btn"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={isPending}
                  className="min-h-11 gap-2"
                  data-testid="save-category-submit-btn"
                >
                  {isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  <span>
                    {form.mode === "create" ? "Create category" : "Save category"}
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
    <div
      className="min-w-0 space-y-6 overflow-x-clip"
      data-testid="categories-admin"
    >
      <PageHeader
        title="Categories"
        description="Create and edit root or child categories without opening the advanced tree editor."
      >
        <Button
          type="button"
          onClick={() => openCreateForm(null)}
          className="min-h-11 gap-2"
          data-testid="add-category-btn"
        >
          <FolderPlus className="size-4" />
          <span>Add category</span>
        </Button>
        <Button asChild variant="outline" className="min-h-11 gap-2">
          <Link href="/products">
            <Folder className="size-4" />
            <span>Products</span>
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

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">All categories</CardTitle>
              <CardDescription>
                {rows.length} {rows.length === 1 ? "category" : "categories"} ·{" "}
                {products.length} {products.length === 1 ? "product" : "products"}
              </CardDescription>
            </div>
            <Badge variant="outline" className="gap-1.5 text-xs">
              <FolderTree className="size-3" />
              Parent relationships preserved
            </Badge>
          </div>
        </CardHeader>

        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Folder className="size-10 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No categories yet</p>
                <p className="text-xs text-muted-foreground">
                  Add a top-level category, then add products to it.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => openCreateForm(null)}
                className="min-h-11"
              >
                Add category
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => {
                const countText =
                  row.totalProductCount === row.directProductCount
                    ? `${row.directProductCount} ${
                        row.directProductCount === 1 ? "product" : "products"
                      }`
                    : `${row.directProductCount} direct · ${row.totalProductCount} including subcategories`;

                return (
                  <div
                    key={row.node.id}
                    data-testid="category-row"
                    data-category-id={row.node.id}
                    data-category-slug={row.node.slug}
                    data-category-root={row.isRoot ? "true" : "false"}
                    className="flex min-w-0 flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words text-sm font-semibold">
                          {resolveCategoryDisplayName(
                            row.node,
                            defaultLangCode,
                            defaultLangCode,
                          )}
                        </span>
                        <Badge variant="secondary" className="max-w-full break-all font-mono text-xs">
                          {row.node.slug}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={
                            row.isRoot
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "text-muted-foreground"
                          }
                        >
                          {row.isRoot
                            ? "Root category"
                            : `Child of ${row.parentName ?? "parent"}`}
                        </Badge>
                        {categoryStatusBadge(row)}
                      </div>
                      <p className="break-words text-xs text-muted-foreground">
                        {row.node.breadcrumb}
                      </p>
                      <p className="text-xs font-medium">{countText}</p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          const categoryRecord = categories.find(
                            (candidate) => candidate.id === row.node.id,
                          );
                          if (categoryRecord) openEditForm(categoryRecord);
                        }}
                        className="min-h-11"
                        data-testid="edit-category-btn"
                      >
                        Edit
                      </Button>
                      <Button asChild variant="ghost" className="min-h-11">
                        <Link href="/products">View products</Link>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
