import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { Logo } from "@/components/brand/logo";
import { isAdminConfiguredAsync } from "@/lib/auth/admin-config";
import { getAdminSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to the Rabet admin dashboard.",
};

/**
 * Redirects an already-authenticated admin away from the sign-in page.
 *
 * Reading the session is a request-time access, so this must run inside a
 * `<Suspense>` boundary under Cache Components (a request read outside one is
 * a prerender error). The fallback renders nothing, which is correct: on the
 * authenticated path the user is redirected before any form appears, and on
 * the unauthenticated path the boundary resolves immediately.
 */
async function LoginContent() {
  // Both reads are request-time: the admin configuration comes from server
  // environment variables evaluated at runtime (never baked into a
  // prerender), and the session check redirects a signed-in admin away.
  const [configured, session] = await Promise.all([
    isAdminConfiguredAsync(),
    getAdminSession(),
  ]);

  if (session) {
    redirect("/overview");
  }

  if (!configured) {
    // Honest state when the deployment has not been provisioned with an
    // admin identity yet. No variable names or values are exposed.
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <p className="font-medium">Sign-in is unavailable</p>
        <p className="mt-1 text-amber-800 dark:text-amber-300/90">
          The administrator account has not been configured on this
          deployment. See the setup instructions in the repository README.
        </p>
      </div>
    );
  }

  return <LoginForm />;
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh w-full flex-col bg-background">
      <a
        href="#login-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to sign-in form
      </a>

      <main
        id="login-main"
        className="flex flex-1 items-center justify-center px-4 pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)]"
      >
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center gap-6">
            <Logo className="text-xl" />
            <div className="space-y-1.5 text-center">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">
                Sign in
              </h1>
              <p className="text-sm text-muted-foreground">
                Sign in to manage your Rabet dashboard.
              </p>
            </div>
          </div>

          {/* Request-time reads live inside this boundary so they are never
              baked into the static shell. */}
          <Suspense fallback={null}>
            <LoginContent />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
