import { INVITATION_PAGE_TITLE } from "@/lib/merchant-invitation/branding";

/**
 * Merchant-facing UI locale preference.
 *
 * This is deliberately separate from the catalog language records: it only
 * selects the copy of the merchant journey (invitation, sign-in, setup,
 * products and categories). It is stored in one small cookie so the server can
 * render the first response, metadata and page direction in the saved
 * language, while the client can change it without navigating or submitting a
 * form. The value never includes auth, store or invitation identity.
 */

export const MERCHANT_LOCALE_COOKIE = "rabet-merchant-locale";
export const MERCHANT_LOCALE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const MERCHANT_LOCALES = ["ar", "en"] as const;

export type MerchantLocale = (typeof MERCHANT_LOCALES)[number];

export const DEFAULT_MERCHANT_LOCALE: MerchantLocale = "ar";

export type MerchantLocalePage =
  | "invite"
  | "login"
  | "setup"
  | "products"
  | "productCreate"
  | "categories"
  | "orders";

export const MERCHANT_PAGE_TITLES: Record<
  MerchantLocalePage,
  Record<MerchantLocale, string>
> = {
  invite: INVITATION_PAGE_TITLE,
  login: {
    ar: "تسجيل دخول التاجر",
    en: "Merchant sign in",
  },
  setup: {
    ar: "إعداد المتجر",
    en: "Store setup",
  },
  products: {
    ar: "منتجات المتجر",
    en: "Store products",
  },
  productCreate: {
    ar: "إضافة منتج",
    en: "Add product",
  },
  categories: {
    ar: "أقسام المتجر",
    en: "Store categories",
  },
  orders: {
    ar: "طلبات الدفع عند الاستلام",
    en: "COD orders",
  },
};

export function normalizeMerchantLocale(
  value: string | null | undefined,
): MerchantLocale {
  return value === "en" ? "en" : DEFAULT_MERCHANT_LOCALE;
}

export function merchantPageTitle(
  page: MerchantLocalePage,
  locale: MerchantLocale,
): string {
  return MERCHANT_PAGE_TITLES[page][locale];
}

export function merchantDocumentTitle(
  page: MerchantLocalePage,
  locale: MerchantLocale,
): string {
  return `${merchantPageTitle(page, locale)} — Rabet`;
}
