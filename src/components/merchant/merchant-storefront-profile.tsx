"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { saveMerchantStorefrontProfile } from "@/app/actions/merchant-storefront-profile";
import { Button } from "@/components/ui/button";
import type { MerchantLocale } from "@/lib/merchant/locale";
import {
  STOREFRONT_PROFILE_LIMITS,
  storefrontImageUrl,
  storefrontWelcomeLines,
  type StorefrontProfile,
} from "@/lib/merchant/storefront-profile-fields";
import { managedCommerceCopy } from "@/lib/telegram/managed-commerce-copy";

const COPY = {
  ar: {
    title: "هوية واجهة المتجر",
    back: "الرجوع للوحة المتجر",
    preview: "معاينة بطاقة الترحيب",
    save: "حفظ وعرض في البوت",
    pending: "جارٍ الحفظ…",
    saved: "تم الحفظ. تظهر الهوية عند فتح واجهة المتجر في البوت.",
    denied: "تعديل هوية هذا المتجر غير متاح لحسابك الآن.",
    unavailable: "تعذر الحفظ. جرّب مرة أخرى.",
    invalid: "راجع طول الحقل أو استخدم رابط HTTPS صالحًا للصورة.",
    imageHelp: "الغلاف يظهر أولًا. الشعار يظهر عند غياب الغلاف.",
    fields: {
      displayName: "اسم المتجر الظاهر للمشتري",
      welcome: "نص الترحيب",
      description: "وصف المتجر",
      logoUrl: "رابط الشعار",
      coverUrl: "رابط الغلاف",
    },
  },
  en: {
    title: "Storefront identity",
    back: "Back to store setup",
    preview: "Welcome card preview",
    save: "Save and show in bot",
    pending: "Saving…",
    saved: "Saved. The identity appears when the storefront opens in the bot.",
    denied: "Your account cannot edit this storefront right now.",
    unavailable: "Could not save. Try again.",
    invalid: "Check the field length or use a valid HTTPS image URL.",
    imageHelp: "The cover takes priority. The logo appears when no cover is set.",
    fields: {
      displayName: "Buyer-facing store name",
      welcome: "Welcome text",
      description: "Store description",
      logoUrl: "Logo URL",
      coverUrl: "Cover URL",
    },
  },
};

export function MerchantStorefrontProfile({
  initial, locale, storeName, readOnly,
}: {
  initial: StorefrontProfile;
  locale: MerchantLocale;
  storeName: string;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [state, action, pending] = useActionState(saveMerchantStorefrontProfile, { status: "idle" });
  const copy = COPY[locale];
  const telegram = managedCommerceCopy(locale);
  const photo = storefrontImageUrl(draft.coverUrl) ?? storefrontImageUrl(draft.logoUrl);
  const lines = storefrontWelcomeLines(draft, storeName, telegram.welcome);
  const notice = state.status === "idle" ? null : copy[state.status];

  return (
    <main lang={locale} dir={locale === "ar" ? "rtl" : "ltr"}
      className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <Link className="text-sm text-primary underline" href="/app/setup">{copy.back}</Link>
      <h1 className="text-2xl font-semibold">{copy.title}</h1>

      <form action={action} className="space-y-4" data-testid="merchant-storefront-profile">
        <fieldset disabled={readOnly || pending} className="space-y-4">
          {(Object.keys(copy.fields) as Array<keyof StorefrontProfile>).map((field) => {
            const image = field.endsWith("Url");
            const props = {
              name: field,
              value: draft[field],
              maxLength: STOREFRONT_PROFILE_LIMITS[field],
              onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setDraft({ ...draft, [field]: event.target.value }),
              "aria-invalid": state.status === "invalid" && state.field === field,
              className: "min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base",
            };
            return (
              <label key={field} className="block space-y-1 text-sm font-medium">
                <span>{copy.fields[field]}</span>
                {field === "description" || field === "welcome"
                  ? <textarea {...props} rows={3} />
                  : <input {...props} type={image ? "url" : "text"} dir={image ? "ltr" : undefined} />}
              </label>
            );
          })}
          <p className="text-sm text-muted-foreground">{copy.imageHelp}</p>
          <Button type="submit" className="min-h-11">{pending ? copy.pending : copy.save}</Button>
        </fieldset>
        {notice && <p role="status" className="text-sm">{notice}</p>}
      </form>

      <section data-testid="merchant-storefront-preview" className="space-y-3 rounded-xl border p-4">
        <h2 className="text-lg font-semibold">{copy.preview}</h2>
        {photo && (
          // eslint-disable-next-line @next/next/no-img-element -- merchant URLs are loaded directly by the browser
          <img src={photo} alt="" referrerPolicy="no-referrer"
            className="max-h-64 w-full rounded-md object-contain" />
        )}
        {lines.map((line, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">{line}</p>
        ))}
        <p className="rounded-md bg-muted px-3 py-2 text-center font-medium">{telegram.browseProducts}</p>
      </section>
    </main>
  );
}
