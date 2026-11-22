"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import {
  merchantLogin,
  type MerchantLoginState,
} from "@/app/actions/merchant-auth";
import { Logo } from "@/components/brand/logo";
import {
  MerchantLanguageToggle,
  type MerchantLocale,
} from "@/components/merchant/language-toggle";
import { useMerchantLocale } from "@/components/merchant/use-merchant-locale";
import { Button } from "@/components/ui/button";

const COPY = {
  ar: {
    dir: "rtl" as const,
    title: "تسجيل دخول التاجر",
    subtitle: "سجّل الدخول لإدارة متجرك.",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    submit: "تسجيل الدخول",
    pending: "جارٍ تسجيل الدخول…",
    invalid: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
    unavailable: "تسجيل دخول التاجر غير متاح حاليًا.",
    languageLabel: "لغة الصفحة",
    showPassword: "إظهار كلمة المرور",
    hidePassword: "إخفاء كلمة المرور",
  },
  en: {
    dir: "ltr" as const,
    title: "Merchant sign in",
    subtitle: "Sign in to manage your store.",
    email: "Email",
    password: "Password",
    submit: "Sign in",
    pending: "Signing in…",
    invalid: "Incorrect email or password.",
    unavailable: "Merchant sign-in is not available.",
    languageLabel: "Page language",
    showPassword: "Show password",
    hidePassword: "Hide password",
  },
};

export function MerchantLoginForm({
  initialLocale,
}: {
  initialLocale: MerchantLocale;
}) {
  const [state, formAction, pending] = useActionState<MerchantLoginState, FormData>(
    merchantLogin,
    {},
  );
  const [locale, setLocale] = useMerchantLocale(initialLocale, "login");
  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const copy = COPY[locale];
  const errorMessage =
    state?.error === "INVALID_CREDENTIALS"
      ? copy.invalid
      : state?.error === "UNAVAILABLE"
        ? copy.unavailable
        : null;

  return (
    <div
      dir={copy.dir}
      lang={locale}
      className="flex min-h-dvh w-full flex-col bg-background"
      data-testid="merchant-login-page"
    >
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center justify-between gap-3">
            <Logo className="text-lg" />
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

          <form
            action={formAction}
            noValidate
            className="space-y-4"
            aria-describedby={errorMessage ? "merchant-login-error" : undefined}
          >
            <div className="space-y-2">
              <label
                htmlFor="merchant-email"
                className="text-sm font-medium text-foreground"
              >
                {copy.email}
              </label>
              <input
                id="merchant-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                required
                aria-required="true"
                aria-invalid={errorMessage ? "true" : undefined}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-testid="merchant-login-email"
                className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="merchant-password"
                className="text-sm font-medium text-foreground"
              >
                {copy.password}
              </label>
              <div className="relative">
                <input
                  id="merchant-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  aria-required="true"
                  aria-invalid={errorMessage ? "true" : undefined}
                  data-testid="merchant-login-password"
                  className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 pe-11 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-pressed={showPassword}
                  aria-label={
                    showPassword ? copy.hidePassword : copy.showPassword
                  }
                  className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {showPassword ? (
                    <EyeOff className="size-4.5" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {errorMessage ? (
              <p
                id="merchant-login-error"
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
                data-testid="merchant-login-error"
              >
                {errorMessage}
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={pending}
              className="h-11 w-full text-base"
              data-testid="merchant-login-submit"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4.5 animate-spin" aria-hidden="true" />
                  {copy.pending}
                </>
              ) : (
                copy.submit
              )}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
