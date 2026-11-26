/**
 * Merchant Telegram support contact normalization.
 *
 * The merchant may enter either an `@username` or a plain
 * `https://t.me/<username>` profile link. The stored value is the bare,
 * case-preserving Telegram username, so the buyer-facing link is always built
 * from one canonical form and a stray `@` or URL never reaches the catalog
 * renderer.
 *
 * Telegram usernames are 5–32 characters, may contain letters, numbers and
 * underscores, and may not start with a number. This module is deliberately
 * pure so the same rule is used by the merchant form, the server write path
 * and the managed Telegram webhook without a database or runtime dependency.
 */

const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TELEGRAM_PROFILE_URL_PATTERN =
  /^https:\/\/t\.me\/([^/?#]+)\/?$/i;

export type TelegramSupportUsernameParseResult =
  | { ok: true; username: string | null }
  | { ok: false; error: "INVALID_USERNAME" };

/**
 * Normalizes a submitted support account.
 *
 * An empty or whitespace-only value is an explicit clear (`username: null`).
 * Anything else must be an `@username` or an `https://t.me/<username>` link.
 */
export function parseTelegramSupportUsername(
  input: unknown,
): TelegramSupportUsernameParseResult {
  if (typeof input !== "string") {
    return { ok: false, error: "INVALID_USERNAME" };
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: true, username: null };
  }

  let candidate = trimmed;
  const profileUrl = TELEGRAM_PROFILE_URL_PATTERN.exec(trimmed);

  if (profileUrl) {
    candidate = profileUrl[1];
  } else if (candidate.startsWith("@")) {
    candidate = candidate.slice(1);
  } else {
    return { ok: false, error: "INVALID_USERNAME" };
  }

  if (!TELEGRAM_USERNAME_PATTERN.test(candidate)) {
    return { ok: false, error: "INVALID_USERNAME" };
  }

  return { ok: true, username: candidate };
}

/** True when a stored value is already the normalized bare username. */
export function isTelegramSupportUsername(
  value: unknown,
): value is string {
  return typeof value === "string" && TELEGRAM_USERNAME_PATTERN.test(value);
}

/**
 * Builds the direct chat link with an editable, URL-encoded draft.
 *
 * Telegram opens the account's chat with the text prefilled in the composer;
 * the buyer still presses Send themselves.
 */
export function telegramSupportChatUrl(
  username: string,
  draft: string,
): string {
  return `https://t.me/${encodeURIComponent(username)}?text=${encodeURIComponent(draft)}`;
}
