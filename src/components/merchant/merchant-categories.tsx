"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";

import { saveMerchantCategoryAvailability } from "@/app/actions/merchant-catalog";
import { Logo } from "@/components/brand/logo";
import { isCategoryAncestryActive } from "@/lib/catalog/ancestry";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { MerchantLogoutButton } from "@/components/merchant/merchant-logout-button";
import { Button } from "@/components/ui/button";

export type MerchantCategoryItem = {
  id: string;
  name: string;
  revision: string;
  isActive: boolean;
  pathVisible: boolean;
  parentId: string | null;
  parentResolved: boolean;
};

type AvailabilityState = {
  isActive: boolean;
  revision: string;
};

type AvailabilityError =
  | "UNAVAILABLE"
  | "DENIED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_REVISION";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  storeLabel: string;
  categoriesLabel: string;
  backToProducts: string;
  setupLink: string;
  logout: string;
  languageLabel: string;
  suspendedTitle: string;
  suspendedBody: string;
  emptyTitle: string;
  emptyBody: string;
  savedAvailabilityLabel: string;
  savedOn: string;
  savedOff: string;
  pathLabel: string;
  pathAvailable: string;
  pathUnavailable: string;
  enabledPathHiddenNotice: string;
  inactiveBranchNotice: string;
  makeAvailable: string;
  stopAvailability: string;
  saving: string;
  saved: string;
  invalidInput: string;
  invalidRevision: string;
  notFound: string;
  denied: string;
  unavailable: string;
  conflictTitle: string;
  conflictBody: string;
  latestAvailabilityLabel: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "أقسام المتجر",
    subtitle:
      "راجع أقسام متجرك وتحكم في إتاحة كل قسم. إتاحة القسم لا تكفي وحدها لظهوره إذا كان أحد أقسامه الأعلى غير متاح.",
    storeLabel: "المتجر",
    categoriesLabel: "الأقسام",
    backToProducts: "العودة إلى المنتجات",
    setupLink: "إعداد المتجر",
    logout: "تسجيل الخروج",
    languageLabel: "لغة الصفحة",
    suspendedTitle: "المتجر موقوف مؤقتًا.",
    suspendedBody:
      "يمكنك الاطلاع على الأقسام فقط. التعديلات غير متاحة حتى يعيد مسؤول المنصة تفعيل المتجر.",
    emptyTitle: "لا توجد أقسام بعد",
    emptyBody: "ستظهر أقسام متجرك هنا بعد إنشائها مع أول منتج.",
    savedAvailabilityLabel: "الإتاحة المحفوظة",
    savedOn: "مفعّلة",
    savedOff: "متوقفة",
    pathLabel: "مسار القسم",
    pathAvailable: "متاح",
    pathUnavailable: "غير متاح",
    enabledPathHiddenNotice:
      "الإتاحة محفوظة لهذا القسم، لكن القسم أو أحد أقسامه الأعلى غير متاح. يبقى هذا الفرع مخفيًا حتى يتاح مسار القسم بالكامل.",
    inactiveBranchNotice:
      "هذا القسم غير متاح، ولن يظهر هو أو أي قسم فرعي أو منتج تحته حتى تتاح إتاحته.",
    makeAvailable: "إتاحة القسم",
    stopAvailability: "إيقاف إتاحة القسم",
    saving: "جارٍ حفظ إتاحة القسم…",
    saved: "تم حفظ إتاحة القسم.",
    invalidInput: "تعذر قراءة حالة إتاحة القسم. أعد المحاولة.",
    invalidRevision: "تعذر التحقق من نسخة القسم. أعد تحميل الصفحة.",
    notFound: "تعذر العثور على هذا القسم في متجرك.",
    denied: "لم تعد تملك صلاحية تعديل هذا المتجر.",
    unavailable: "تعذر حفظ إتاحة القسم الآن. حاول مرة أخرى بعد قليل.",
    conflictTitle: "حفظ جهاز آخر تغييرًا أحدث.",
    conflictBody:
      "لم تُحفظ حالة الإتاحة حتى لا تستبدل التغيير الأحدث. راجع الحالة المحفوظة ثم اختر إتاحة القسم أو إيقاف إتاحة القسم من جديد.",
    latestAvailabilityLabel: "أحدث حالة محفوظة",
  },
  en: {
    dir: "ltr",
    title: "Store categories",
    subtitle:
      "Review your store categories and control each category's availability. Category availability alone is not enough when a parent category is unavailable.",
    storeLabel: "Store",
    categoriesLabel: "Categories",
    backToProducts: "Back to products",
    setupLink: "Store setup",
    logout: "Sign out",
    languageLabel: "Page language",
    suspendedTitle: "This store is suspended.",
    suspendedBody:
      "You can review categories only. Editing is unavailable until a platform administrator reactivates the store.",
    emptyTitle: "No categories yet",
    emptyBody:
      "Your store categories will appear here after they are created with the first product.",
    savedAvailabilityLabel: "Saved availability",
    savedOn: "On",
    savedOff: "Off",
    pathLabel: "Category path",
    pathAvailable: "Available",
    pathUnavailable: "Unavailable",
    enabledPathHiddenNotice:
      "Availability is saved for this category, but this category or one of its ancestors is unavailable. This branch stays hidden until the full category path is available.",
    inactiveBranchNotice:
      "This category is unavailable, so it and any child category or product beneath it stay hidden until it is made available.",
    makeAvailable: "Make category available",
    stopAvailability: "Stop category availability",
    saving: "Saving category availability…",
    saved: "Category availability saved.",
    invalidInput: "The category availability state could not be read. Try again.",
    invalidRevision:
      "The category revision could not be checked. Reload the page.",
    notFound: "This category could not be found in your store.",
    denied: "You can no longer edit this store.",
    unavailable:
      "The category availability could not be saved right now. Try again shortly.",
    conflictTitle: "Another device saved a newer change.",
    conflictBody:
      "Your availability change was not saved so it could not replace the newer change. Review the saved state, then choose make category available or stop category availability again.",
    latestAvailabilityLabel: "Latest saved state",
  },
};

function errorMessage(error: AvailabilityError, copy: Copy): string {
  switch (error) {
    case "INVALID_INPUT":
      return copy.invalidInput;
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

function availabilityViewFor(
  category: MerchantCategoryItem,
  overrides: Record<string, AvailabilityState>,
  conflicts: Record<string, AvailabilityState | undefined>,
): AvailabilityState {
  let latest: AvailabilityState = {
    isActive: category.isActive,
    revision: category.revision,
  };

  for (const entry of [overrides[category.id], conflicts[category.id]]) {
    if (entry && entry.revision >= latest.revision) {
      latest = entry;
    }
  }

  return latest;
}

export function MerchantCategories({
  storeName,
  readOnly,
  categories,
}: {
  storeName: string;
  readOnly: boolean;
  categories: MerchantCategoryItem[];
}) {
  const router = useRouter();
  const [locale, setLocale] = useState<MerchantLocale>("ar");
  const [overrides, setOverrides] = useState<
    Record<string, AvailabilityState>
  >({});
  const [errors, setErrors] = useState<
    Record<string, AvailabilityError | undefined>
  >({});
  const [conflicts, setConflicts] = useState<
    Record<string, AvailabilityState | undefined>
  >({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const copy = COPY[locale];
  const saving = isPending || pendingId !== null;

  const availabilityById = new Map(
    categories.map((category) => [
      category.id,
      availabilityViewFor(category, overrides, conflicts),
    ]),
  );
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  );

  function pathVisibleFor(categoryId: string): boolean {
    return isCategoryAncestryActive(categoryId, (id) => {
      const category = categoryById.get(id);

      if (!category) return undefined;

      const availability = availabilityById.get(id);

      return {
        id: category.id,
        parentId: category.parentId,
        isActive: availability?.isActive ?? category.isActive,
        parentResolved: category.parentResolved,
      };
    });
  }

  function saveAvailability(
    category: MerchantCategoryItem,
    desiredIsActive: boolean,
    expectedRevision: string,
  ) {
    if (readOnly || pendingRef.current !== null) return;

    const categoryId = category.id;
    pendingRef.current = categoryId;

    setErrors((current) => ({ ...current, [categoryId]: undefined }));
    setSavedId(null);
    setPendingId(categoryId);

    startTransition(async () => {
      try {
        const result = await saveMerchantCategoryAvailability({
          categoryId,
          isActive: desiredIsActive,
          revision: expectedRevision,
        });

        if (result.ok) {
          setOverrides((current) => ({
            ...current,
            [result.categoryId]: {
              isActive: result.isActive,
              revision: result.revision,
            },
          }));
          setConflicts((current) => ({
            ...current,
            [categoryId]: undefined,
          }));
          setSavedId(result.categoryId);
        } else if (result.error === "CONFLICT") {
          setOverrides((current) => {
            const existing = current[categoryId];

            if (existing && existing.revision > result.current.revision) {
              return current;
            }

            return {
              ...current,
              [categoryId]: result.current,
            };
          });
          setConflicts((current) => {
            const existing = current[categoryId];

            if (existing && existing.revision > result.current.revision) {
              return current;
            }

            return {
              ...current,
              [categoryId]: result.current,
            };
          });
          // The conflict response confirms the category's saved availability.
          // Refresh the scoped server view so derived path visibility and any
          // other category rows also show the newest confirmed state.
          router.refresh();
        } else {
          setErrors((current) => ({
            ...current,
            [categoryId]: result.error,
          }));
        }
      } catch {
        setErrors((current) => ({
          ...current,
          [categoryId]: "UNAVAILABLE",
        }));
      } finally {
        pendingRef.current = null;
        setPendingId(null);
      }
    });
  }

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-categories-page"
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
              <span data-testid="merchant-categories-store-name">
                {storeName}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" className="min-h-11">
              <Link
                href="/app/products"
                data-testid="merchant-categories-back"
              >
                {copy.backToProducts}
              </Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/app/setup">{copy.setupLink}</Link>
            </Button>
          </div>
        </div>

        {readOnly ? (
          <div
            role="status"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            data-testid="merchant-categories-suspended-notice"
          >
            <p className="font-semibold">{copy.suspendedTitle}</p>
            <p className="mt-1">{copy.suspendedBody}</p>
          </div>
        ) : null}

        <section className="space-y-3" aria-label={copy.categoriesLabel}>
          <h2 className="font-heading text-lg font-semibold">
            {copy.categoriesLabel}
          </h2>

          {categories.length === 0 ? (
            <div
              className="rounded-xl border border-border bg-muted/30 p-5 text-center"
              data-testid="merchant-categories-empty"
            >
              <p className="font-medium">{copy.emptyTitle}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {copy.emptyBody}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {categories.map((category) => {
                const error = errors[category.id];
                const conflict = conflicts[category.id];
                const availability = availabilityViewFor(
                  category,
                  overrides,
                  conflicts,
                );
                const rowSaving = pendingId === category.id;
                const pathVisible = pathVisibleFor(category.id);
                const enableDisabled =
                  saving ||
                  (!conflict && availability.isActive);
                const disableDisabled =
                  saving ||
                  (!conflict && !availability.isActive);

                return (
                  <li
                    key={category.id}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm"
                    data-testid="merchant-category-row"
                    data-category-id={category.id}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className="break-words font-heading text-base font-semibold"
                        data-testid={`merchant-category-name-${category.id}`}
                      >
                        {category.name}
                      </h3>
                      <span
                        className={
                          availability.isActive
                            ? "text-sm font-medium text-emerald-700 dark:text-emerald-300"
                            : "text-sm font-medium text-muted-foreground"
                        }
                        data-testid={`merchant-category-saved-${category.id}`}
                      >
                        {copy.savedAvailabilityLabel}:{" "}
                        {availability.isActive
                          ? copy.savedOn
                          : copy.savedOff}
                      </span>
                      <span
                        className={
                          pathVisible
                            ? "text-sm font-medium text-emerald-700 dark:text-emerald-300"
                            : "text-sm font-medium text-amber-800 dark:text-amber-200"
                        }
                        data-testid={`merchant-category-path-${category.id}`}
                        data-path-visible={pathVisible ? "true" : "false"}
                      >
                        {copy.pathLabel}:{" "}
                        {pathVisible
                          ? copy.pathAvailable
                          : copy.pathUnavailable}
                      </span>
                    </div>

                    {!pathVisible ? (
                      <p
                        role="status"
                        className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                        data-testid={`merchant-category-path-notice-${category.id}`}
                      >
                        {availability.isActive
                          ? copy.enabledPathHiddenNotice
                          : copy.inactiveBranchNotice}
                      </p>
                    ) : null}

                    {readOnly ? null : (
                      <div className="mt-3 space-y-2 border-t border-border pt-3">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={enableDisabled}
                            aria-busy={rowSaving}
                            onClick={() =>
                              saveAvailability(
                                category,
                                true,
                                availability.revision,
                              )
                            }
                            data-testid={`merchant-category-enable-${category.id}`}
                          >
                            {rowSaving && !availability.isActive ? (
                              <>
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                                {copy.saving}
                              </>
                            ) : (
                              copy.makeAvailable
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={disableDisabled}
                            aria-busy={rowSaving}
                            onClick={() =>
                              saveAvailability(
                                category,
                                false,
                                availability.revision,
                              )
                            }
                            data-testid={`merchant-category-disable-${category.id}`}
                          >
                            {rowSaving && availability.isActive ? (
                              <>
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                                {copy.saving}
                              </>
                            ) : (
                              copy.stopAvailability
                            )}
                          </Button>
                        </div>

                        {error ? (
                          <p
                            role="alert"
                            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                            data-testid={`merchant-category-error-${category.id}`}
                          >
                            {errorMessage(error, copy)}
                          </p>
                        ) : null}

                        {conflict ? (
                          <div
                            role="alert"
                            className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
                            data-testid={`merchant-category-conflict-${category.id}`}
                          >
                            <p className="font-semibold">
                              {copy.conflictTitle}
                            </p>
                            <p>{copy.conflictBody}</p>
                            <p className="flex flex-wrap items-baseline gap-2">
                              <span>{copy.latestAvailabilityLabel}:</span>
                              <span
                                className="font-semibold"
                                data-testid={`merchant-category-conflict-latest-${category.id}`}
                              >
                                {availability.isActive
                                  ? copy.savedOn
                                  : copy.savedOff}
                              </span>
                            </p>
                          </div>
                        ) : null}

                        {savedId === category.id ? (
                          <p
                            role="status"
                            className="text-sm font-medium text-emerald-700 dark:text-emerald-300"
                            data-testid={`merchant-category-saved-notice-${category.id}`}
                          >
                            {copy.saved}
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
