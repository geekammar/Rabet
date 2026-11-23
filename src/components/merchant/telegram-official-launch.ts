/**
 * One-tap Android launch into official Telegram.
 *
 * Chrome Android resolves a plain `t.me`/`tg://` link through the OS default
 * app, which may be Telegram X. The original Nokmel button must open official
 * Telegram, so Android uses a package-targeted intent for
 * `org.telegram.messenger` only. iOS/desktop keep the HTTPS t.me link.
 */

export const OFFICIAL_TELEGRAM_ANDROID_PACKAGE = "org.telegram.messenger";

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

export function parseTelegramDeepLink(
  httpsUrl: string,
): { username: string; start: string | null } | null {
  let url: URL;

  try {
    url = new URL(httpsUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !TELEGRAM_HOSTS.has(url.hostname)) {
    return null;
  }

  const username = decodeURIComponent(
    url.pathname.replace(/^\/+/, "").split("/")[0] ?? "",
  );

  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
    return null;
  }

  return { username, start: url.searchParams.get("start") };
}

/**
 * Builds an Android intent that targets official Telegram only. If that app is
 * missing or the browser blocks the intent, Chrome goes to the Nokmel fallback
 * URL, preserving the current pending attempt instead of opening another app.
 */
export function buildOfficialTelegramIntent(
  httpsUrl: string,
  fallbackUrl: string,
): string | null {
  const parts = parseTelegramDeepLink(httpsUrl);
  if (!parts) return null;

  const params = new URLSearchParams({ domain: parts.username });
  if (parts.start !== null && parts.start.length > 0) {
    params.set("start", parts.start);
  }

  return `intent://resolve?${params.toString()}#Intent;scheme=tg;package=${OFFICIAL_TELEGRAM_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
}

export function buildTelegramLaunchFallbackUrl(origin: string): string {
  const url = new URL("/app/setup", origin);
  url.hash = "telegram-launch-failed=telegram";
  return url.toString();
}

export function isAndroidRuntime(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}
