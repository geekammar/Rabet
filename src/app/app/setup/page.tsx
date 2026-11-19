import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { requireMerchantAccess } from "@/lib/auth/merchant-session";
import type { StoreStatus } from "@/db/schema/tenant";

export const metadata: Metadata = {
  title: "إعداد المتجر",
  description: "Set up your Rabet store.",
  robots: { index: false, follow: false },
};

export const instant = false;

const STATUS_COPY: Record<
  StoreStatus,
  { ar: string; en: string; className: string }
> = {
  onboarding: {
    ar: "قيد الإعداد",
    en: "Onboarding",
    className:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200",
  },
  active: {
    ar: "نشط",
    en: "Active",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200",
  },
  suspended: {
    ar: "موقوف",
    en: "Suspended",
    className:
      "border-destructive/30 bg-destructive/5 text-destructive",
  },
};

export default async function MerchantSetupPage() {
  await connection();

  if (!isMerchantAppEnabled()) notFound();

  const access = await requireMerchantAccess();
  const status = STATUS_COPY[access.store.status];

  return (
    <div
      dir="rtl"
      lang="ar"
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-setup-page"
    >
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-4">
          <Logo className="text-lg" />
          <MerchantLogoutButton label="تسجيل الخروج" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-8">
        <div className="space-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            إعداد المتجر
          </h1>
          <p className="text-sm text-muted-foreground">
            هذه هي الخطوة الأولى في رحلة إعداد متجرك.
          </p>
        </div>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">المتجر</p>
              <h2
                className="break-words font-heading text-xl font-semibold"
                data-testid="merchant-store-name"
              >
                {access.store.name}
              </h2>
            </div>
            <span
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium ${status.className}`}
              data-testid="merchant-store-status"
            >
              {status.ar}
              <span className="sr-only"> — {status.en}</span>
            </span>
          </div>

          <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">حساب التاجر</dt>
              <dd className="break-all font-medium">{access.email}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">حالة الإعداد</dt>
              <dd className="font-medium">
                {status.ar} <span className="text-muted-foreground">({status.en})</span>
              </dd>
            </div>
          </dl>
        </section>

        {access.readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="merchant-suspended-notice"
          >
            <p className="font-semibold">المتجر موقوف مؤقتًا.</p>
            <p className="mt-1">
              يمكنك الاطلاع على حالة المتجر فقط. التعديلات غير متاحة حتى يعيد
              مسؤول المنصة تفعيل المتجر.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            سيتم تفعيل خطوات إعداد المتجر في مرحلة لاحقة. لا توجد تعديلات على
            بيانات المتجر في هذه المرحلة.
          </div>
        )}
      </main>
    </div>
  );
}
