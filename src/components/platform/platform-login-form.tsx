"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

import {
  platformLogin,
  type PlatformLoginState,
} from "@/app/actions/platform-auth";
import { Button } from "@/components/ui/button";

export function PlatformLoginForm() {
  const [state, formAction, pending] = useActionState<
    PlatformLoginState,
    FormData
  >(platformLogin, {});
  const [showPassword, setShowPassword] = useState(false);
  const error = state?.error ? "Incorrect email or password." : null;

  return (
    <form action={formAction} noValidate className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="platform-email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="platform-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          required
          aria-required="true"
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? "platform-login-error" : undefined}
          className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          placeholder="platform.admin@example.com"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="platform-password" className="text-sm font-medium">
          Password
        </label>
        <div className="relative">
          <input
            id="platform-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            aria-required="true"
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "platform-login-error" : undefined}
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 pe-11 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            placeholder="Your password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-pressed={showPassword}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-controls="platform-password"
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {showPassword ? (
              <EyeOff className="size-4.5" aria-hidden="true" />
            ) : (
              <Eye className="size-4.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {error ? (
        <p
          id="platform-login-error"
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <Button type="submit" className="min-h-11 w-full" disabled={pending}>
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="size-4" aria-hidden="true" />
        )}
        {pending ? "Signing in…" : "Sign in to platform administration"}
      </Button>
    </form>
  );
}
