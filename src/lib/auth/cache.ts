import "server-only";

/**
 * Cache headers for authenticated responses.
 *
 * Dashboard pages are personalized: they are only reachable by the signed-in
 * admin and will later carry customer, order and payment data. Such responses
 * must never be stored in a shared cache (CDN, proxy) or the browser cache,
 * otherwise a private page could be served to a different tenant of the same
 * cache, or replayed after logout.
 *
 * `private, no-store` is the strictest portable policy: it forbids both shared
 * and local caching of the response. This is applied on top of the fact that
 * `requireAdmin()` already makes these routes dynamic.
 *
 * Usage in a Route Handler:
 *
 *   return new Response(payload, { headers: privateCacheHeaders() });
 *
 * Or for a page/layout that needs it, export the header via `headers()` from
 * `next/headers` — see `src/app/(dashboard)/layout.tsx`.
 */
export function privateCacheHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store, must-revalidate",
    // Belt and braces for legacy intermediaries that only honour `Pragma`.
    Pragma: "no-cache",
  };
}
