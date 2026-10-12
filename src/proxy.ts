import { auth } from "@/auth";

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
 * Scope: only dashboard routes are gated here. The public landing page, the
 * sign-in page, the Auth.js route handler and static/PWA assets stay reachable
 * while signed out, so the installed PWA can always present the login screen.
 *
 * The matcher excludes static assets and the Auth.js route handler. Note that
 * excluding a path also skips Server Function (Server Action) invocations on
 * that path, which is exactly why each Server Action re-verifies the session
 * itself instead of relying on this proxy.
 */

/** Dashboard sections that require an authenticated administrator. */
const PROTECTED_PREFIXES = [
  "/overview",
  "/catalog",
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
     * - api/auth/...   the Auth.js route handler (must stay public)
     * - _next/static, _next/image, favicon.ico and other static assets, so
     *   the PWA shell, icons and manifest always load while signed out
     */
    "/((?!api/auth|_next/static|_next/image|favicon.ico|icons|manifest.webmanifest|robots.txt|sitemap.xml).*)",
  ],
};
