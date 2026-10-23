"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";

import { CURRENCIES, type Currency } from "./types";

const CURRENCY_DETAILS: Record<
  Currency,
  { label: string; symbol: string; desc: string }
> = {
  USD: { label: "US Dollar", symbol: "$", desc: "Default approved currency" },
  SAR: { label: "Saudi Riyal", symbol: "ر.س", desc: "Saudi Arabia" },
  AED: { label: "UAE Dirham", symbol: "د.إ", desc: "United Arab Emirates" },
  EGP: { label: "Egyptian Pound", symbol: "ج.م", desc: "Egypt" },
};

export function CurrencyPicker({
  initialCurrency = "USD",
  hasCatalogPrices = false,
  isEditMode = false,
  name = "currency",
}: {
  initialCurrency?: Currency;
  hasCatalogPrices?: boolean;
  isEditMode?: boolean;
  name?: string;
}) {
  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(initialCurrency);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const isChanged = isEditMode && selectedCurrency !== initialCurrency;
  const requiresConfirmation = isChanged && hasCatalogPrices;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium text-foreground">
          Store Display Currency <span className="text-destructive">*</span>
        </label>
        <p className="text-xs text-muted-foreground">
          The currency shown next to all catalog products and quotes. Changing
          currency does not convert existing product prices.
        </p>
      </div>

      {/* Grid of currency options */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {CURRENCIES.map((code) => {
          const info = CURRENCY_DETAILS[code];
          const isSelected = selectedCurrency === code;

          return (
            <label
              key={code}
              htmlFor={`currency-option-${code}`}
              className={`flex min-h-14 cursor-pointer items-center justify-between rounded-xl border p-3 transition-colors ${
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-input bg-card hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  id={`currency-option-${code}`}
                  type="radio"
                  name={name}
                  value={code}
                  checked={isSelected}
                  onChange={() => {
                    setSelectedCurrency(code);
                    setIsConfirmed(false);
                  }}
                  className="size-4 text-primary accent-primary"
                />
                <div>
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>{code}</span>
                    <span className="text-xs text-muted-foreground">
                      ({info.symbol})
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {info.label}
                  </div>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">{info.desc}</span>
            </label>
          );
        })}
      </div>

      {/* Safeguard banner when changing currency in edit mode */}
      {requiresConfirmation && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm space-y-3"
        >
          <div className="flex items-start gap-2.5 text-destructive">
            <AlertCircle className="size-5 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-destructive">
                Warning: Changing currency does not convert existing product prices.
              </p>
              <p className="text-xs text-foreground/90">
                You have active products in the catalog. If you change the store
                currency from <strong>{initialCurrency}</strong> to{" "}
                <strong>{selectedCurrency}</strong>, all existing products will keep
                their exact numerical prices (e.g. 100 {initialCurrency} becomes 100{" "}
                {selectedCurrency}).
              </p>
            </div>
          </div>

          <label
            htmlFor="confirm-currency-change"
            className="flex items-center gap-2.5 cursor-pointer pt-1 text-xs font-medium text-foreground"
          >
            <input
              id="confirm-currency-change"
              name="confirmCurrencyChange"
              type="checkbox"
              value="true"
              checked={isConfirmed}
              onChange={(e) => setIsConfirmed(e.target.checked)}
              required
              className="size-4 rounded border-input accent-primary"
            />
            <span>
              I understand that existing product prices will NOT be converted.
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
