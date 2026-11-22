import "server-only";

import type { Metadata } from "next";
import { cookies } from "next/headers";

import {
  MERCHANT_LOCALE_COOKIE,
  MERCHANT_PAGE_TITLES,
  normalizeMerchantLocale,
  type MerchantLocale,
  type MerchantLocalePage,
} from "@/lib/merchant/locale";

/**
 * Reads the merchant UI locale from the request cookie. Arabic remains the
 * default when the visitor has not made an explicit choice.
 */
export async function readMerchantLocale(): Promise<MerchantLocale> {
  const store = await cookies();
  const value = store.get(MERCHANT_LOCALE_COOKIE)?.value;

  return normalizeMerchantLocale(value);
}

/**
 * Localized, noindex metadata for every in-scope merchant route. Keeping the
 * titles in the shared locale module makes the server document title and the
 * client-side title update agree on direct navigation, reload and toggles.
 */
export async function merchantPageMetadata(
  page: MerchantLocalePage,
  description: string,
): Promise<Metadata> {
  const locale = await readMerchantLocale();

  return {
    title: MERCHANT_PAGE_TITLES[page][locale],
    description,
    robots: { index: false, follow: false },
  };
}
