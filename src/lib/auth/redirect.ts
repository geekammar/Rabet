import "server-only";

/**
 * Open-redirect protection for post-login destinations.
 *
 * After a successful sign-in the user is sent to the page they originally
 * requested. That destination arrives from the URL query string
 * (`?callbackUrl=...`), which is fully attacker-controlled, so it must be
 * validated before it is used in a redirect — otherwise the login page becomes
 * an open redirect (a phishing vector, and it also leaks the session cookie to
 * a third party under `SameSite=lax` on top-level navigations).
 *
 * Rules enforced here:
 * - Absolute URLs, protocol-relative URLs (`//evil.com`), and backslash-based
 *   evasions (`/\/evil.com`, `\\evil.com`) are rejected.
 * - Only a path starting with a single `/` is accepted, and it must resolve to
 *   a known internal dashboard route.
 * - Anything that does not validate falls back to the safe default
 *   `/overview`. Rejecting means redirecting to the default, never to the
 *   attacker's URL — the user still reaches a useful page.
 */

/** Where an authenticated admin lands when no valid destination was supplied. */
export const DEFAULT_LOGIN_REDIRECT = "/overview";

/**
 * Regular dashboard sections the admin may be sent to after login. Kept in one
 * place so the allowlist cannot drift from `src/lib/navigation.ts`.
 */
const ALLOWED_PREFIXES = [
  "/overview",
  "/catalog",
  "/inquiries",
  "/customers",
  "/bot-content",
  "/telegram",
  "/settings",
] as const;

/** True when `path` is a safe internal destination for post-login redirect. */
export function isValidInternalRedirect(path: string): boolean {
  // Reject anything that is not a plain relative path. Handling these first
  // avoids `new URL()` resolving a protocol-relative string against the origin.
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.startsWith("/\\")) return false;
  if (path.startsWith("/%2f") || path.startsWith("/%5c")) return false;

  // Decode percent-escapes before the prefix check, so an encoded evasion such
  // as `/%2f%2fevil.com` cannot slip through.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }

  // Re-check after decoding; decoding may have introduced a scheme.
  if (decoded.includes("//") || decoded.startsWith("/\\") || /:\/\//.test(decoded)) {
    return false;
  }

  // Strip any query/fragment before matching the route prefix.
  const pathname = decoded.split(/[?#]/, 1)[0];

  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Validates a caller-supplied destination, falling back to the safe default.
 *
 * Accepts `null`/`undefined` and any non-string value without throwing.
 */
export function safeLoginRedirect(callbackUrl: unknown): string {
  if (typeof callbackUrl !== "string") return DEFAULT_LOGIN_REDIRECT;
  if (!isValidInternalRedirect(callbackUrl)) return DEFAULT_LOGIN_REDIRECT;
  return callbackUrl;
}
