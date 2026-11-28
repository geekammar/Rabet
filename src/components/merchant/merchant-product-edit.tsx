"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";

import { saveMerchantProductDraftDetails } from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  nameLabel: string;
  priceLabel: string;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  imageLabel: string;
  imagePlaceholder: string;
  imageHint: string;
  stockLabel: string;
  stockHint: string;
  reservedHint: string;
  save: string;
  saving: string;
  saved: string;
  back: string;
  preview: string;
  logout: string;
  languageLabel: string;
  draftStatus: string;
  publishedStatus: string;
  invalidDescription: string;
  invalidImage: string;
  invalidStock: string;
  stockBelowReserved: string;
  conflict: string;
  notFound: string;
  denied: string;
  unavailable: string;
  languageUnavailable: string;
  suspendedTitle: string;
  suspendedBody: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "تعديل المنتج",
    subtitle: "حدّث وصف المنتج وصورته والمخزون قبل النشر.",
    storeLabel: "المتجر",
    nameLabel: "اسم المنتج",
    priceLabel: "السعر",
    descriptionLabel: "وصف المنتج",
    descriptionPlaceholder: "وصف قصير يظهر للعميل مع المنتج.",
    imageLabel: "رابط صورة المنتج",
    imagePlaceholder: "https://example.com/product.jpg",
    imageHint: "رابط صورة واحد اختياري. ترك الحقل فارغًا لا يمنع النشر.",
    stockLabel: "المخزون المتاح",
    stockHint: "عدد القطع الموجودة فعليًا في المخزون.",
    reservedHint: "القطع المحجوزة لطلبات مؤكدة لا تُعدّل من هنا.",
    save: "حفظ التعديلات",
    saving: "جارٍ الحفظ…",
    saved: "تم حفظ تعديلات المنتج.",
    back: "العودة إلى المنتجات",
    preview: "معاينة المنتج",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    draftStatus: "مسودة",
    publishedStatus: "منشور",
    invalidDescription: "أدخل وصفًا لا يتجاوز 4096 حرفًا.",
    invalidImage: "أدخل رابط صورة صالحًا يبدأ بـ http أو https.",
    invalidStock: "أدخل عددًا صحيحًا غير سالب للمخزون.",
    stockBelowReserved:
      "لا يمكن أن يقل المخزون عن الكمية المحجوزة لطلبات مؤكدة.",
    conflict: "حُفظ تغيير أحدث من جهاز آخر. أعد تحميل الصفحة ثم حاول مجددًا.",
    notFound: "تعذر العثور على هذا المنتج في متجرك.",
    denied: "لم تعد تملك صلاحية تعديل هذا المتجر.",
    unavailable: "تعذر حفظ التعديلات الآن. حاول مرة أخرى بعد قليل.",
    languageUnavailable:
      "لا توجد لغة كتالوج مفعّلة لحفظ الوصف. اطلب من مسؤول المنصة تفعيل لغة.",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على المنتج فقط. التعديل غير متاح حتى يعيد مسؤول المنصة تفعيل المتجر.",
  },
  en: {
    dir: "ltr",
    title: "Edit product",
    subtitle: "Update the product description, image and stock before publishing.",
    storeLabel: "Store",
    nameLabel: "Product name",
    priceLabel: "Price",
    descriptionLabel: "Product description",
    descriptionPlaceholder: "A short description shown with the product.",
    imageLabel: "Product image URL",
    imagePlaceholder: "https://example.com/product.jpg",
    imageHint:
      "One optional image URL. Leaving it empty never blocks publishing.",
    stockLabel: "Stock on hand",
    stockHint: "The number of units physically in stock.",
    reservedHint: "Units reserved by confirmed orders are not changed here.",
    save: "Save changes",
    saving: "Saving…",
    saved: "Product changes saved.",
    back: "Back to products",
    preview: "Preview product",
    logout: "Sign out",
    languageLabel: "Page language",
    draftStatus: "Draft",
    publishedStatus: "Published",
    invalidDescription: "Enter a description of at most 4096 characters.",
    invalidImage: "Enter a valid image URL starting with http or https.",
    invalidStock: "Enter a whole, non-negative stock quantity.",
    stockBelowReserved:
      "Stock cannot be lower than the quantity reserved by confirmed orders.",
    conflict: "A newer change was saved on another device. Reload and try again.",
    notFound: "This product could not be found in your store.",
    denied: "You can no longer edit this store.",
    unavailable: "The changes could not be saved right now. Try again shortly.",
    languageUnavailable:
      "No enabled catalog language is ready to save the description. Ask a platform administrator to enable one.",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review the product only. Editing is unavailable until a platform administrator reactivates the store.",
  },
};

export function MerchantProductEdit({
  storeName,
  readOnly,
  languageUnavailable,
  initialLocale,
  product,
}: {
  storeName: string;
  readOnly: boolean;
  languageUnavailable: boolean;
  initialLocale: MerchantLocale;
  product: {
    id: string;
    name: string;
    price: string;
    revision: string;
    isActive: boolean;
    imageUrl: string;
    description: string;
    onHand: number;
    reserved: number;
  };
}) {
  const router = useRouter();
  const [locale, setLocale] = useMerchantLocale(initialLocale, "products");
  const [description, setDescription] = useState(product.description);
  const [imageUrl, setImageUrl] = useState(product.imageUrl);
  const [stock, setStock] = useState(String(product.onHand));
  const [revision, setRevision] = useState(product.revision);
  const [message, setMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isSaving, startSaving] = useTransition();
  const copy = COPY[locale];

  function save() {
    if (readOnly || isSaving) return;

    setMessage(null);

    startSaving(async () => {
      let result: Awaited<ReturnType<typeof saveMerchantProductDraftDetails>>;

      try {
        result = await saveMerchantProductDraftDetails({
          productId: product.id,
          revision,
          description,
          imageUrl,
          stock,
        });
      } catch {
        setMessage({ ok: false, text: copy.unavailable });
        return;
      }

      if (result.ok) {
        setRevision(result.revision);
        setMessage({ ok: true, text: copy.saved });
        router.refresh();
        return;
      }

      const text =
        result.error === "INVALID_INPUT"
          ? result.fields?.imageUrl
            ? copy.invalidImage
            : result.fields?.stock
              ? copy.invalidStock
              : copy.invalidDescription
          : result.error === "STOCK_BELOW_RESERVED"
            ? copy.stockBelowReserved
            : result.error === "CONFLICT"
              ? copy.conflict
              : result.error === "NOT_FOUND"
                ? copy.notFound
                : result.error === "DENIED"
                  ? copy.denied
                  : copy.unavailable;

      setMessage({ ok: false, text });
    });
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-product-edit-page"
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

        {readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            <p className="font-semibold">{copy.suspendedTitle}</p>
            <p className="mt-1">{copy.suspendedBody}</p>
          </div>
        ) : null}

        <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words font-heading text-lg font-semibold">
              {product.name}
            </h2>
            <Badge variant="outline" data-status={product.isActive ? "published" : "draft"}>
              {product.isActive ? copy.publishedStatus : copy.draftStatus}
            </Badge>
          </div>
          <p className="flex flex-wrap items-baseline gap-2 text-sm">
            <span className="text-muted-foreground">{copy.priceLabel}:</span>
            <span dir="ltr" className="font-medium tabular-nums">
              {product.price}
            </span>
          </p>

          <div className="space-y-1.5">
            <label htmlFor="merchant-product-edit-description" className="block text-sm font-medium">
              {copy.descriptionLabel}
            </label>
            <textarea
              id="merchant-product-edit-description"
              rows={4}
              maxLength={4096}
              value={description}
              disabled={readOnly || isSaving}
              onChange={(event) => {
                setDescription(event.target.value);
                setMessage(null);
              }}
              placeholder={copy.descriptionPlaceholder}
              data-testid="merchant-product-edit-description"
              className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="merchant-product-edit-image" className="block text-sm font-medium">
              {copy.imageLabel}
            </label>
            <input
              id="merchant-product-edit-image"
              type="url"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              value={imageUrl}
              disabled={readOnly || isSaving}
              onChange={(event) => {
                setImageUrl(event.target.value);
                setMessage(null);
              }}
              placeholder={copy.imagePlaceholder}
              data-testid="merchant-product-edit-image"
              className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">{copy.imageHint}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="merchant-product-edit-stock" className="block text-sm font-medium">
              {copy.stockLabel}
            </label>
            <input
              id="merchant-product-edit-stock"
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              maxLength={9}
              value={stock}
              disabled={readOnly || isSaving}
              onChange={(event) => {
                setStock(event.target.value);
                setMessage(null);
              }}
              data-testid="merchant-product-edit-stock"
              className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-48"
            />
            <p className="text-xs text-muted-foreground">{copy.stockHint}</p>
            {product.reserved > 0 ? (
              <p className="text-xs text-muted-foreground">
                {copy.reservedHint} ({product.reserved})
              </p>
            ) : null}
          </div>

          {languageUnavailable ? (
            <p role="alert" className="text-sm text-destructive">
              {copy.languageUnavailable}
            </p>
          ) : null}

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
            <Button
              type="button"
              onClick={save}
              disabled={readOnly || isSaving || languageUnavailable}
              className="min-h-11 w-full sm:w-auto"
              data-testid="merchant-product-edit-save"
            >
              {isSaving ? (
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
              <Link href={`/app/products/${product.id}/preview`}>
                {copy.preview}
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
              <Link href="/app/products" data-testid="merchant-product-edit-back">
                {copy.back}
              </Link>
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
