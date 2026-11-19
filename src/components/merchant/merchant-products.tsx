"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
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
};

type PriceError = "UNAVAILABLE" | "DENIED" | "NOT_FOUND" | "INVALID_PRICE";

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
  notFound: string;
  denied: string;
  unavailable: string;
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
    notFound: "تعذر العثور على هذا المنتج في متجرك.",
    denied: "لم تعد تملك صلاحية تعديل هذا المتجر.",
    unavailable: "تعذر حفظ السعر الآن. حاول مرة أخرى بعد قليل.",
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
    notFound: "This product could not be found in your store.",
    denied: "You can no longer edit this store.",
    unavailable: "The price could not be saved right now. Try again shortly.",
  },
};

function errorMessage(error: PriceError, copy: Copy): string {
  switch (error) {
    case "INVALID_PRICE":
      return copy.invalidPrice;
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
  const [savedPrices, setSavedPrices] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, PriceError | undefined>>(
    {},
  );
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = COPY[locale];
  const saving = isPending || pendingId !== null;

  function submitPrice(
    event: React.FormEvent<HTMLFormElement>,
    productId: string,
    draft: string,
  ) {
    event.preventDefault();

    if (readOnly || saving) return;

    setErrors((current) => ({ ...current, [productId]: undefined }));
    setSavedId(null);
    setPendingId(productId);

    startTransition(async () => {
      try {
        const result = await saveMerchantProductPrice({
          productId,
          price: draft,
        });

        if (result.ok) {
          setSavedPrices((current) => ({
            ...current,
            [result.productId]: result.price,
          }));
          setDrafts((current) => ({
            ...current,
            [result.productId]: result.price,
          }));
          setSavedId(result.productId);
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
        setPendingId(null);
      }
    });
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
                const rowSaving = pendingId === product.id;
                const displayedPrice =
                  savedPrices[product.id] ?? product.price;
                const draft = drafts[product.id] ?? displayedPrice;

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
                          {displayedPrice}
                        </span>
                      </div>
                    ) : (
                      <form
                        className="mt-3 space-y-2"
                        noValidate
                        aria-busy={rowSaving}
                        onSubmit={(event) =>
                          submitPrice(event, product.id, draft)
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
                            value={draft}
                            onChange={(event) => {
                              const value = event.target.value;

                              setDrafts((current) => ({
                                ...current,
                                [product.id]: value,
                              }));
                              setSavedId(null);
                              setErrors((current) => ({
                                ...current,
                                [product.id]: undefined,
                              }));
                            }}
                            aria-invalid={error ? "true" : undefined}
                            aria-describedby={error ? errorId : undefined}
                            data-testid={`merchant-price-input-${product.id}`}
                            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-48"
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
