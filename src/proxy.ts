import { auth } from "@/auth";
import {
  checkOperatorAccess,
  isOperatorAccessPath,
  operatorAccessChallenge,
} from "@/lib/auth/operator-access";

/**
 * Optimistic authorization redirect for the dashboard (Next.js 16 Proxy).
 *
 * In Next.js 16 the `middleware.ts` convention was renamed to `proxy.ts`, and
 * the Auth.js v5 docs document wrapping the exported `auth` helper in the
 * `proxy` function for Next.js 16.
 *
 * This is deliberately an *optimistic* check only: it reads the session cookie
 * and redirects early so an unauthenticated visitor never downloads the
 * dashboard shell. It is NOT the sole authorization layer. The authoritative
 * check is `requireAdmin()` in `src/lib/auth/session.ts`, which every
 * protected Server Component, Server Action and Route Handler calls — see
 * docs/ARCHITECTURE.md (ADR-010).
 *
 * Scope: dashboard routes get the optimistic session redirect. The two paths
 * that can spend the shared admin login budget — `/login` (the Server Action)
 * and the Auth.js credentials callback — additionally require the operator
 * access credential. Public pages, `/api/healthz` and the Telegram webhook do
 * not pass through this gate. Static/PWA assets stay reachable while signed
 * out, so the installed PWA can always present the login screen.
 *
 * The matcher includes only the credentials callback from `/api/auth/*`; the
 * rest of the Auth.js handler stays outside the proxy.
 */

/** Dashboard sections that require an authenticated administrator. */
const PROTECTED_PREFIXES = [
  "/overview",
  "/products",
  "/categories",
  "/storefront",
  "/catalog",
  "/payment-methods",
  "/inquiries",
  "/customers",
  "/bot-content",
  "/telegram",
  "/settings",
] as const;

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export const proxy = auth((req) => {
  // Operator access is checked before Auth.js or any credential work. This
  // applies to both the login Server Action path and the direct credentials
  // callback, and returns the same 401 for missing, invalid or unconfigured
  // access. Rejected requests never reach the limiter or Argon2.
  if (
    isOperatorAccessPath(req.nextUrl.pathname) &&
    !checkOperatorAccess(req.headers.get("authorization"))
  ) {
    return operatorAccessChallenge();
  }

  // `req.auth` is the session resolved by Auth.js, or `null`. Reading it here
  // is the optimistic cookie read — cheap, and never a database lookup.
  if (!req.auth && isProtectedPath(req.nextUrl.pathname)) {
    // Fixed internal destination: this redirect can never be steered by user
    // input, so it cannot become an open redirect.
    const signInUrl = new URL("/login", req.nextUrl.origin);
    return Response.redirect(signInUrl);
  }

  return undefined;
});

export const config = {
  matcher: [
    /*
     * Run on every route except:
     * - api/auth/* except callback/credentials  the other Auth.js endpoints
     * - api/healthz    unauthenticated container liveness check (must not invoke Auth.js)
     * - _next/static, _next/image, favicon.ico and other static assets, so
     *   the PWA shell, icons and manifest always load while signed out
     */
    "/((?!api/auth/(?!callback/credentials)|api/healthz|_next/static|_next/image|favicon.ico|icons|manifest.webmanifest|robots.txt|sitemap.xml).*)",
  ],
};
