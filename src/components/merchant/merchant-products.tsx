"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";

import {
  publishMerchantProduct,
  saveMerchantProductAvailability,
  saveMerchantProductPrice,
} from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type MerchantProductItem = {
  id: string;
  name: string;
  price: string;
  revision: string;
  isActive: boolean;
  categoryPathVisible: boolean;
  imageUrl: string | null;
  available: number;
};

type PriceDraft = {
  value: string;
  baseRevision: string;
  dirty: boolean;
};

type PriceConflict = {
  price: string;
  revision: string;
};

type AvailabilityState = {
  isActive: boolean;
  revision: string;
};

function availabilityViewFor(
  product: MerchantProductItem,
  overrides: Record<string, AvailabilityState>,
  conflicts: Record<string, AvailabilityState | undefined>,
): AvailabilityState {
  let latest: AvailabilityState = {
    isActive: product.isActive,
    revision: product.revision,
  };

  for (const entry of [overrides[product.id], conflicts[product.id]]) {
    if (entry && entry.revision >= latest.revision) {
      latest = entry;
    }
  }

  return latest;
}

function draftViewFor(
  product: MerchantProductItem,
  drafts: Record<string, PriceDraft>,
): PriceDraft {
  const entry = drafts[product.id];

  if (entry) {
    // A dirty draft always wins. A clean overlay is an adopted or confirmed
    // server value and remains visible until props deliver a newer revision.
    // Canonical UTC revisions sort lexicographically.
    if (entry.dirty || entry.baseRevision >= product.revision) {
      return entry;
    }
  }

  return {
    value: product.price,
    baseRevision: product.revision,
    dirty: false,
  };
}

type PriceError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_PRICE"
  | "INVALID_REVISION";

type AvailabilityError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_REVISION";

type PublishReason =
  | "NAME_MISSING"
  | "PRICE_MISSING"
  | "CATEGORY_NOT_ELIGIBLE"
  | "OUT_OF_STOCK"
  | "NO_PAYMENT_METHOD"
  | "DELIVERY_FEE_NOT_CONFIGURED"
  | "STORE_BOT_NOT_CONNECTED";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  productsLabel: string;
  draftStatus: string;
  priceLabel: string;
  save: string;
  saving: string;
  saved: string;
  emptyTitle: string;
  emptyBody: string;
  suspendedTitle: string;
  suspendedBody: string;
  setupLink: string;
  categoriesLink: string;
  manageCategories: string;
  ordersLink: string;
  addProduct: string;
  addFirstProduct: string;
  createdNotice: string;
  logout: string;
  languageLabel: string;
  invalidPrice: string;
  invalidRevision: string;
  notFound: string;
  denied: string;
  unavailable: string;
  conflictTitle: string;
  conflictBody: string;
  latestPriceLabel: string;
  useLatestPrice: string;
  retryMyPrice: string;
  availableInCatalog: string;
  availabilityOnCategoryHidden: string;
  publishedStatus: string;
  inStockLabel: string;
  outOfStock: string;
  preview: string;
  edit: string;
  publish: string;
  publishing: string;
  publishSaved: string;
  publishNotReadyTitle: string;
  publishReasons: Record<PublishReason, string>;
  makeAvailable: string;
  stopAvailability: string;
  availabilitySaved: string;
  savingAvailability: string;
  inactiveCategoryWarning: string;
  availabilityInvalidInput: string;
  availabilityConflictTitle: string;
  availabilityConflictBody: string;
  latestAvailabilityLabel: string;
  availableState: string;
  unavailableState: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "منتجات المتجر",
    subtitle: "راجع منتجات متجرك وحدّث سعر كل منتج.",
    storeLabel: "المتجر",
    productsLabel: "المنتجات",
    draftStatus: "مسودة",
    priceLabel: "السعر",
    save: "حفظ السعر",
    saving: "جارٍ حفظ السعر…",
    saved: "تم حفظ السعر.",
    emptyTitle: "لا توجد منتجات بعد",
    emptyBody: "ستظهر منتجات متجرك هنا عند إضافتها.",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على الأسعار فقط. التعديلات غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
    setupLink: "إعداد المتجر",
    categoriesLink: "الأقسام",
    manageCategories: "إدارة الأقسام",
    ordersLink: "طلبات الدفع عند الاستلام",
    addProduct: "إضافة منتج",
    addFirstProduct: "إضافة أول منتج",
    createdNotice: "تمت إضافة المنتج.",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    invalidPrice: "أدخل سعرًا صالحًا من رقمين عشريين على الأكثر.",
    invalidRevision: "تعذر التحقق من نسخة السعر. أعد تحميل الصفحة.",
    notFound: "تعذر العثور على هذا المنتج في متجرك.",
    denied: "لم تعد تملك صلاحية تعديل هذا المتجر.",
    unavailable: "تعذر حفظ السعر الآن. حاول مرة أخرى بعد قليل.",
    conflictTitle: "حفظ جهاز آخر سعرًا أحدث.",
    conflictBody:
      "لم يُحفظ سعرك حتى لا يستبدل السعر الأحدث. راجع السعر الأخير ثم اختر كيف تريد المتابعة.",
    latestPriceLabel: "أحدث سعر محفوظ",
    useLatestPrice: "استخدام أحدث سعر",
    retryMyPrice: "إعادة المحاولة بسعري",
    availableInCatalog: "متاح في الكتالوج",
    availabilityOnCategoryHidden: "الإتاحة مفعّلة",
    publishedStatus: "منشور",
    inStockLabel: "متوفر",
    outOfStock: "غير متوفر حاليًا",
    preview: "معاينة",
    edit: "تعديل",
    publish: "نشر المنتج",
    publishing: "جارٍ النشر…",
    publishSaved: "تم نشر المنتج.",
    publishNotReadyTitle: "المنتج غير جاهز للنشر بعد:",
    publishReasons: {
      NAME_MISSING: "اسم المنتج غير محفوظ.",
      PRICE_MISSING: "سعر المنتج غير صالح.",
      CATEGORY_NOT_ELIGIBLE: "القسم أو أحد أقسامه الأعلى غير متاح.",
      OUT_OF_STOCK: "لا يوجد مخزون متاح. أضف مخزونًا من صفحة التعديل.",
      NO_PAYMENT_METHOD:
        "لا توجد طريقة دفع جاهزة. فعّل الدفع عند الاستلام أو فودافون كاش من إعداد المتجر.",
      DELIVERY_FEE_NOT_CONFIGURED:
        "لم تُحدَّد رسوم التوصيل. احفظ 0.00 للتوصيل المجاني صراحةً من إعداد المتجر.",
      STORE_BOT_NOT_CONNECTED: "بوت المتجر غير متصل بعد.",
    },
    makeAvailable: "إتاحة المنتج",
    stopAvailability: "إيقاف الإتاحة",
    availabilitySaved: "تم حفظ حالة الإتاحة.",
    savingAvailability: "جارٍ حفظ الإتاحة…",
    inactiveCategoryWarning:
      "القسم غير متاح أو أن أحد أقسامه الأعلى غير متاح، لذلك يبقى المنتج مخفيًا عن العملاء حتى يتاح مسار القسم بالكامل.",
    availabilityInvalidInput: "تعذر قراءة حالة الإتاحة. أعد المحاولة.",
    availabilityConflictTitle: "حفظ جهاز آخر تغييرًا أحدث.",
    availabilityConflictBody:
      "لم تُحفظ حالة الإتاحة حتى لا تستبدل التغيير الأحدث. راجع الحالة الأخيرة ثم اختر إتاحة المنتج أو إيقاف الإتاحة من جديد.",
    latestAvailabilityLabel: "أحدث حالة محفوظة",
    availableState: "متاح",
    unavailableState: "غير متاح",
  },
  en: {
    dir: "ltr",
    title: "Store products",
    subtitle: "Review your store products and update each product price.",
    storeLabel: "Store",
    productsLabel: "Products",
    draftStatus: "Draft",
    priceLabel: "Price",
    save: "Save price",
    saving: "Saving price…",
    saved: "Price saved.",
    emptyTitle: "No products yet",
    emptyBody: "Your store products will appear here after they are added.",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review prices only. Editing is unavailable until a platform administrator reactivates the store.",
    setupLink: "Store setup",
    categoriesLink: "Categories",
    manageCategories: "Manage categories",
    ordersLink: "COD orders",
    addProduct: "Add product",
    addFirstProduct: "Add first product",
    createdNotice: "Product added.",
    logout: "Sign out",
    languageLabel: "Page language",
    invalidPrice: "Enter a valid price with no more than two decimal places.",
    invalidRevision: "The price revision could not be checked. Reload the page.",
    notFound: "This product could not be found in your store.",
    denied: "You can no longer edit this store.",
    unavailable: "The price could not be saved right now. Try again shortly.",
    conflictTitle: "Another device saved a newer price.",
    conflictBody:
      "Your price was not saved so it could not replace the newer price. Review the latest price, then choose how to continue.",
    latestPriceLabel: "Latest saved price",
    useLatestPrice: "Use latest price",
    retryMyPrice: "Retry my price",
    availableInCatalog: "Available in the catalog",
    availabilityOnCategoryHidden: "Availability is on",
    publishedStatus: "Published",
    inStockLabel: "In stock",
    outOfStock: "Currently out of stock",
    preview: "Preview",
    edit: "Edit",
    publish: "Publish product",
    publishing: "Publishing…",
    publishSaved: "Product published.",
    publishNotReadyTitle: "The product is not ready to publish yet:",
    publishReasons: {
      NAME_MISSING: "The product name is missing.",
      PRICE_MISSING: "The product price is not valid.",
      CATEGORY_NOT_ELIGIBLE:
        "The category or one of its parent categories is unavailable.",
      OUT_OF_STOCK: "No stock is available. Add stock from the edit page.",
      NO_PAYMENT_METHOD:
        "No payment method is ready. Enable cash on delivery or Vodafone Cash in Store setup.",
      DELIVERY_FEE_NOT_CONFIGURED:
        "The delivery fee is not configured. Save 0.00 for explicit free delivery in Store setup.",
      STORE_BOT_NOT_CONNECTED: "The store bot is not connected yet.",
    },
    makeAvailable: "Make product available",
    stopAvailability: "Stop availability",
    availabilitySaved: "Availability saved.",
    savingAvailability: "Saving availability…",
    inactiveCategoryWarning:
      "This category or one of its parent categories is unavailable, so the product stays hidden from customers until the full category path is available.",
    availabilityInvalidInput: "The availability state could not be read. Try again.",
    availabilityConflictTitle: "Another device saved a newer change.",
    availabilityConflictBody:
      "Your availability change was not saved so it could not replace the newer change. Review the latest state, then choose make product available or stop availability again.",
    latestAvailabilityLabel: "Latest saved state",
    availableState: "Available",
    unavailableState: "Unavailable",
  },
};

function errorMessage(error: PriceError, copy: Copy): string {
  switch (error) {
    case "INVALID_PRICE":
      return copy.invalidPrice;
    case "INVALID_REVISION":
      return copy.invalidRevision;
    case "NOT_FOUND":
      return copy.notFound;
    case "DENIED":
      return copy.denied;
    case "UNAVAILABLE":
      return copy.unavailable;
  }
}

function availabilityErrorMessage(error: AvailabilityError, copy: Copy): string {
  switch (error) {
    case "INVALID_INPUT":
      return copy.availabilityInvalidInput;
    case "INVALID_REVISION":
      return copy.invalidRevision;
    case "NOT_FOUND":
      return copy.notFound;
    case "DENIED":
      return copy.denied;
    case "UNAVAILABLE":
      return copy.unavailable;
  }
}

export function MerchantProducts({
  storeName,
  readOnly,
  products,
  initialLocale,
  codOrdersEnabled,
}: {
  storeName: string;
  readOnly: boolean;
  products: MerchantProductItem[];
  initialLocale: MerchantLocale;
  codOrdersEnabled: boolean;
}) {
  const [locale, setLocale] = useMerchantLocale(initialLocale, "products");
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [errors, setErrors] = useState<Record<string, PriceError | undefined>>(
    {},
  );
  const [conflicts, setConflicts] = useState<
    Record<string, PriceConflict | undefined>
  >({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [availabilityOverrides, setAvailabilityOverrides] = useState<
    Record<string, AvailabilityState>
  >({});
  const [availabilityErrors, setAvailabilityErrors] = useState<
    Record<string, AvailabilityError | undefined>
  >({});
  const [availabilityConflicts, setAvailabilityConflicts] = useState<
    Record<string, AvailabilityState | undefined>
  >({});
  const [availabilitySavedId, setAvailabilitySavedId] = useState<string | null>(
    null,
  );
  const [publishReasons, setPublishReasons] = useState<
    Record<string, PublishReason[] | undefined>
  >({});
  const [publishSavedId, setPublishSavedId] = useState<string | null>(null);
  const [createdNotice, setCreatedNotice] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [availabilityPendingId, setAvailabilityPendingId] = useState<
    string | null
  >(null);
  const pendingRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = COPY[locale];
  const saving =
    isPending || pendingId !== null || availabilityPendingId !== null;
  const [publishingId, setPublishingId] = useState<string | null>(null);

  useEffect(() => {
    let created = false;

    try {
      if (window.location.hash === "#product-created") {
        created = true;
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      }
    } catch {}

    queueMicrotask(() => {
      setHydrated(true);
      if (created) setCreatedNotice(true);
    });
  }, []);

  function savePrice(
    product: MerchantProductItem,
    draft: string,
    expectedRevision: string,
  ) {
    // The ref is set synchronously, before React can render the pending state,
    // so two rapid submissions in the same task can never start two writes.
    if (readOnly || pendingRef.current !== null) return;

    const productId = product.id;
    pendingRef.current = productId;

    setErrors((current) => ({ ...current, [productId]: undefined }));
    setConflicts((current) => ({ ...current, [productId]: undefined }));
    setSavedId(null);
    setPendingId(productId);

    startTransition(async () => {
      try {
        const result = await saveMerchantProductPrice({
          productId,
          price: draft,
          revision: expectedRevision,
        });

        if (result.ok) {
          // Keep the server canonical price visible during the immediate
          // result handoff. It is only an override while the row's server
          // revision is unchanged, so a later scoped refresh always wins.
          setDrafts((current) => ({
            ...current,
            [result.productId]: {
              value: result.price,
              baseRevision: expectedRevision,
              dirty: false,
            },
          }));
          setSavedId(result.productId);
        } else if (result.error === "CONFLICT") {
          setConflicts((current) => ({
            ...current,
            [productId]: result.current,
          }));
        } else {
          setErrors((current) => ({
            ...current,
            [productId]: result.error,
          }));
        }
      } catch {
        setErrors((current) => ({
          ...current,
          [productId]: "UNAVAILABLE",
        }));
      } finally {
        pendingRef.current = null;
        setPendingId(null);
      }
    });
  }

  function saveAvailability(
    product: MerchantProductItem,
    desiredIsActive: boolean,
    expectedRevision: string,
  ) {
    if (readOnly || pendingRef.current !== null) return;

    const productId = product.id;
    pendingRef.current = productId;

    setAvailabilityErrors((current) => ({
      ...current,
      [productId]: undefined,
    }));
    setAvailabilitySavedId(null);
    setAvailabilityPendingId(productId);

    startTransition(async () => {
      try {
        const result = await saveMerchantProductAvailability({
          productId,
          isActive: desiredIsActive,
          revision: expectedRevision,
        });

        if (result.ok) {
          setAvailabilityOverrides((current) => ({
            ...current,
            [result.productId]: {
              isActive: result.isActive,
              revision: result.revision,
            },
          }));
          setAvailabilityConflicts((current) => ({
            ...current,
            [productId]: undefined,
          }));
          setAvailabilitySavedId(result.productId);
        } else if (result.error === "CONFLICT") {
          setAvailabilityConflicts((current) => {
            const existing = current[productId];

            if (existing && existing.revision > result.current.revision) {
              return current;
            }

            return {
              ...current,
              [productId]: result.current,
            };
          });
        } else if (result.error === "NOT_READY") {
          setAvailabilityErrors((current) => ({
            ...current,
            [productId]: "UNAVAILABLE",
          }));
        } else {
          setAvailabilityErrors((current) => ({
            ...current,
            [productId]: result.error,
          }));
        }
      } catch {
        setAvailabilityErrors((current) => ({
          ...current,
          [productId]: "UNAVAILABLE",
        }));
      } finally {
        pendingRef.current = null;
        setAvailabilityPendingId(null);
      }
    });
  }

  function publishProduct(
    product: MerchantProductItem,
    expectedRevision: string,
  ) {
    if (readOnly || pendingRef.current !== null) return;

    const productId = product.id;
    pendingRef.current = productId;

    setAvailabilityErrors((current) => ({
      ...current,
      [productId]: undefined,
    }));
    setAvailabilityConflicts((current) => ({
      ...current,
      [productId]: undefined,
    }));
    setPublishReasons((current) => ({ ...current, [productId]: undefined }));
    setPublishSavedId(null);
    setPublishingId(productId);

    startTransition(async () => {
      try {
        const result = await publishMerchantProduct({
          productId,
          revision: expectedRevision,
        });

        if (result.ok) {
          setAvailabilityOverrides((current) => ({
            ...current,
            [result.productId]: {
              isActive: true,
              revision: result.revision,
            },
          }));
          setPublishSavedId(result.productId);
        } else if (result.error === "NOT_READY") {
          setPublishReasons((current) => ({
            ...current,
            [productId]: result.reasons,
          }));
        } else if (result.error === "CONFLICT") {
          setAvailabilityConflicts((current) => ({
            ...current,
            [productId]: result.current,
          }));
        } else {
          setAvailabilityErrors((current) => ({
            ...current,
            [productId]: result.error,
          }));
        }
      } catch {
        setAvailabilityErrors((current) => ({
          ...current,
          [productId]: "UNAVAILABLE",
        }));
      } finally {
        pendingRef.current = null;
        setPublishingId(null);
      }
    });
  }

  function submitPrice(
    event: React.FormEvent<HTMLFormElement>,
    product: MerchantProductItem,
    draft: PriceDraft,
  ) {
    event.preventDefault();

    savePrice(product, draft.value, draft.baseRevision);
  }

  function adoptLatestPrice(product: MerchantProductItem) {
    const conflict = conflicts[product.id];

    if (!conflict) return;

    setDrafts((current) => ({
      ...current,
      [product.id]: {
        value: conflict.price,
        baseRevision: conflict.revision,
        dirty: false,
      },
    }));
    setConflicts((current) => ({ ...current, [product.id]: undefined }));
    setErrors((current) => ({ ...current, [product.id]: undefined }));
    setSavedId(null);
  }

  function retryDraft(product: MerchantProductItem, draft: string) {
    const conflict = conflicts[product.id];

    if (!conflict) return;

    savePrice(product, draft, conflict.revision);
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-products-page"
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              {copy.title}
            </h1>
            <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
            <p className="break-words text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {copy.storeLabel}:
              </span>{" "}
              <span data-testid="merchant-products-store-name">
                {storeName}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {readOnly ? null : (
              <Button asChild className="min-h-11">
                <Link href="/app/products/new" data-testid="merchant-add-product-link">
                  {copy.addProduct}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/app/categories" data-testid="merchant-categories-link">
                {copy.categoriesLink}
              </Link>
            </Button>
            {codOrdersEnabled ? (
              <Button asChild variant="outline" className="min-h-11">
                <Link href="/app/orders" data-testid="merchant-orders-link">
                  {copy.ordersLink}
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/app/setup" data-testid="merchant-setup-link">
                {copy.setupLink}
              </Link>
            </Button>
          </div>
        </div>

        {readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="merchant-products-suspended-notice"
          >
            <p className="font-semibold">{copy.suspendedTitle}</p>
            <p className="mt-1">{copy.suspendedBody}</p>
          </div>
        ) : null}

        {createdNotice ? (
          <p
            role="status"
            className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100"
            data-testid="merchant-product-created-notice"
          >
            {copy.createdNotice}
          </p>
        ) : null}

        <section className="space-y-3" aria-label={copy.productsLabel}>
          <h2 className="font-heading text-lg font-semibold">
            {copy.productsLabel}
          </h2>

          {products.length === 0 ? (
            <div
              className="rounded-xl border border-border bg-muted/30 p-5 text-center"
              data-testid="merchant-products-empty"
            >
              <p className="font-medium">{copy.emptyTitle}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.emptyBody}
              </p>
              {readOnly ? null : (
                <Button asChild className="mt-4 min-h-11">
                  <Link href="/app/products/new" data-testid="merchant-add-first-product-link">
                    {copy.addFirstProduct}
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              {products.map((product) => {
                const inputId = `merchant-price-${product.id}`;
                const errorId = `merchant-price-error-${product.id}`;
                const error = errors[product.id];
                const conflict = conflicts[product.id];
                const availabilityError = availabilityErrors[product.id];
                const availabilityConflict = availabilityConflicts[product.id];
                const availability = availabilityViewFor(
                  product,
                  availabilityOverrides,
                  availabilityConflicts,
                );
                const rowSavingPrice = pendingId === product.id;
                const rowSavingAvailability =
                  availabilityPendingId === product.id;
                const rowPublishing = publishingId === product.id;
                const rowSaving =
                  rowSavingPrice || rowSavingAvailability || rowPublishing;
                const draft = draftViewFor(product, drafts);
                const reasons = publishReasons[product.id];
                const publishDisabled =
                  saving ||
                  rowPublishing ||
                  (!availabilityConflict && availability.isActive);
                const disableDisabled =
                  saving ||
                  (!availabilityConflict && !availability.isActive);

                return (
                  <li
                    key={product.id}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm"
                    data-testid="merchant-product-row"
                    data-product-id={product.id}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className="break-words font-heading text-base font-semibold"
                        data-testid={`merchant-product-name-${product.id}`}
                      >
                        {product.name}
                      </h3>
                      {availability.isActive ? (
                        <span
                          className="text-sm font-medium text-emerald-700 dark:text-emerald-300"
                          data-testid={`merchant-product-available-${product.id}`}
                        >
                          {product.categoryPathVisible
                            ? copy.availableInCatalog
                            : copy.availabilityOnCategoryHidden}
                        </span>
                      ) : (
                        <Badge
                          variant="outline"
                          data-testid={`merchant-product-status-${product.id}`}
                          data-status="draft"
                        >
                          {copy.draftStatus}
                        </Badge>
                      )}
                      <span
                        className={
                          product.available > 0
                            ? "text-sm text-muted-foreground"
                            : "text-sm font-medium text-destructive"
                        }
                        data-testid={`merchant-product-stock-${product.id}`}
                      >
                        {product.available > 0
                          ? `${copy.inStockLabel}: ${product.available}`
                          : copy.outOfStock}
                      </span>
                    </div>

                    {product.categoryPathVisible ? null : (
                      <div
                        role="status"
                        className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                        data-testid={`merchant-product-category-inactive-${product.id}`}
                      >
                        <p>{copy.inactiveCategoryWarning}</p>
                        {readOnly ? null : (
                          <Link
                            href="/app/categories"
                            className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                            data-testid={`merchant-product-category-manage-${product.id}`}
                          >
                            {copy.manageCategories}
                          </Link>
                        )}
                      </div>
                    )}

                    {readOnly ? (
                      <div className="mt-2 flex flex-wrap items-baseline gap-2 text-sm">
                        <span className="text-muted-foreground">
                          {copy.priceLabel}
                        </span>
                        <span
                          dir="ltr"
                          className="font-medium tabular-nums"
                          data-testid={`merchant-product-price-${product.id}`}
                        >
                          {product.price}
                        </span>
                      </div>
                    ) : (
                      <form
                        className="mt-3 space-y-2"
                        noValidate
                        aria-busy={rowSaving}
                        onSubmit={(event) =>
                          submitPrice(event, product, draft)
                        }
                      >
                        <label
                          htmlFor={inputId}
                          className="block text-sm font-medium text-foreground"
                        >
                          {copy.priceLabel}
                        </label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            id={inputId}
                            name="price"
                            type="text"
                            inputMode="decimal"
                            dir="ltr"
                            autoComplete="off"
                            spellCheck={false}
                            value={draft.value}
                            readOnly={rowSaving}
                            onChange={(event) => {
                              if (pendingRef.current === product.id) return;

                              const value = event.target.value;

                              setDrafts((current) => {
                                const existing = current[product.id];

                                return {
                                  ...current,
                                  [product.id]: {
                                    value,
                                    baseRevision:
                                      existing?.dirty === true
                                        ? existing.baseRevision
                                        : draft.baseRevision,
                                    dirty: true,
                                  },
                                };
                              });
                              setSavedId(null);
                              setErrors((current) => ({
                                ...current,
                                [product.id]: undefined,
                              }));
                            }}
                            aria-invalid={error ? "true" : undefined}
                            aria-describedby={error ? errorId : undefined}
                            data-testid={`merchant-price-input-${product.id}`}
                            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground read-only:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-48"
                          />
                          <Button
                            type="submit"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={saving}
                            data-testid={`merchant-price-save-${product.id}`}
                          >
                            {rowSavingPrice ? (
                              <>
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                                {copy.saving}
                              </>
                            ) : (
                              <>
                                <Save className="size-4" aria-hidden="true" />
                                {copy.save}
                              </>
                            )}
                          </Button>
                        </div>
                      </form>
                    )}

                    {error ? (
                      <p
                        id={errorId}
                        role="alert"
                        className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                        data-testid={`merchant-price-error-${product.id}`}
                      >
                        {errorMessage(error, copy)}
                      </p>
                    ) : null}

                    {conflict ? (
                      <div
                        role="alert"
                        className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                        data-testid={`merchant-price-conflict-${product.id}`}
                      >
                        <p className="font-semibold">{copy.conflictTitle}</p>
                        <p>{copy.conflictBody}</p>
                        <p className="flex flex-wrap items-baseline gap-2">
                          <span>{copy.latestPriceLabel}:</span>
                          <span
                            dir="ltr"
                            className="font-semibold tabular-nums"
                            data-testid={`merchant-price-conflict-latest-${product.id}`}
                          >
                            {conflict.price}
                          </span>
                        </p>
                        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={saving}
                            onClick={() => adoptLatestPrice(product)}
                            data-testid={`merchant-price-use-latest-${product.id}`}
                          >
                            {copy.useLatestPrice}
                          </Button>
                          <Button
                            type="button"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={saving}
                            onClick={() => retryDraft(product, draft.value)}
                            data-testid={`merchant-price-retry-${product.id}`}
                          >
                            {copy.retryMyPrice}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {savedId === product.id ? (
                      <p
                        role="status"
                        className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300"
                        data-testid={`merchant-price-saved-${product.id}`}
                      >
                        {copy.saved}
                      </p>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
                        <Link
                          href={`/app/products/${product.id}/preview`}
                          data-testid={`merchant-product-preview-${product.id}`}
                        >
                          {copy.preview}
                        </Link>
                      </Button>
                      <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
                        <Link
                          href={`/app/products/${product.id}/edit`}
                          data-testid={`merchant-product-edit-${product.id}`}
                        >
                          {copy.edit}
                        </Link>
                      </Button>
                    </div>

                    {readOnly ? null : (
                      <div className="mt-3 space-y-2 border-t border-border pt-3">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          {availability.isActive ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={disableDisabled}
                            aria-busy={rowSavingAvailability}
                            onClick={() =>
                              saveAvailability(
                                product,
                                false,
                                availability.revision,
                              )
                            }
                            data-testid={`merchant-availability-disable-${product.id}`}
                          >
                            {rowSavingAvailability && availability.isActive ? (
                              <>
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                                {copy.savingAvailability}
                              </>
                            ) : (
                              copy.stopAvailability
                            )}
                          </Button>
                          ) : (
                          <Button
                            type="button"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={publishDisabled}
                            aria-busy={rowPublishing}
                            onClick={() =>
                              publishProduct(product, availability.revision)
                            }
                            data-testid={`merchant-availability-enable-${product.id}`}
                          >
                            {rowPublishing ? (
                              <>
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                                {copy.publishing}
                              </>
                            ) : (
                              copy.publish
                            )}
                          </Button>
                          )}
                        </div>

                        {reasons ? (
                          <div
                            role="alert"
                            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                            data-testid={`merchant-product-publish-not-ready-${product.id}`}
                          >
                            <p className="font-semibold">
                              {copy.publishNotReadyTitle}
                            </p>
                            <ul className="mt-1 list-inside list-disc space-y-1">
                              {reasons.map((reason) => (
                                <li key={reason}>{copy.publishReasons[reason]}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {availabilityError ? (
                          <p
                            role="alert"
                            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                            data-testid={`merchant-availability-error-${product.id}`}
                          >
                            {availabilityErrorMessage(availabilityError, copy)}
                          </p>
                        ) : null}

                        {availabilityConflict ? (
                          <div
                            role="alert"
                            className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                            data-testid={`merchant-availability-conflict-${product.id}`}
                          >
                            <p className="font-semibold">
                              {copy.availabilityConflictTitle}
                            </p>
                            <p>{copy.availabilityConflictBody}</p>
                            <p className="flex flex-wrap items-baseline gap-2">
                              <span>{copy.latestAvailabilityLabel}:</span>
                              <span
                                className="font-semibold"
                                data-testid={`merchant-availability-conflict-latest-${product.id}`}
                              >
                                {availability.isActive
                                  ? copy.availableState
                                  : copy.unavailableState}
                              </span>
                            </p>
                          </div>
                        ) : null}

                        {availabilitySavedId === product.id ? (
                          <p
                            role="status"
                            className="text-sm font-medium text-emerald-700 dark:text-emerald-300"
                            data-testid={`merchant-availability-saved-${product.id}`}
                          >
                            {copy.availabilitySaved}
                          </p>
                        ) : null}

                        {publishSavedId === product.id ? (
                          <p
                            role="status"
                            className="text-sm font-medium text-emerald-700 dark:text-emerald-300"
                            data-testid={`merchant-product-published-${product.id}`}
                          >
                            {copy.publishSaved}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
