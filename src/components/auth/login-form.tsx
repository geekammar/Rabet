"use client";

import { useActionState, useRef, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { login, type LoginState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Mobile-first sign-in form.
 *
 - Accessible labels (`htmlFor`/`id`), `aria-describedby` wiring and a live
 *   error region driven by `useActionState`.
 * - `autoComplete` attributes so password managers and the Android autofill
 *   framework fill the fields correctly (`username` for the email field of a
 *   credentials sign-in, `current-password` for the password).
 * - `inputMode="email"` surfaces the email keyboard on mobile.
 * - 44px+ touch targets on the submit button and the password toggle.
 * - Width-constrained so nothing overflows a ~280–320px viewport.
 * - Only a generic error message is ever shown (see the login Server Action):
 *   the form never reveals whether the email exists.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [showPassword, setShowPassword] = useState(false);
  // The visible error is derived from the action state, but it must also be
  // dismissible while the user edits a field. `errorDismissed` records that
  // dismissal; it is reset whenever a fresh action result arrives.
  const [errorDismissed, setErrorDismissed] = useState(false);
  // The previous action result, kept in state so a new one can be detected.
  // `useActionState` hands back a fresh object every time the action resolves,
  // so an identity comparison is a reliable "a new submission resolved" signal.
  const [prevState, setPrevState] = useState(state);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // When a fresh action result arrives, stop dismissing the previous error so
  // the new message is shown. Adjusting state during render (rather than in an
  // effect) is the documented React pattern for syncing derived state to a
  // changing dependency, and avoids a cascading render.
  if (state !== prevState) {
    setPrevState(state);
    setErrorDismissed(false);
  }

  const errorMessage =
    !errorDismissed && state?.message ? state.message : null;

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-5"
      // Move focus to the inline error banner when one appears.
      aria-describedby={errorMessage ? "login-error" : undefined}
    >
      <div className="space-y-2">
        <label
          htmlFor="email"
          className="text-sm font-medium text-foreground"
        >
          Email
        </label>
        <input
          id="email"
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
          aria-describedby={errorMessage ? "login-error" : undefined}
          placeholder="admin@example.com"
          className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          onChange={() => {
            if (errorMessage) setErrorDismissed(true);
          }}
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor="password"
          className="text-sm font-medium text-foreground"
        >
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            aria-required="true"
            aria-invalid={errorMessage ? "true" : undefined}
            aria-describedby={errorMessage ? "login-error" : undefined}
            placeholder="Your password"
            className="flex min-h-11 w-full rounded-lg border border-input bg-background px-3 pe-11 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            onChange={() => {
              if (errorMessage) setErrorDismissed(true);
            }}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-pressed={showPassword}
            aria-label={showPassword ? "Hide password" : "Show password"}
            // Controls the password field's own visibility.
            aria-controls="password"
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

      {/* Live error region. Screen readers announce this when it appears. */}
      {errorMessage ? (
        <p
          id="login-error"
          ref={errorRef}
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        disabled={pending}
        // 44px minimum touch target; `size="lg"` is h-9, so raise it here.
        className="h-11 w-full text-base"
      >
        {pending ? (
          <>
            <Loader2 className="size-4.5 animate-spin" aria-hidden="true" />
            <span className="sr-only">Signing in…</span>
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Forgot your password? Reset it from your server environment.
      </p>
    </form>
  );
}
