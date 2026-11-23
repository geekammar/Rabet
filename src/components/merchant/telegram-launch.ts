/**
 * Android app-targeted Telegram launch links.
 *
 * Chrome Android only launches a specific package from an `intent:` URL with a
 * direct user gesture. A plain `tg://` or `t.me/...` link is resolved by the
 * OS/app defaults, so it cannot offer a Telegram vs Telegram X choice. Both
 * package-targeted intents below preserve the same Telegram start parameter.
 */

export const TELEGRAM_ANDROID_PACKAGE = "org.telegram.messenger";
export const TELEGRAM_X_ANDROID_PACKAGE = "org.thunderdog.challegram";

export type TelegramLaunchTarget = "telegram" | "telegram-x";

export interface TelegramLaunchLinks {
  webUrl: string;
  telegramIntent: string;
  telegramXIntent: string;
}

export interface TelegramDeepLinkParts {
  username: string;
  start: string | null;
}

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

/** Parses a Telegram HTTPS deep link and returns the username and start value. */
export function parseTelegramDeepLink(
  httpsUrl: string,
): TelegramDeepLinkParts | null {
  let url: URL;

  try {
    url = new URL(httpsUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !TELEGRAM_HOSTS.has(url.hostname)) {
    return null;
  }

  const username = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");

  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
    return null;
  }

  return {
    username,
    start: url.searchParams.get("start"),
  };
}

/**
 * Builds package-targeted Android intent URLs for regular Telegram and
 * Telegram X. The browser fallback is a Nokmel setup URL, not the generic
 * Telegram HTTPS link, so a missing app cannot silently open the other app.
 */
export function buildTelegramLaunchLinks(
  httpsUrl: string,
  fallbackUrl: string,
): TelegramLaunchLinks | null {
  const parts = parseTelegramDeepLink(httpsUrl);
  if (!parts) return null;

  const params = new URLSearchParams({ domain: parts.username });
  if (parts.start !== null && parts.start.length > 0) {
    params.set("start", parts.start);
  }

  const query = params.toString();
  const encodedFallback = encodeURIComponent(fallbackUrl);

  const intentFor = (packageName: string) =>
    `intent://resolve?${query}#Intent;scheme=tg;package=${packageName};S.browser_fallback_url=${encodedFallback};end`;

  return {
    webUrl: httpsUrl,
    telegramIntent: intentFor(TELEGRAM_ANDROID_PACKAGE),
    telegramXIntent: intentFor(TELEGRAM_X_ANDROID_PACKAGE),
  };
}

/** A Nokmel-owned fallback URL that keeps the same pending attempt state. */
export function buildTelegramLaunchFallbackUrl(
  origin: string,
  target: TelegramLaunchTarget,
): string {
  const url = new URL("/app/setup", origin);
  url.hash = `telegram-launch-failed=${target}`;
  return url.toString();
}
