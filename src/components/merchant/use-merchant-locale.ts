"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  MERCHANT_LOCALE_COOKIE,
  MERCHANT_LOCALE_MAX_AGE_SECONDS,
  merchantDocumentTitle,
  normalizeMerchantLocale,
  type MerchantLocale,
  type MerchantLocalePage,
} from "@/lib/merchant/locale";

function writeLocaleCookie(locale: MerchantLocale): void {
  try {
    const secure =
      window.location.protocol === "https:" ? "; Secure" : "";

    document.cookie =
      `${MERCHANT_LOCALE_COOKIE}=${locale}; Path=/; ` +
      `Max-Age=${MERCHANT_LOCALE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch {}
}

function readLocaleCookie(): MerchantLocale | null {
  try {
    const prefix = `${MERCHANT_LOCALE_COOKIE}=`;
    const entry = document.cookie
      .split("; ")
      .find((candidate) => candidate.startsWith(prefix));

    if (!entry) return null;

    return normalizeMerchantLocale(
      decodeURIComponent(entry.slice(prefix.length)),
    );
  } catch {
    return null;
  }
}

/**
 * One shared client implementation of the merchant locale preference.
 *
 * The server cookie is the source of truth for first render and metadata. The
 * hook keeps visible copy, `lang`, `dir`, the active toggle and the document
 * title in sync, writes only the locale cookie on selection (never form or
 * invitation data), and refreshes server components without unmounting the
 * current client tree so unsaved fields survive. `popstate`/`pageshow` re-sync
 * cached back/forward documents to the saved choice.
 */
export function useMerchantLocale(
  initialLocale: MerchantLocale,
  page: MerchantLocalePage,
): readonly [MerchantLocale, (locale: MerchantLocale) => void] {
  const router = useRouter();
  const [locale, setLocaleState] = useState<MerchantLocale>(initialLocale);

  const setLocale = useCallback(
    (next: MerchantLocale) => {
      if (next === locale) return;

      writeLocaleCookie(next);
      setLocaleState(next);
      router.refresh();
    },
    [locale, router],
  );

  useEffect(() => {
    document.title = merchantDocumentTitle(page, locale);
  }, [locale, page]);

  useEffect(() => {
    function syncFromCookie() {
      const stored = readLocaleCookie();

      if (stored !== null) {
        setLocaleState(stored);
      }
    }

    syncFromCookie();
    window.addEventListener("pageshow", syncFromCookie);
    window.addEventListener("popstate", syncFromCookie);

    return () => {
      window.removeEventListener("pageshow", syncFromCookie);
      window.removeEventListener("popstate", syncFromCookie);
    };
  }, []);

  return [locale, setLocale] as const;
}
