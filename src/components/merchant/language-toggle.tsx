"use client";

import { cn } from "@/lib/utils";
import type { MerchantLocale } from "@/lib/merchant/locale";

export type { MerchantLocale } from "@/lib/merchant/locale";

export function MerchantLanguageToggle({
  locale,
  onChange,
  label,
}: {
  locale: MerchantLocale;
  onChange: (locale: MerchantLocale) => void;
  label: string;
}) {
  return (
    <div
      className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5"
      role="group"
      aria-label={label}
    >
      {(["ar", "en"] as const).map((option) => {
        const active = locale === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            data-testid={`merchant-locale-${option}`}
            className={cn(
              "min-h-9 rounded-md px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option === "ar" ? "العربية" : "English"}
          </button>
        );
      })}
    </div>
  );
}
