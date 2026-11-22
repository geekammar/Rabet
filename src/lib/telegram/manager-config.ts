import "server-only";

/**
 * Operator-owned configuration for the platform manager bot.
 *
 * The manager bot token and webhook secret are environment secrets, exactly
 * like the legacy customer bot token. They are never stored per merchant, never
 * returned to a browser and never placed in a deep link.
 */

export const MANAGER_BOT_TOKEN_ENV = "TELEGRAM_MANAGER_BOT_TOKEN";
export const MANAGER_BOT_WEBHOOK_SECRET_ENV = "TELEGRAM_MANAGER_WEBHOOK_SECRET";

export type ManagerBotConfig = {
  token: string;
  webhookSecret: string;
};

export class ManagerBotConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerBotConfigurationError";
  }
}

/** Reads the manager bot secrets, failing closed when either is absent. */
export function readManagerBotConfig(): ManagerBotConfig {
  const token = process.env[MANAGER_BOT_TOKEN_ENV];
  const webhookSecret = process.env[MANAGER_BOT_WEBHOOK_SECRET_ENV];

  if (typeof token !== "string" || token.trim().length === 0) {
    throw new ManagerBotConfigurationError(
      `${MANAGER_BOT_TOKEN_ENV} is not configured.`,
    );
  }

  if (
    typeof webhookSecret !== "string" ||
    webhookSecret.trim().length === 0
  ) {
    throw new ManagerBotConfigurationError(
      `${MANAGER_BOT_WEBHOOK_SECRET_ENV} is not configured.`,
    );
  }

  return { token: token.trim(), webhookSecret: webhookSecret.trim() };
}

/**
 * Resolves the approved public application origin used for Telegram webhooks.
 *
 * `APP_URL` wins, then the build-time public URL and finally Auth.js's URL.
 * Production requires HTTPS and rejects loopback hosts. The returned value
 * never includes a trailing slash.
 */
export function resolveTrustedAppOrigin(): string {
  const raw =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.AUTH_URL;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ManagerBotConfigurationError(
      "A public application URL is required to register Telegram webhooks.",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ManagerBotConfigurationError(
      "The configured public application URL is invalid.",
    );
  }

  if (process.env.NODE_ENV === "production") {
    if (parsed.protocol !== "https:") {
      throw new ManagerBotConfigurationError(
        "The public application URL must use HTTPS in production.",
      );
    }

    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.") ||
      hostname.endsWith(".localhost")
    ) {
      throw new ManagerBotConfigurationError(
        "The public application URL cannot point to loopback in production.",
      );
    }
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Builds the per-connection webhook URL. The id is random and encodes no store. */
export function buildManagedWebhookUrl(
  origin: string,
  connectionId: string,
): string {
  return `${origin.replace(/\/+$/, "")}/api/telegram/webhook/managed/${encodeURIComponent(
    connectionId,
  )}`;
}

/**
 * Suggests a Telegram-valid bot username from a store slug. The value is only
 * a suggestion shown in Telegram's creation UI; it is never ownership proof.
 */
export function suggestedBotUsername(storeSlug: string): string {
  const base = storeSlug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);

  const withPrefix = base.length > 0 ? `rabet_${base}` : "rabet_store";
  return `${withPrefix.slice(0, 28)}_bot`.slice(0, 32);
}
