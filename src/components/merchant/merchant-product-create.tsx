"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";

import { createMerchantProductDraft } from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { Button } from "@/components/ui/button";
import {
  clearProductFormDraft,
  lastCategoryKey,
  productFormDraftKey,
  readLastCategory,
  readProductFormDraft,
  writeLastCategory,
  writeProductFormDraft,
  type ProductFormDraft,
} from "@/lib/merchant/product-form-draft";

export type MerchantProductCategoryOption = {
  id: string;
  name: string;
};

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  priceLabel: string;
  pricePlaceholder: string;
  categoryLabel: string;
  newCategoryOption: string;
  newCategoryLabel: string;
  newCategoryPlaceholder: string;
  noCategories: string;
  save: string;
  saving: string;
  back: string;
  logout: string;
  languageLabel: string;
  draftNote: string;
  requiredName: string;
  invalidPrice: string;
  requiredCategory: string;
  requiredCategoryName: string;
  categoryNotFound: string;
  denied: string;
  conflict: string;
  unavailable: string;
  suspendedTitle: string;
  suspendedBody: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "إضافة منتج",
    subtitle: "أضف أول منتج إلى متجرك واحفظه كمسودة غير متاحة للعملاء.",
    storeLabel: "المتجر",
    nameLabel: "اسم المنتج",
    namePlaceholder: "مثال: منتج النور الأول",
    priceLabel: "السعر",
    pricePlaceholder: "0.00",
    categoryLabel: "القسم",
    newCategoryOption: "إنشاء قسم جديد",
    newCategoryLabel: "اسم القسم الجديد",
    newCategoryPlaceholder: "مثال: منتجات العناية",
    noCategories: "لا توجد أقسام بعد. أنشئ قسمًا جديدًا مع أول منتج.",
    save: "حفظ كمسودة",
    saving: "جارٍ الحفظ…",
    back: "العودة إلى المنتجات",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    draftNote: "يُحفظ ما تكتبه على هذا الجهاز لمدة سبعة أيام.",
    requiredName: "أدخل اسم المنتج.",
    invalidPrice: "أدخل سعرًا صالحًا من رقمين عشريين على الأكثر.",
    requiredCategory: "اختر قسمًا أو أنشئ قسمًا جديدًا.",
    requiredCategoryName: "أدخل اسم القسم الجديد.",
    categoryNotFound: "تعذر العثور على هذا القسم في متجرك. اختر قسمًا آخر.",
    denied: "لم تعد تملك صلاحية إضافة منتج لهذا المتجر.",
    conflict: "تعذر إنشاء المنتج بسبب تعارض في البيانات. حاول مرة أخرى.",
    unavailable: "تعذر حفظ المنتج الآن. حاول مرة أخرى بعد قليل.",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على المنتجات فقط. الإضافة غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
  },
  en: {
    dir: "ltr",
    title: "Add product",
    subtitle: "Add your first product and save it as an unavailable draft.",
    storeLabel: "Store",
    nameLabel: "Product name",
    namePlaceholder: "e.g. Al Noor Product One",
    priceLabel: "Price",
    pricePlaceholder: "0.00",
    categoryLabel: "Category",
    newCategoryOption: "Create a new category",
    newCategoryLabel: "New category name",
    newCategoryPlaceholder: "e.g. Care products",
    noCategories: "No categories yet. Create one together with the first product.",
    save: "Save as draft",
    saving: "Saving…",
    back: "Back to products",
    logout: "Sign out",
    languageLabel: "Page language",
    draftNote: "What you type is saved on this device for seven days.",
    requiredName: "Enter the product name.",
    invalidPrice: "Enter a valid price with no more than two decimal places.",
    requiredCategory: "Choose a category or create a new one.",
    requiredCategoryName: "Enter the new category name.",
    categoryNotFound: "This category could not be found in your store. Choose another one.",
    denied: "You can no longer add products to this store.",
    conflict: "The product could not be created because of a data conflict. Try again.",
    unavailable: "The product could not be saved right now. Try again shortly.",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review products only. Adding is unavailable until a platform administrator reactivates the store.",
  },
};

type FieldErrors = {
  name?: boolean;
  price?: boolean;
  category?: boolean;
  newCategoryName?: boolean;
};

type SaveError =
  | "INVALID_INPUT"
  | "CATEGORY_NOT_FOUND"
  | "DENIED"
  | "CONFLICT"
  | "UNAVAILABLE";

function validCategoryId(
  candidate: string,
  categories: MerchantProductCategoryOption[],
): string | null {
  return categories.some((entry) => entry.id === candidate) ? candidate : null;
}

function errorMessage(error: SaveError, copy: Copy): string {
  switch (error) {
    case "CATEGORY_NOT_FOUND":
      return copy.categoryNotFound;
    case "DENIED":
      return copy.denied;
    case "CONFLICT":
      return copy.conflict;
    case "UNAVAILABLE":
      return copy.unavailable;
    case "INVALID_INPUT":
      return copy.unavailable;
  }
}

export function MerchantProductCreate({
  storeName,
  storeId,
  userId,
  readOnly,
  categories,
}: {
  storeName: string;
  storeId: string;
  userId: string;
  readOnly: boolean;
  categories: MerchantProductCategoryOption[];
}) {
  const router = useRouter();
  const [locale, setLocale] = useState<MerchantLocale>("ar");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [, startTransition] = useTransition();
  const loadedRef = useRef(false);
  const submittingRef = useRef(false);
  const completedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const draftKey = productFormDraftKey(storeId, userId);
  const lastCategoryStorageKey = lastCategoryKey(storeId, userId);
  const copy = COPY[locale];

  const useNewCategory = categoryId.length === 0;

  useEffect(() => {
    if (loadedRef.current || readOnly) return;

    loadedRef.current = true;
    let cancelled = false;

    const draft = readProductFormDraft(window.localStorage, draftKey);
    const lastCategory = validCategoryId(
      readLastCategory(window.localStorage, lastCategoryStorageKey) ?? "",
      categories,
    );

    queueMicrotask(() => {
      if (cancelled) return;

      if (draft) {
        const draftCategory = draft.useNewCategory
          ? ""
          : validCategoryId(draft.categoryId, categories);

        setName(draft.name);
        setPrice(draft.price);
        setNewCategoryName(draft.newCategoryName);
        setCategoryId(
          draft.useNewCategory
            ? ""
            : draftCategory ?? lastCategory ?? (categories[0]?.id ?? ""),
        );
      } else {
        setCategoryId(lastCategory ?? (categories[0]?.id ?? ""));
      }

      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [categories, draftKey, lastCategoryStorageKey, readOnly]);

  useEffect(() => {
    if (!hydrated || readOnly || submitting || completedRef.current) return;

    const draft: ProductFormDraft = {
      name,
      price,
      categoryId,
      newCategoryName,
      useNewCategory,
    };

    writeProductFormDraft(window.localStorage, draftKey, draft);
  }, [
    categoryId,
    draftKey,
    hydrated,
    name,
    newCategoryName,
    price,
    readOnly,
    submitting,
    useNewCategory,
  ]);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (name.trim().length === 0) errors.name = true;
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim())) errors.price = true;

    if (useNewCategory) {
      if (newCategoryName.trim().length === 0) errors.newCategoryName = true;
    } else if (!validCategoryId(categoryId, categories)) {
      errors.category = true;
    }

    return errors;
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (readOnly || submittingRef.current) return;

    const errors = validate();
    setFieldErrors(errors);
    setSaveError(null);

    if (Object.keys(errors).length > 0) return;

    submittingRef.current = true;
    setSubmitting(true);

    startTransition(async () => {
      try {
        const result = await createMerchantProductDraft({
          name,
          price,
          categoryId: useNewCategory ? "" : categoryId,
          newCategoryName: useNewCategory ? newCategoryName : "",
        });

        if (!result.ok) {
          if (result.error === "INVALID_INPUT" && result.fields) {
            setFieldErrors(result.fields);
            setSaveError("INVALID_INPUT");
          } else {
            setSaveError(result.error);
          }
          return;
        }

        completedRef.current = true;
        clearProductFormDraft(window.localStorage, draftKey);
        writeLastCategory(
          window.localStorage,
          lastCategoryStorageKey,
          result.categoryId,
        );
        window.sessionStorage.setItem("rabet:merchant-product-created", "1");
        router.push("/app/products");
      } catch {
        setSaveError("UNAVAILABLE");
      } finally {
        if (!completedRef.current) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    });
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-product-create-page"
      data-hydrated={hydrated ? "true" : "false"}
    >
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Logo className="text-lg" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <MerchantLanguageToggle
              locale={locale}
              onChange={setLocale}
              label={copy.languageLabel}
            />
            <MerchantLogoutButton label={copy.logout} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-5 px-4 py-8">
        <div className="space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
          <p className="break-words text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{copy.storeLabel}:</span>{" "}
            <span data-testid="merchant-product-create-store-name">
              {storeName}
            </span>
          </p>
        </div>

        {readOnly ? (
          <>
            <div
              role="status"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              data-testid="merchant-product-create-suspended-notice"
            >
              <p className="font-semibold">{copy.suspendedTitle}</p>
              <p className="mt-1">{copy.suspendedBody}</p>
            </div>
            <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
              <Link href="/app/products" data-testid="merchant-product-create-back">
                {copy.back}
              </Link>
            </Button>
          </>
        ) : (
          <>
            <form
              className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
              noValidate
              aria-busy={submitting}
              onSubmit={submit}
              data-testid="merchant-product-create-form"
            >
              <div className="space-y-1.5">
                <label htmlFor="merchant-product-name" className="block text-sm font-medium">
                  {copy.nameLabel}
                </label>
                <input
                  id="merchant-product-name"
                  name="name"
                  type="text"
                  autoComplete="off"
                  maxLength={255}
                  value={name}
                  readOnly={submitting}
                  onChange={(event) => {
                    setName(event.target.value);
                    setFieldErrors((current) => ({ ...current, name: false }));
                    setSaveError(null);
                  }}
                  aria-invalid={fieldErrors.name ? "true" : undefined}
                  aria-describedby={fieldErrors.name ? "merchant-product-name-error" : undefined}
                  placeholder={copy.namePlaceholder}
                  data-testid="merchant-product-name"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                {fieldErrors.name ? (
                  <p id="merchant-product-name-error" role="alert" className="text-sm text-destructive" data-testid="merchant-product-name-error">
                    {copy.requiredName}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="merchant-product-price" className="block text-sm font-medium">
                  {copy.priceLabel}
                </label>
                <input
                  id="merchant-product-price"
                  name="price"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={32}
                  value={price}
                  readOnly={submitting}
                  onChange={(event) => {
                    setPrice(event.target.value);
                    setFieldErrors((current) => ({ ...current, price: false }));
                    setSaveError(null);
                  }}
                  aria-invalid={fieldErrors.price ? "true" : undefined}
                  aria-describedby={fieldErrors.price ? "merchant-product-price-error" : undefined}
                  placeholder={copy.pricePlaceholder}
                  data-testid="merchant-product-price"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-48"
                />
                {fieldErrors.price ? (
                  <p id="merchant-product-price-error" role="alert" className="text-sm text-destructive" data-testid="merchant-product-price-error">
                    {copy.invalidPrice}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="merchant-product-category" className="block text-sm font-medium">
                  {copy.categoryLabel}
                </label>
                <select
                  id="merchant-product-category"
                  name="categoryId"
                  value={categoryId}
                  disabled={submitting}
                  onChange={(event) => {
                    setCategoryId(event.target.value);
                    setFieldErrors((current) => ({ ...current, category: false }));
                    setSaveError(null);
                  }}
                  aria-invalid={fieldErrors.category ? "true" : undefined}
                  aria-describedby={fieldErrors.category ? "merchant-product-category-error" : undefined}
                  data-testid="merchant-product-category"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  {categories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                  <option value="">{copy.newCategoryOption}</option>
                </select>
                {fieldErrors.category ? (
                  <p id="merchant-product-category-error" role="alert" className="text-sm text-destructive" data-testid="merchant-product-category-error">
                    {copy.requiredCategory}
                  </p>
                ) : null}
                {categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{copy.noCategories}</p>
                ) : null}
              </div>

              {useNewCategory ? (
                <div className="space-y-1.5">
                  <label htmlFor="merchant-product-new-category" className="block text-sm font-medium">
                    {copy.newCategoryLabel}
                  </label>
                  <input
                    id="merchant-product-new-category"
                    name="newCategoryName"
                    type="text"
                    autoComplete="off"
                    maxLength={255}
                    value={newCategoryName}
                    readOnly={submitting}
                    onChange={(event) => {
                      setNewCategoryName(event.target.value);
                      setFieldErrors((current) => ({ ...current, newCategoryName: false }));
                      setSaveError(null);
                    }}
                    aria-invalid={fieldErrors.newCategoryName ? "true" : undefined}
                    aria-describedby={fieldErrors.newCategoryName ? "merchant-product-new-category-error" : undefined}
                    placeholder={copy.newCategoryPlaceholder}
                    data-testid="merchant-product-new-category"
                    className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  {fieldErrors.newCategoryName ? (
                    <p id="merchant-product-new-category-error" role="alert" className="text-sm text-destructive" data-testid="merchant-product-new-category-error">
                      {copy.requiredCategoryName}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground">{copy.draftNote}</p>

              {saveError ? (
                <p
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                  data-testid="merchant-product-create-error"
                >
                  {errorMessage(saveError, copy)}
                </p>
              ) : null}

              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  type="submit"
                  className="min-h-11 w-full sm:w-auto"
                  disabled={submitting}
                  data-testid="merchant-product-submit"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      {copy.saving}
                    </>
                  ) : (
                    <>
                      <Save className="size-4" aria-hidden="true" />
                      {copy.save}
                    </>
                  )}
                </Button>
                <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
                  <Link href="/app/products" data-testid="merchant-product-create-back">
                    {copy.back}
                  </Link>
                </Button>
              </div>
            </form>

          </>
        )}
      </main>
    </div>
  );
}
