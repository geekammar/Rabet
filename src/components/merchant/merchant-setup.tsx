"use client";

import Link from "next/link";
import { Package } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Button } from "@/components/ui/button";
import type { StoreStatus } from "@/db/schema/tenant";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  accountLabel: string;
  setupStatusLabel: string;
  status: Record<StoreStatus, string>;
  productsTitle: string;
  productsBody: string;
  manageProducts: string;
  logout: string;
  languageLabel: string;
  suspendedTitle: string;
  suspendedBody: string;
  pendingBody: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "إعداد المتجر",
    subtitle: "هذه هي الخطوة الأولى في رحلة إعداد متجرك.",
    storeLabel: "المتجر",
    accountLabel: "حساب التاجر",
    setupStatusLabel: "حالة الإعداد",
    status: {
      onboarding: "قيد الإعداد",
      active: "نشط",
      suspended: "موقوف",
    },
    productsTitle: "المنتجات",
    productsBody: "راجع منتجات متجرك وحدّث سعر كل منتج.",
    manageProducts: "إدارة المنتجات",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على حالة المتجر فقط. التعديلات غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
    pendingBody:
      "سيتم تفعيل خطوات إعداد المتجر في مرحلة لاحقة. لا توجد تعديلات على بيانات المتجر في هذه المرحلة.",
  },
  en: {
    dir: "ltr",
    title: "Store setup",
    subtitle: "This is the first step in setting up your store.",
    storeLabel: "Store",
    accountLabel: "Merchant account",
    setupStatusLabel: "Setup status",
    status: {
      onboarding: "Onboarding",
      active: "Active",
      suspended: "Suspended",
    },
    productsTitle: "Products",
    productsBody: "Review your store products and update each product price.",
    manageProducts: "Manage products",
    logout: "Sign out",
    languageLabel: "Page language",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review the store status only. Editing is unavailable until a platform administrator reactivates the store.",
    pendingBody:
      "The remaining store setup steps will be enabled in a later phase. No store data is changed in this phase.",
  },
};

const STATUS_CLASS: Record<StoreStatus, string> = {
  onboarding:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200",
  active:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200",
  suspended: "border-destructive/30 bg-destructive/5 text-destructive",
};

export function MerchantSetup({
  storeName,
  email,
  status,
  readOnly,
  initialLocale,
}: {
  storeName: string;
  email: string;
  status: StoreStatus;
  readOnly: boolean;
  initialLocale: MerchantLocale;
}) {
  const [locale, setLocale] = useMerchantLocale(initialLocale, "setup");
  const copy = COPY[locale];
  const statusLabel = copy.status[status];
  const secondaryStatusLabel = COPY[locale === "ar" ? "en" : "ar"].status[status];

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-setup-page"
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

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
        <div className="space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {copy.storeLabel}
              </p>
              <h2
                className="break-words font-heading text-xl font-semibold"
                data-testid="merchant-store-name"
              >
                {storeName}
              </h2>
            </div>
            <span
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium ${STATUS_CLASS[status]}`}
              data-testid="merchant-store-status"
            >
              {statusLabel}
              <span className="sr-only"> — {secondaryStatusLabel}</span>
            </span>
          </div>

          <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">{copy.accountLabel}</dt>
              <dd className="break-all font-medium">{email}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">
                {copy.setupStatusLabel}
              </dt>
              <dd className="font-medium">
                {statusLabel}{" "}
                <span className="text-muted-foreground">
                  ({secondaryStatusLabel})
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h2 className="font-heading text-lg font-semibold">
                {copy.productsTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {copy.productsBody}
              </p>
            </div>
            <Button asChild className="min-h-11">
              <Link href="/app/products" data-testid="merchant-products-link">
                <Package className="size-4" aria-hidden="true" />
                {copy.manageProducts}
              </Link>
            </Button>
          </div>
        </section>

        {readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="merchant-suspended-notice"
          >
            <p className="font-semibold">{copy.suspendedTitle}</p>
            <p className="mt-1">{copy.suspendedBody}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {copy.pendingBody}
          </div>
        )}
      </main>
    </div>
  );
}
