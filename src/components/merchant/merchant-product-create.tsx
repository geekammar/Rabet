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
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { Button } from "@/components/ui/button";
import {
  clearProductFormDraft,
  lastCategoryKey,
  productFormDraftKey,
  readLastCategory,
  readProductFormDraft,
  restoreProductFormDraft,
  writeLastCategory,
  writeProductFormDraft,
  type DraftStorage,
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
  descriptionLabel: string;
  descriptionPlaceholder: string;
  imageLabel: string;
  imagePlaceholder: string;
  imageHint: string;
  stockLabel: string;
  stockPlaceholder: string;
  stockHint: string;
  invalidDescription: string;
  invalidImage: string;
  invalidStock: string;
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
  languageUnavailable: string;
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
    descriptionLabel: "وصف المنتج",
    descriptionPlaceholder: "وصف قصير يظهر للعميل مع المنتج.",
    imageLabel: "رابط صورة المنتج",
    imagePlaceholder: "https://example.com/product.jpg",
    imageHint: "رابط صورة واحد اختياري. يمكنك تركه فارغًا.",
    stockLabel: "المخزون الأولي",
    stockPlaceholder: "مثال: 10",
    stockHint: "عدد القطع المتاحة للبيع. اتركه فارغًا لإضافته لاحقًا.",
    invalidDescription: "أدخل وصفًا لا يتجاوز 4096 حرفًا.",
    invalidImage: "أدخل رابط صورة صالحًا يبدأ بـ http أو https.",
    invalidStock: "أدخل عددًا صحيحًا غير سالب للمخزون.",
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
    languageUnavailable:
      "لا توجد لغة مفعّلة جاهزة لحفظ اسم المنتج. اطلب من مسؤول المنصة تفعيل لغة الكتالوج.",
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
    descriptionLabel: "Product description",
    descriptionPlaceholder: "A short description shown with the product.",
    imageLabel: "Product image URL",
    imagePlaceholder: "https://example.com/product.jpg",
    imageHint: "One optional image URL. You can leave it empty.",
    stockLabel: "Initial stock",
    stockPlaceholder: "e.g. 10",
    stockHint: "Units available to sell. Leave empty to add later.",
    invalidDescription: "Enter a description of at most 4096 characters.",
    invalidImage: "Enter a valid image URL starting with http or https.",
    invalidStock: "Enter a whole, non-negative stock quantity.",
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
    languageUnavailable:
      "No enabled catalog language is ready for the product name. Ask a platform administrator to enable one.",
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
  description?: boolean;
  imageUrl?: boolean;
  stock?: boolean;
};

type SaveError =
  | "INVALID_INPUT"
  | "CATEGORY_NOT_FOUND"
  | "DENIED"
  | "CONFLICT"
  | "LANGUAGE_UNAVAILABLE"
  | "UNAVAILABLE";

function validCategoryId(
  candidate: string,
  categories: MerchantProductCategoryOption[],
): string | null {
  return categories.some((entry) => entry.id === candidate) ? candidate : null;
}

function draftStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function errorMessage(error: SaveError, copy: Copy): string {
  switch (error) {
    case "CATEGORY_NOT_FOUND":
      return copy.categoryNotFound;
    case "DENIED":
      return copy.denied;
    case "CONFLICT":
      return copy.conflict;
    case "LANGUAGE_UNAVAILABLE":
      return copy.languageUnavailable;
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
  languageUnavailable,
  categories,
  initialLocale,
}: {
  storeName: string;
  storeId: string;
  userId: string;
  readOnly: boolean;
  languageUnavailable: boolean;
  categories: MerchantProductCategoryOption[];
  initialLocale: MerchantLocale;
}) {
  const router = useRouter();
  const [locale, setLocale] = useMerchantLocale(initialLocale, "productCreate");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [stock, setStock] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [, startTransition] = useTransition();
  const restoredRef = useRef(false);
  const editedRef = useRef(false);
  const submittingRef = useRef(false);
  const completedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const draftKey = productFormDraftKey(storeId, userId);
  const lastCategoryStorageKey = lastCategoryKey(storeId, userId);
  const copy = COPY[locale];

  const useNewCategory = categoryId.length === 0;

  useEffect(() => {
    if (readOnly) return;

    let cancelled = false;
    const storage = draftStorage();
    const draft = storage ? readProductFormDraft(storage, draftKey) : null;
    const lastCategoryId = storage
      ? readLastCategory(storage, lastCategoryStorageKey)
      : null;

    queueMicrotask(() => {
      const restored = restoreProductFormDraft({
        draft,
        lastCategoryId,
        categories,
        alreadyRestored: restoredRef.current,
        edited: editedRef.current,
        cancelled,
      });

      if (restored) {
        setName(restored.name);
        setPrice(restored.price);
        setDescription(restored.description);
        setImageUrl(restored.imageUrl);
        setStock(restored.stock);
        setNewCategoryName(restored.newCategoryName);
        setCategoryId(restored.categoryId);
        restoredRef.current = true;
      }

      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [categories, draftKey, lastCategoryStorageKey, readOnly]);

  useEffect(() => {
    if (!hydrated || readOnly || editVersion === 0) return;

    const storage = draftStorage();
    if (!storage) return;

    const draft: ProductFormDraft = {
      name,
      price,
      categoryId,
      newCategoryName,
      useNewCategory,
      description,
      imageUrl,
      stock,
    };

    writeProductFormDraft(storage, draftKey, draft);
  }, [
    categoryId,
    description,
    draftKey,
    editVersion,
    hydrated,
    imageUrl,
    name,
    newCategoryName,
    price,
    readOnly,
    stock,
    useNewCategory,
  ]);

  function markEdited() {
    editedRef.current = true;
    setEditVersion((version) => version + 1);
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (name.trim().length === 0) errors.name = true;
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim())) errors.price = true;
    if (description.trim().length > 4096) errors.description = true;

    if (imageUrl.trim().length > 0) {
      if (imageUrl.trim().length > 2048) {
        errors.imageUrl = true;
      } else {
        try {
          const parsed = new URL(imageUrl.trim());
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            errors.imageUrl = true;
          }
        } catch {
          errors.imageUrl = true;
        }
      }
    }

    if (stock.trim().length > 0 && !/^[0-9]{1,9}$/.test(stock.trim())) {
      errors.stock = true;
    }

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
      let result: Awaited<ReturnType<typeof createMerchantProductDraft>>;

      try {
        result = await createMerchantProductDraft({
          name,
          price,
          description,
          imageUrl,
          stock,
          categoryId: useNewCategory ? "" : categoryId,
          newCategoryName: useNewCategory ? newCategoryName : "",
        });
      } catch {
        submittingRef.current = false;
        setSubmitting(false);
        setSaveError("UNAVAILABLE");
        return;
      }

      if (!result.ok) {
        submittingRef.current = false;
        setSubmitting(false);

        if (result.error === "INVALID_INPUT" && result.fields) {
          setFieldErrors(result.fields);
          setSaveError("INVALID_INPUT");
        } else {
          setSaveError(result.error);
        }
        return;
      }

      completedRef.current = true;

      try {
        const storage = draftStorage();
        if (storage) {
          clearProductFormDraft(storage, draftKey);
          writeLastCategory(storage, lastCategoryStorageKey, result.categoryId);
        }
      } catch {}

      router.push("/app/products#product-created");
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
            {languageUnavailable ? (
              <p
                role="alert"
                className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm font-medium text-destructive"
                data-testid="merchant-product-language-unavailable"
              >
                {copy.languageUnavailable}
              </p>
            ) : null}

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
                    markEdited();
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
                    markEdited();
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
                <label htmlFor="merchant-product-description" className="block text-sm font-medium">
                  {copy.descriptionLabel}
                </label>
                <textarea
                  id="merchant-product-description"
                  name="description"
                  rows={4}
                  maxLength={4096}
                  value={description}
                  readOnly={submitting}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setFieldErrors((current) => ({ ...current, description: false }));
                    setSaveError(null);
                    markEdited();
                  }}
                  aria-invalid={fieldErrors.description ? "true" : undefined}
                  placeholder={copy.descriptionPlaceholder}
                  data-testid="merchant-product-description"
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base shadow-sm outline-none placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm"
                />
                {fieldErrors.description ? (
                  <p role="alert" className="text-sm text-destructive">
                    {copy.invalidDescription}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="merchant-product-image" className="block text-sm font-medium">
                  {copy.imageLabel}
                </label>
                <input
                  id="merchant-product-image"
                  name="imageUrl"
                  type="url"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={2048}
                  value={imageUrl}
                  readOnly={submitting}
                  onChange={(event) => {
                    setImageUrl(event.target.value);
                    setFieldErrors((current) => ({ ...current, imageUrl: false }));
                    setSaveError(null);
                    markEdited();
                  }}
                  aria-invalid={fieldErrors.imageUrl ? "true" : undefined}
                  placeholder={copy.imagePlaceholder}
                  data-testid="merchant-product-image"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="text-xs text-muted-foreground">{copy.imageHint}</p>
                {fieldErrors.imageUrl ? (
                  <p role="alert" className="text-sm text-destructive">
                    {copy.invalidImage}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="merchant-product-stock" className="block text-sm font-medium">
                  {copy.stockLabel}
                </label>
                <input
                  id="merchant-product-stock"
                  name="stock"
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  autoComplete="off"
                  maxLength={9}
                  value={stock}
                  readOnly={submitting}
                  onChange={(event) => {
                    setStock(event.target.value);
                    setFieldErrors((current) => ({ ...current, stock: false }));
                    setSaveError(null);
                    markEdited();
                  }}
                  aria-invalid={fieldErrors.stock ? "true" : undefined}
                  placeholder={copy.stockPlaceholder}
                  data-testid="merchant-product-stock"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:max-w-48"
                />
                <p className="text-xs text-muted-foreground">{copy.stockHint}</p>
                {fieldErrors.stock ? (
                  <p role="alert" className="text-sm text-destructive">
                    {copy.invalidStock}
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
                    markEdited();
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
                      markEdited();
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
                  disabled={submitting || languageUnavailable}
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
