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

/** Server-side application origin variables, in priority order. */
export const TRUSTED_APP_ORIGIN_ENV_KEYS = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "AUTH_URL",
] as const;

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

function hasValidJsonContentType(value: string): boolean {
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim());

  if (mediaType.toLowerCase() !== "application/json") return false;

  for (const parameter of parameters) {
    if (parameter === "") continue;

    const separator = parameter.indexOf("=");

    if (separator === -1) return false;

    const name = parameter.slice(0, separator).trim().toLowerCase();
    const parameterValue = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/g, "")
      .toLowerCase();

    if (name === "charset" && parameterValue !== "utf-8") return false;
  }

  return true;
}

/**
 * Reads an object-shaped JSON body with a hard byte cap.
 *
 * A declared `Content-Length` is checked first when present. The body is then
 * streamed into bounded chunks, and the reader is cancelled as soon as the cap
 * is crossed — the remainder is never buffered or parsed. This also enforces
 * the same cap for chunked requests without a `Content-Length`.
 *
 * A missing, malformed, oversized or non-object body returns `null`; the
 * caller answers with its generic rejection.
 */
export async function readMerchantJson(
  request: Request,
  maxBytes = INVITATION_BODY_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  if (!hasValidJsonContentType(request.headers.get("content-type") ?? "")) {
    return null;
  }

  const contentLength = request.headers.get("content-length");

  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) return null;

    const declared = Number(contentLength);

    if (!Number.isSafeInteger(declared) || declared > maxBytes) return null;
  }

  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }

      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

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
