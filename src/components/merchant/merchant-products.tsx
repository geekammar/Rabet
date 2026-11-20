"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";

import { saveMerchantProductPrice } from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { Button } from "@/components/ui/button";

export type MerchantProductItem = {
  id: string;
  name: string;
  price: string;
  revision: string;
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

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  productsLabel: string;
  priceLabel: string;
  save: string;
  saving: string;
  saved: string;
  emptyTitle: string;
  emptyBody: string;
  suspendedTitle: string;
  suspendedBody: string;
  setupLink: string;
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
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "منتجات المتجر",
    subtitle: "راجع منتجات متجرك وحدّث سعر كل منتج.",
    storeLabel: "المتجر",
    productsLabel: "المنتجات",
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
  },
  en: {
    dir: "ltr",
    title: "Store products",
    subtitle: "Review your store products and update each product price.",
    storeLabel: "Store",
    productsLabel: "Products",
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

export function MerchantProducts({
  storeName,
  readOnly,
  products,
}: {
  storeName: string;
  readOnly: boolean;
  products: MerchantProductItem[];
}) {
  const [locale, setLocale] = useState<MerchantLocale>("ar");
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [errors, setErrors] = useState<Record<string, PriceError | undefined>>(
    {},
  );
  const [conflicts, setConflicts] = useState<
    Record<string, PriceConflict | undefined>
  >({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = COPY[locale];
  const saving = isPending || pendingId !== null;

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
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/app/setup" data-testid="merchant-setup-link">
              {copy.setupLink}
            </Link>
          </Button>
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
            </div>
          ) : (
            <ul className="space-y-3">
              {products.map((product) => {
                const inputId = `merchant-price-${product.id}`;
                const errorId = `merchant-price-error-${product.id}`;
                const error = errors[product.id];
                const conflict = conflicts[product.id];
                const rowSaving = pendingId === product.id;
                const draft = draftViewFor(product, drafts);

                return (
                  <li
                    key={product.id}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm"
                    data-testid="merchant-product-row"
                    data-product-id={product.id}
                  >
                    <h3
                      className="break-words font-heading text-base font-semibold"
                      data-testid={`merchant-product-name-${product.id}`}
                    >
                      {product.name}
                    </h3>

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
                            {rowSaving ? (
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
