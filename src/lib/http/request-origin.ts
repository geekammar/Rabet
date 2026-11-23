import "server-only";

/** Server-side application origin variables, in priority order. */
export const TRUSTED_APP_ORIGIN_ENV_KEYS = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "AUTH_URL",
] as const;

/**
 * Returns the trusted application origin from server configuration, including
 * scheme and port. A missing or malformed value fails closed.
 */
export function trustedApplicationOrigin(): string | null {
  for (const key of TRUSTED_APP_ORIGIN_ENV_KEYS) {
    const raw = process.env[key];
    if (typeof raw !== "string" || raw.trim() === "") continue;

    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.origin;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Rejects cross-origin and missing-origin POSTs by comparing the complete
 * browser `Origin` to the trusted server-side application origin.
 *
 * Request `Host` and forwarded host headers are deliberately ignored: an
 * attacker-controlled forwarded header must never turn a mismatched Origin
 * into an accepted one.
 */
export function isSameOriginRequest(
  request: Request,
  trustedOrigin: string | null = trustedApplicationOrigin(),
): boolean {
  if (!trustedOrigin) return false;

  const origin = request.headers.get("origin");

  if (!origin) return false;

  try {
    const parsed = new URL(origin);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return parsed.origin === trustedOrigin;
  } catch {
    return false;
  }
}

/**
 * Verifies a browser form post that navigates to the same application.
 *
 * Authenticated pages set `Referrer-Policy: no-referrer`, and Chrome then sends
 * `Origin: null` for an ordinary same-origin form post. In that case Fetch
 * Metadata still proves the request came from this same origin. A cross-site
 * poster cannot set `Sec-Fetch-Site: same-origin`, and SameSite session cookies
 * are not sent on a cross-site POST anyway.
 */
export function isSameOriginNavigationPost(
  request: Request,
  trustedOrigin: string | null = trustedApplicationOrigin(),
): boolean {
  if (!trustedOrigin) return false;

  if (request.headers.get("origin") === "null") {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }

  return isSameOriginRequest(request, trustedOrigin);
}
