"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { InvitationBrand } from "@/components/merchant/invitation-brand";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Button } from "@/components/ui/button";
import {
  INVITATION_PAGE_TITLE,
} from "@/lib/merchant-invitation/branding";
import { classifyInvitationFailure } from "@/lib/merchant-invitation/responses";

type Phase =
  | "reading"
  | "previewing"
  | "ready"
  | "invalid"
  | "rateLimited"
  | "unavailable"
  | "submitting"
  | "success";

type FieldErrors = {
  password?: "length";
  storeName?: "invalid";
};

type Copy = {
  dir: "rtl" | "ltr";
  title: string;
  subtitle: string;
  emailLabel: string;
  storeLabel: string;
  passwordLabel: string;
  passwordHint: string;
  submit: string;
  submitting: string;
  previewing: string;
  invalid: string;
  unavailable: string;
  passwordLength: string;
  storeNameInvalid: string;
  rateLimited: string;
  successTitle: string;
  successBody: string;
  goToLogin: string;
  languageLabel: string;
};

export const INVITATION_COPY: Record<MerchantLocale, Copy> = {
  ar: {
    dir: "rtl",
    title: INVITATION_PAGE_TITLE.ar,
    subtitle: "أنشئ حسابك للبدء في إعداد متجرك.",
    emailLabel: "البريد الإلكتروني المدعو",
    storeLabel: "اسم المتجر",
    passwordLabel: "كلمة المرور",
    passwordHint: "12 حرفًا على الأقل.",
    submit: "افتح متجري",
    submitting: "جارٍ التحقق…",
    previewing: "جارٍ التحقق من الدعوة…",
    invalid:
      "هذه الدعوة غير صالحة أو منتهية. اطلب دعوة جديدة من مسؤول المنصة.",
    unavailable: "تعذر التحقق من الدعوة الآن. حاول مرة أخرى بعد قليل.",
    passwordLength: "يجب أن تكون كلمة المرور بين 12 و1024 حرفًا.",
    storeNameInvalid: "أدخل اسمًا للمتجر لا يتجاوز 255 حرفًا.",
    rateLimited: "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
    successTitle: "تم إنشاء حسابك",
    successBody: "يمكنك الآن تسجيل الدخول إلى متجرك.",
    goToLogin: "الانتقال إلى تسجيل الدخول",
    languageLabel: "لغة الصفحة",
  },
  en: {
    dir: "ltr",
    title: INVITATION_PAGE_TITLE.en,
    subtitle: "Create your account to start setting up your store.",
    emailLabel: "Invited email",
    storeLabel: "Store name",
    passwordLabel: "Password",
    passwordHint: "At least 12 characters.",
    submit: "Open my store",
    submitting: "Verifying…",
    previewing: "Checking the invitation…",
    invalid:
      "This invitation is not valid or can no longer be used. Ask the platform administrator for a new invitation.",
    unavailable: "The invitation could not be checked right now. Try again shortly.",
    passwordLength: "The password must be between 12 and 1024 characters.",
    storeNameInvalid: "Enter a store name of up to 255 characters.",
    rateLimited: "Too many attempts. Wait a moment and try again.",
    successTitle: "Your account is ready",
    successBody: "You can now sign in to your store.",
    goToLogin: "Go to sign in",
    languageLabel: "Page language",
  },
};

type Preview = { email: string; storeName: string };

function readFragmentToken(): string | null {
  if (typeof window === "undefined") return null;

  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;

  const token = new URLSearchParams(hash).get("token");

  return token && token.length > 0 ? token : null;
}

export function InvitationAcceptance({
  initialLocale,
}: {
  initialLocale: MerchantLocale;
}) {
  const [locale, setLocale] = useMerchantLocale(initialLocale, "invite");
  const [phase, setPhase] = useState<Phase>("previewing");
  const tokenRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const storeNameRef = useRef<HTMLInputElement>(null);
  const copy = INVITATION_COPY[locale];

  useEffect(() => {
    const fragmentToken = readFragmentToken();
    tokenRef.current = fragmentToken;

    if (!fragmentToken) {
      queueMicrotask(() => setPhase("invalid"));
      return;
    }

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/merchant-invitations/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: fragmentToken }),
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
          referrerPolicy: "no-referrer",
        });

        const data: unknown = await response.json().catch(() => null);

        if (
          response.ok &&
          data &&
          typeof data === "object" &&
          (data as { ok?: unknown }).ok === true &&
          typeof (data as { email?: unknown }).email === "string" &&
          typeof (data as { storeName?: unknown }).storeName === "string"
        ) {
          setPreview({
            email: (data as { email: string }).email,
            storeName: (data as { storeName: string }).storeName,
          });
          setPhase("ready");
          return;
        }

        const failure = classifyInvitationFailure(response.status);
        setPhase(
          failure === "rate_limited"
            ? "rateLimited"
            : failure === "unavailable"
              ? "unavailable"
              : "invalid",
        );
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setPhase("unavailable");
      }
    })();

    return () => controller.abort();
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const token = tokenRef.current;

    if (!token || phase === "submitting") return;

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const storeName = String(form.get("storeName") ?? "").trim();
    const nextErrors: FieldErrors = {};

    if (password.length < 12 || password.length > 1024) {
      nextErrors.password = "length";
    }

    if (!storeName || storeName.length > 255) {
      nextErrors.storeName = "invalid";
    }

    setFieldErrors(nextErrors);
    setFormError(null);

    if (Object.keys(nextErrors).length > 0) {
      if (nextErrors.password) passwordRef.current?.focus();
      else storeNameRef.current?.focus();
      return;
    }

    setPhase("submitting");

    try {
      const response = await fetch("/api/merchant-invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, storeName }),
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      });

      const data: unknown = await response.json().catch(() => null);

      if (
        response.ok &&
        data &&
        typeof data === "object" &&
        (data as { ok?: unknown }).ok === true
      ) {
        tokenRef.current = null;
        setPreview(null);
        setPhase("success");
        window.history.replaceState(null, "", "/invite");
        if ((data as { redirectTo?: unknown }).redirectTo === "/app/setup") {
          window.location.replace("/app/setup");
        }
        return;
      }

      if (response.status === 429) {
        setPhase("ready");
        setFormError(copy.rateLimited);
        return;
      }

      if (
        response.status === 400 &&
        data &&
        typeof data === "object" &&
        (data as { code?: unknown }).code === "FIELD_ERROR"
      ) {
        const serverErrors = (data as { fieldErrors?: Record<string, unknown> })
          .fieldErrors;
        const mapped: FieldErrors = {};

        if (serverErrors?.password === "PASSWORD_LENGTH") {
          mapped.password = "length";
        }

        if (serverErrors?.storeName === "STORE_NAME_INVALID") {
          mapped.storeName = "invalid";
        }

        setFieldErrors(mapped);
        setPhase("ready");
        return;
      }

      if (response.status === 503) {
        setPhase("unavailable");
        return;
      }

      setPhase("invalid");
    } catch {
      setPhase("unavailable");
    }
  }

  const busy = phase === "reading" || phase === "previewing";

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="invite-page"
    >
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center justify-between gap-3">
            <InvitationBrand locale={locale} />
            <MerchantLanguageToggle
              locale={locale}
              onChange={setLocale}
              label={copy.languageLabel}
            />
          </div>

          <div className="space-y-1.5 text-start">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              {copy.title}
            </h1>
            <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
          </div>

          {busy ? (
            <p
              role="status"
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground"
              data-testid="invite-loading"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {copy.previewing}
            </p>
          ) : null}

          {phase === "invalid" ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm font-medium text-destructive"
              data-testid="invite-error"
            >
              {copy.invalid}
            </p>
          ) : null}

          {phase === "rateLimited" ? (
            <p
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              data-testid="invite-rate-limited"
            >
              {copy.rateLimited}
            </p>
          ) : null}

          {phase === "unavailable" ? (
            <p
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm font-medium text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              data-testid="invite-error"
            >
              {copy.unavailable}
            </p>
          ) : null}

          {phase === "success" ? (
            <div
              className="space-y-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100"
              data-testid="invite-success"
              role="status"
            >
              <div className="space-y-1">
                <p className="font-semibold">{copy.successTitle}</p>
                <p className="text-sm">{copy.successBody}</p>
              </div>
              <Button asChild size="lg" className="h-11 w-full text-base">
                <Link href="/app/login" data-testid="invite-login-link">
                  {copy.goToLogin}
                </Link>
              </Button>
            </div>
          ) : null}

          {preview && (phase === "ready" || phase === "submitting") ? (
            <div className="space-y-5">
              <dl className="space-y-3 rounded-xl border border-border bg-muted/30 p-4 text-sm">
                <div className="space-y-0.5">
                  <dt className="text-muted-foreground">{copy.emailLabel}</dt>
                  <dd
                    className="break-all font-medium text-foreground"
                    data-testid="invite-email"
                  >
                    {preview.email}
                  </dd>
                </div>
              </dl>

              <form onSubmit={submit} noValidate className="space-y-4">
                <div className="space-y-2">
                  <label htmlFor="invite-store-name" className="text-sm font-medium">
                    {copy.storeLabel}
                  </label>
                  <input
                    ref={storeNameRef}
                    id="invite-store-name"
                    name="storeName"
                    defaultValue={preview.storeName}
                    maxLength={255}
                    required
                    aria-invalid={fieldErrors.storeName ? true : undefined}
                    aria-describedby={fieldErrors.storeName ? "invite-store-error" : undefined}
                    data-testid="invite-store"
                    className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base"
                  />
                  {fieldErrors.storeName ? (
                    <p id="invite-store-error" className="text-sm text-destructive">
                      {copy.storeNameInvalid}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="invite-password"
                    className="text-sm font-medium text-foreground"
                  >
                    {copy.passwordLabel}
                  </label>
                  <input
                    ref={passwordRef}
                    id="invite-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={1024}
                    required
                    aria-required="true"
                    aria-invalid={fieldErrors.password ? "true" : undefined}
                    aria-describedby={
                      fieldErrors.password ? "invite-password-error" : "invite-password-hint"
                    }
                    data-testid="invite-password"
                    className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                  {fieldErrors.password ? (
                    <p
                      id="invite-password-error"
                      className="text-sm font-medium text-destructive"
                    >
                      {copy.passwordLength}
                    </p>
                  ) : (
                    <p
                      id="invite-password-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {copy.passwordHint}
                    </p>
                  )}
                </div>

                <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(event) => setShowPassword(event.target.checked)}
                    className="size-4 rounded border-input"
                  />
                  {locale === "ar" ? "إظهار كلمة المرور" : "Show password"}
                </label>

                {formError ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                    data-testid="invite-form-error"
                  >
                    {formError}
                  </p>
                ) : null}

                <Button
                  type="submit"
                  size="lg"
                  disabled={phase === "submitting"}
                  className="h-11 w-full text-base"
                  data-testid="invite-submit"
                >
                  {phase === "submitting" ? (
                    <>
                      <Loader2 className="size-4.5 animate-spin" aria-hidden="true" />
                      {copy.submitting}
                    </>
                  ) : (
                    copy.submit
                  )}
                </Button>
              </form>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
