import type { Metadata } from "next";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { PlatformLoginForm } from "@/components/platform/platform-login-form";
import { getPlatformAdminAccess } from "@/lib/auth/platform-session";

export const metadata: Metadata = {
  title: "Platform sign in",
  description: "Sign in to Rabet platform administration.",
  robots: { index: false, follow: false },
};

export const instant = false;

export default async function PlatformLoginPage() {
  await connection();

  const access = await getPlatformAdminAccess();

  if (access) redirect("/platform/invitations");

  return (
    <div className="flex min-h-dvh w-full flex-col bg-background" dir="ltr">
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center gap-6">
            <Logo className="text-xl" />
            <div className="space-y-1.5 text-center">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">
                Platform administration
              </h1>
              <p className="text-sm text-muted-foreground">
                Sign in with a named Super Admin account.
              </p>
            </div>
          </div>

          <PlatformLoginForm />
        </div>
      </main>
    </div>
  );
}
