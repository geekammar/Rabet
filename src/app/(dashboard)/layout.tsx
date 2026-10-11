import { Suspense } from "react";

import { Header } from "@/components/dashboard/header";
import { Sidebar } from "@/components/dashboard/sidebar";
import { requireAdmin } from "@/lib/auth/session";

/**
 * Authoritative authorization gate for the whole dashboard route group.
 *
 * Every dashboard section is protected here on the server, not in the client.
 * `proxy.ts` additionally performs an early optimistic redirect so an
 * unauthenticated visitor never downloads the dashboard shell in the first
 * place — but it is deliberately not the only check (see ADR-010).
 *
 * `requireAdmin()` reads the session cookie and sets private cache headers,
 * which are request-time reads. With `cacheComponents` enabled such access must
 * sit inside a `<Suspense>` boundary (reading `cookies()`/`headers()` outside
 * one is a build error), so both are pushed into `AdminGate`. Nothing below the
 * gate is rendered, streamed or included in the RSC payload until the session
 * has been verified; on the unauthenticated path `redirect()` throws and the
 * remainder of the tree never renders.
 *
 * `instant = false` documents that navigations into the dashboard legitimately
 * block on the server while the session is checked — the route is personalized
 * and can never be part of the static shell.
 */

// Mark navigations into the dashboard as allowed to block on the server.
export const instant = false;

async function AdminGate({ children }: { children: React.ReactNode }) {
  // Verifies the admin session; throws a redirect to /login when absent.
  // The `private, no-store` cache policy for these routes is declared
  // statically in `next.config.ts`.
  await requireAdmin();

  return <>{children}</>;
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main id="main" className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 pb-[max(env(safe-area-inset-bottom),1.5rem)] pt-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardShell>
      <Suspense fallback={null}>
        <AdminGate>{children}</AdminGate>
      </Suspense>
    </DashboardShell>
  );
}
