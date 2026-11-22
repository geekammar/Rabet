import { describe, expect, it } from "vitest";

import {
  DEFAULT_MERCHANT_LOCALE,
  MERCHANT_PAGE_TITLES,
  merchantDocumentTitle,
  normalizeMerchantLocale,
} from "@/lib/merchant/locale";

describe("merchant locale preference", () => {
  it("defaults to Arabic and only accepts an explicit English choice", () => {
    expect(DEFAULT_MERCHANT_LOCALE).toBe("ar");
    expect(normalizeMerchantLocale(undefined)).toBe("ar");
    expect(normalizeMerchantLocale(null)).toBe("ar");
    expect(normalizeMerchantLocale("")).toBe("ar");
    expect(normalizeMerchantLocale("fr")).toBe("ar");
    expect(normalizeMerchantLocale("ar")).toBe("ar");
    expect(normalizeMerchantLocale("en")).toBe("en");
  });

  it("keeps both language directions for every in-scope page title", () => {
    for (const page of Object.keys(MERCHANT_PAGE_TITLES) as Array<
      keyof typeof MERCHANT_PAGE_TITLES
    >) {
      expect(MERCHANT_PAGE_TITLES[page].ar.length).toBeGreaterThan(0);
      expect(MERCHANT_PAGE_TITLES[page].en.length).toBeGreaterThan(0);
      expect(MERCHANT_PAGE_TITLES[page].ar).not.toBe(
        MERCHANT_PAGE_TITLES[page].en,
      );
    }
  });

  it("builds the same document title the metadata template renders", () => {
    expect(merchantDocumentTitle("products", "ar")).toBe(
      "منتجات المتجر — Rabet",
    );
    expect(merchantDocumentTitle("products", "en")).toBe(
      "Store products — Rabet",
    );
    expect(merchantDocumentTitle("invite", "en")).toBe(
      "You’re invited to manage your store on Nokmel — Rabet",
    );
  });
});
