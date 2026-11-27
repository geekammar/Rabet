"use client";

import { useState, useTransition } from "react";
import { Loader2, Wallet } from "lucide-react";

import { saveMerchantCommerceSettingAction } from "@/app/actions/merchant-settings";
import type { MerchantLocale } from "@/components/merchant/language-toggle";
import { Button } from "@/components/ui/button";

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  body: string;
  codLabel: string;
  codHint: string;
  codDeploymentHint: string;
  feeLabel: string;
  feePlaceholder: string;
  feeHint: string;
  currencyLabel: string;
  save: string;
  saving: string;
  saved: string;
  invalid: string;
  denied: string;
  unavailable: string;
  notConfigured: string;
};

const COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: "الدفع والتوصيل",
    body: "إعدادات الدفع والتوصيل التي تظهر للعميل عند إتمام الطلب.",
    codLabel: "تفعيل الدفع عند الاستلام",
    codHint: "يظهر الدفع عند الاستلام في بوت المتجر عند تفعيله.",
    codDeploymentHint:
      "الدفع عند الاستلام معطّل في هذا التشغيل من المنصة، لذلك لن يظهر للعميل حتى يفعّله مسؤول المنصة.",
    feeLabel: "رسوم التوصيل الثابتة",
    feePlaceholder: "مثال: 15.00",
    feeHint:
      "اترك الحقل فارغًا إذا لم تحدد الرسوم بعد. أدخل 0.00 للتوصيل المجاني صراحةً؛ الحقل الفارغ يمنع النشر.",
    currencyLabel: "العملة",
    save: "حفظ إعدادات الدفع والتوصيل",
    saving: "جارٍ الحفظ…",
    saved: "تم حفظ إعدادات الدفع والتوصيل.",
    invalid: "أدخل رسوم توصيل صالحة من رقمين عشريين على الأكثر.",
    denied: "لم تعد تملك صلاحية تعديل هذا المتجر.",
    unavailable: "تعذر الحفظ الآن. حاول مرة أخرى بعد قليل.",
    notConfigured:
      "لم تُهيأ إعدادات التجارة لهذا المتجر بعد. اطلب من مسؤول المنصة تهيئة العملة.",
  },
  en: {
    dir: "ltr",
    title: "Payment and delivery",
    body: "The payment and delivery settings buyers see at checkout.",
    codLabel: "Enable cash on delivery",
    codHint: "Cash on delivery appears in the Store Bot when enabled.",
    codDeploymentHint:
      "Cash on delivery is disabled in this deployment, so buyers will not see it until a platform administrator enables it.",
    feeLabel: "Flat delivery fee",
    feePlaceholder: "e.g. 15.00",
    feeHint:
      "Leave empty when the fee is not decided yet. Enter 0.00 for explicit free delivery; an empty fee blocks publishing.",
    currencyLabel: "Currency",
    save: "Save payment and delivery",
    saving: "Saving…",
    saved: "Payment and delivery settings saved.",
    invalid: "Enter a valid delivery fee with no more than two decimal places.",
    denied: "You can no longer edit this store.",
    unavailable: "The settings could not be saved right now. Try again shortly.",
    notConfigured:
      "Commerce is not initialized for this store yet. Ask a platform administrator to set the currency.",
  },
};

export function MerchantCommerceSettings({
  locale,
  readOnly,
  codOrdersEnabled,
  setting,
}: {
  locale: MerchantLocale;
  readOnly: boolean;
  codOrdersEnabled: boolean;
  setting: {
    currency: string;
    codEnabled: boolean;
    deliveryFee: string;
    deliveryFeeConfigured: boolean;
  } | null;
}) {
  const copy = COPY[locale];
  const [codEnabled, setCodEnabled] = useState(setting?.codEnabled ?? false);
  const [deliveryFee, setDeliveryFee] = useState(
    setting?.deliveryFeeConfigured ? setting.deliveryFee : "",
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [isSaving, startSaving] = useTransition();

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (readOnly || isSaving) return;

    setMessage(null);

    startSaving(async () => {
      const result = await saveMerchantCommerceSettingAction({
        codEnabled,
        deliveryFee,
      });

      if (result.ok) {
        setDeliveryFee(
          result.setting.deliveryFeeConfigured
            ? result.setting.deliveryFee
            : "",
        );
        setMessage({ ok: true, text: copy.saved });
        return;
      }

      setMessage({
        ok: false,
        text:
          result.error === "INVALID_INPUT"
            ? copy.invalid
            : result.error === "DENIED"
              ? copy.denied
              : result.error === "COMMERCE_NOT_CONFIGURED"
                ? copy.notConfigured
                : copy.unavailable,
      });
    });
  }

  return (
    <section
      dir={copy.dir}
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid="merchant-commerce-settings"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Wallet className="size-5" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-semibold">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
          {setting ? (
            <p className="text-sm text-muted-foreground">
              {copy.currencyLabel}:{" "}
              <span dir="ltr" className="font-medium text-foreground">
                {setting.currency}
              </span>
            </p>
          ) : (
            <p className="text-sm text-destructive">{copy.notConfigured}</p>
          )}
        </div>
      </div>

      <form onSubmit={save} className="space-y-3" noValidate>
        <label
          className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-input bg-background px-3 py-2 text-sm ${
            readOnly ? "cursor-not-allowed opacity-60" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={codEnabled}
            disabled={readOnly || isSaving}
            onChange={(event) => {
              setCodEnabled(event.target.checked);
              setMessage(null);
            }}
            data-testid="merchant-commerce-cod"
            className="mt-0.5 size-4 accent-primary"
          />
          <span className="space-y-0.5">
            <span className="block font-medium">{copy.codLabel}</span>
            <span className="block text-muted-foreground">{copy.codHint}</span>
            {codOrdersEnabled ? null : (
              <span className="block text-amber-700 dark:text-amber-300">
                {copy.codDeploymentHint}
              </span>
            )}
          </span>
        </label>

        <div className="space-y-1.5">
          <label
            htmlFor="merchant-commerce-delivery-fee"
            className="block text-sm font-medium"
          >
            {copy.feeLabel}
          </label>
          <input
            id="merchant-commerce-delivery-fee"
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            value={deliveryFee}
            disabled={readOnly || isSaving}
            onChange={(event) => {
              setDeliveryFee(event.target.value);
              setMessage(null);
            }}
            placeholder={copy.feePlaceholder}
            data-testid="merchant-commerce-delivery-fee"
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-48"
          />
          <p className="text-xs text-muted-foreground">{copy.feeHint}</p>
        </div>

        {message ? (
          <p
            role="status"
            className={`text-sm font-medium ${
              message.ok
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-destructive"
            }`}
          >
            {message.text}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={readOnly || isSaving}
          className="min-h-11 w-full gap-2 sm:w-auto"
          data-testid="merchant-commerce-save"
        >
          {isSaving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Wallet className="size-4" aria-hidden="true" />
          )}
          {isSaving ? copy.saving : copy.save}
        </Button>
      </form>
    </section>
  );
}
