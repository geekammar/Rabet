"use client";

import { useEffect } from "react";

import type { MerchantLocale } from "@/lib/merchant/locale";

export function MerchantOrderResume({
  path,
  locale,
}: {
  path: string;
  locale: MerchantLocale;
}) {
  useEffect(() => {
    // A document navigation preserves the order card fragment after sign-in.
    window.location.replace(path);
  }, [path]);

  return (
    <main lang={locale} dir={locale === "ar" ? "rtl" : "ltr"} className="p-4">
      <a className="text-primary underline" href={path}>
        {locale === "ar" ? "افتح الطلب" : "Open order"}
      </a>
    </main>
  );
}
