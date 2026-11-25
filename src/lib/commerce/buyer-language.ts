/**
 * Buyer-facing language vocabulary shared by the storefront copy, the
 * store-scoped buyer preference and the Telegram managed webhook.
 *
 * Only Arabic and English are offered in this slice. The helper is deliberately
 * pure: it is safe to import from server code and from unit tests without a
 * database or a Telegram runtime.
 */

export const BUYER_LOCALES = ["ar", "en"] as const;

export type BuyerLocale = (typeof BUYER_LOCALES)[number];

export function isBuyerLocale(value: unknown): value is BuyerLocale {
  return value === "ar" || value === "en";
}

/**
 * Maps a Telegram/BCP-47 style language code onto the supported buyer locales.
 *
 * This preserves the existing fallback behavior: any Arabic variant becomes
 * Arabic, and everything else (including an absent hint) becomes English.
 */
export function buyerLocaleFromLanguageCode(
  code: string | undefined,
): BuyerLocale {
  return typeof code === "string" && code.toLowerCase().startsWith("ar")
    ? "ar"
    : "en";
}
