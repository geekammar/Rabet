"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { publishMerchantProduct } from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MerchantProductReadinessReason } from "@/lib/merchant/product-publish";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  buyerViewLabel: string;
  draftStatus: string;
  publishedStatus: string;
  inStock: string;
  outOfStock: string;
  noImage: string;
  priceLabel: string;
  descriptionFallback: string;
  detailsLabel: string;
  readinessTitle: string;
  readinessReady: string;
  readinessNotReady: string;
  publish: string;
  publishing: string;
  published: string;
  edit: string;
  back: string;
  logout: string;
  languageLabel: string;
  reasons: Record<MerchantProductReadinessReason, string>;
  publishError: string;
  conflict: string;
  notFound: string;
  denied: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "معاينة المنتج",
    subtitle: "هذه معاينة خاصة كما سيرى العميل المنتج في بوت المتجر.",
    storeLabel: "المتجر",
    buyerViewLabel: "عرض العميل",
    draftStatus: "مسودة غير منشورة",
    publishedStatus: "منشور",
    inStock: "متوفر",
    outOfStock: "غير متوفر حاليًا",
    noImage: "لا توجد صورة",
    priceLabel: "السعر",
    descriptionFallback: "لا يوجد وصف محفوظ لهذا المنتج.",
    detailsLabel: "تفاصيل المنتج",
    readinessTitle: "جاهزية النشر",
    readinessReady: "كل متطلبات النشر مستوفاة.",
    readinessNotReady: "أكمل ما يلي قبل النشر:",
    publish: "نشر المنتج",
    publishing: "جارٍ النشر…",
    published: "تم نشر المنتج.",
    edit: "تعديل المنتج",
    back: "العودة إلى المنتجات",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    reasons: {
      NAME_MISSING: "اسم المنتج غير محفوظ.",
      PRICE_MISSING: "سعر المنتج غير صالح.",
      CATEGORY_NOT_ELIGIBLE: "القسم أو أحد أقسامه الأعلى غير متاح.",
      OUT_OF_STOCK: "لا يوجد مخزون متاح. أضف مخزونًا من صفحة التعديل.",
      NO_PAYMENT_METHOD:
        "لا توجد طريقة دفع جاهزة. فعّل الدفع عند الاستلام أو فودافون كاش.",
      DELIVERY_FEE_NOT_CONFIGURED:
        "لم تُحدَّد رسوم التوصيل. احفظ 0.00 للتوصيل المجاني صراحةً.",
      STORE_BOT_NOT_CONNECTED: "بوت المتجر غير متصل بعد.",
    },
    publishError: "تعذر نشر المنتج الآن. حاول مرة أخرى بعد قليل.",
    conflict: "حُفظ تغيير أحدث من جهاز آخر. أعد تحميل الصفحة ثم حاول مجددًا.",
    notFound: "تعذر العثور على هذا المنتج في متجرك.",
    denied: "لم تعد تملك صلاحية نشر منتجات هذا المتجر.",
  },
  en: {
    dir: "ltr",
    title: "Product preview",
    subtitle: "This private preview shows the product as buyers see it in the Store Bot.",
    storeLabel: "Store",
    buyerViewLabel: "Buyer view",
    draftStatus: "Unpublished draft",
    publishedStatus: "Published",
    inStock: "In stock",
    outOfStock: "Currently out of stock",
    noImage: "No image",
    priceLabel: "Price",
    descriptionFallback: "No saved description for this product.",
    detailsLabel: "Product details",
    readinessTitle: "Publishing readiness",
    readinessReady: "Every publishing requirement is met.",
    readinessNotReady: "Complete the following before publishing:",
    publish: "Publish product",
    publishing: "Publishing…",
    published: "Product published.",
    edit: "Edit product",
    back: "Back to products",
    logout: "Sign out",
    languageLabel: "Page language",
    reasons: {
      NAME_MISSING: "The product name is missing.",
      PRICE_MISSING: "The product price is not valid.",
      CATEGORY_NOT_ELIGIBLE: "The category or one of its parent categories is unavailable.",
      OUT_OF_STOCK: "No stock is available. Add stock from the edit page.",
      NO_PAYMENT_METHOD:
        "No payment method is ready. Enable cash on delivery or Vodafone Cash.",
      DELIVERY_FEE_NOT_CONFIGURED:
        "The delivery fee is not configured. Save 0.00 for explicit free delivery.",
      STORE_BOT_NOT_CONNECTED: "The store bot is not connected yet.",
    },
    publishError: "The product could not be published right now. Try again shortly.",
    conflict: "A newer change was saved on another device. Reload and try again.",
    notFound: "This product could not be found in your store.",
    denied: "You can no longer publish products for this store.",
  },
};

export function MerchantProductPreview({
  storeName,
  readOnly,
  initialLocale,
  product,
  isActive,
  revision,
  readiness,
}: {
  storeName: string;
  readOnly: boolean;
  initialLocale: MerchantLocale;
  product: {
    id: string;
    name: string;
    description: string | null;
    details: string | null;
    price: string;
    currency: string | null;
    imageUrl: string | null;
    availability: { available: number; inStock: boolean };
  };
  isActive: boolean;
  revision: string;
  readiness: { ready: boolean; reasons: MerchantProductReadinessReason[] } | null;
}) {
  const router = useRouter();
  const [locale, setLocale] = useMerchantLocale(initialLocale, "products");
  const [message, setMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [publishedLocally, setPublishedLocally] = useState(false);
  const [isPublishing, startPublishing] = useTransition();
  const copy = COPY[locale];
  const published = isActive || publishedLocally;
  const allowedToPublish =
    !readOnly &&
    !published &&
    readiness?.ready === true &&
    !isPublishing;

  function publish() {
    if (!allowedToPublish) return;

    setMessage(null);

    startPublishing(async () => {
      let result: Awaited<ReturnType<typeof publishMerchantProduct>>;

      try {
        result = await publishMerchantProduct({
          productId: product.id,
          revision,
        });
      } catch {
        setMessage({ ok: false, text: copy.publishError });
        return;
      }

      if (result.ok) {
        setPublishedLocally(true);
        setMessage({ ok: true, text: copy.published });
        router.refresh();
        return;
      }

      setMessage({
        ok: false,
        text:
          result.error === "CONFLICT"
            ? copy.conflict
            : result.error === "NOT_FOUND"
              ? copy.notFound
              : result.error === "DENIED"
                ? copy.denied
                : copy.publishError,
      });
    });
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-product-preview-page"
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
            {storeName}
          </p>
        </div>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={published ? "default" : "outline"}>
              {published ? copy.publishedStatus : copy.draftStatus}
            </Badge>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {copy.buyerViewLabel}
            </span>
          </div>

          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt={product.name}
              className="max-h-80 w-full rounded-lg border border-border object-cover"
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 text-sm text-muted-foreground">
              {copy.noImage}
            </div>
          )}

          <h2
            className="break-words font-heading text-xl font-semibold"
            data-testid="merchant-product-preview-name"
          >
            {product.name}
          </h2>
          <p className="whitespace-pre-line text-sm text-foreground">
            {product.description || copy.descriptionFallback}
          </p>
          {product.details ? (
            <div className="space-y-1 border-t border-border pt-3">
              <h3 className="text-sm font-medium">{copy.detailsLabel}</h3>
              <p className="whitespace-pre-line text-sm text-muted-foreground">
                {product.details}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-baseline gap-3 border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">
              {copy.priceLabel}
            </span>
            <span dir="ltr" className="font-heading text-lg font-semibold tabular-nums">
              {product.price}
              {product.currency ? ` ${product.currency}` : ""}
            </span>
            <span
              className={
                product.availability.inStock
                  ? "text-sm font-medium text-emerald-700 dark:text-emerald-300"
                  : "text-sm font-medium text-destructive"
              }
            >
              {product.availability.inStock ? copy.inStock : copy.outOfStock}
            </span>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <h2 className="font-heading text-lg font-semibold">
            {copy.readinessTitle}
          </h2>

          {readiness === null ? null : readiness.ready ? (
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              {copy.readinessReady}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {copy.readinessNotReady}
              </p>
              <ul className="list-inside list-disc space-y-1 text-sm text-destructive">
                {readiness.reasons.map((reason) => (
                  <li key={reason}>{copy.reasons[reason]}</li>
                ))}
              </ul>
            </div>
          )}

          {message ? (
            <p
              role="status"
              className={`text-sm font-medium ${
                message.ok
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-destructive"
              }`}
            >
              {message.text}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {published || readOnly ? null : (
              <Button
                type="button"
                onClick={publish}
                disabled={!allowedToPublish}
                className="min-h-11 w-full sm:w-auto"
                data-testid="merchant-product-publish"
              >
                {isPublishing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {copy.publishing}
                  </>
                ) : (
                  copy.publish
                )}
              </Button>
            )}
            <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
              <Link href={`/app/products/${product.id}/edit`}>
                {copy.edit}
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
              <Link href="/app/products" data-testid="merchant-product-preview-back">
                {copy.back}
              </Link>
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
