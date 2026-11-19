import "server-only";

/**
 * Small HTTP helpers for the unauthenticated invitation endpoints.
 *
 * Invitation responses are never cached, never indexed and never leak a
 * referrer. The token is only ever read from the JSON request body, so it does
 * not appear in a server URL, access log, redirect or `Referer` header.
 */

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export const INVITATION_BODY_MAX_BYTES = 8 * 1024;

export function merchantJson(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

export function merchantNotFoundResponse(): Response {
  return merchantJson({ ok: false, code: "NOT_FOUND" }, 404);
}

/**
 * Rejects cross-origin and missing-origin POSTs. Browsers send `Origin` on a
 * same-origin `fetch` POST; comparing its host to the request host stops a
 * foreign page from using a victim's browser as a blind caller.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (!origin) return false;

  let originHost: string;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    originHost = parsed.host;
  } catch {
    return false;
  }

  const hosts = [
    request.headers.get("host"),
    request.headers.get("x-forwarded-host"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return hosts.some((host) => host.toLowerCase() === originHost.toLowerCase());
}

/**
 * Reads an object-shaped JSON body with a hard byte cap. A missing, malformed
 * or oversized body returns `null`; the caller answers with its generic
 * rejection so the response shape does not reveal which check failed.
 */
export async function readMerchantJson(
  request: Request,
  maxBytes = INVITATION_BODY_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    return null;
  }

  const declaredLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return null;
  }

  let text: string;

  try {
    text = await request.text();
  } catch {
    return null;
  }

  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
