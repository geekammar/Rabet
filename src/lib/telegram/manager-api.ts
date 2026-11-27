import "server-only";

import { sanitizeTelegramError } from "./transport";
import type { TelegramErrorKind, TelegramUser } from "./types";

/**
 * Minimal server-only Bot API client for the manager bot and managed bots.
 *
 * The existing `TelegramTransport` covers message transport for the legacy
 * journey. Managed-bot provisioning needs `getMe`, `getManagedBotToken`,
 * `setWebhook` and `getWebhookInfo`; this small client adds exactly those and
 * keeps the token out of every returned value and error.
 */

export interface TelegramBotApiFailure {
  ok: false;
  error: string;
  errorKind?: TelegramErrorKind;
  httpStatus?: number;
  retryAfterSeconds?: number;
}

export type TelegramBotApiResult<T> =
  | { ok: true; result: T }
  | TelegramBotApiFailure;

export interface TelegramWebhookInfo {
  url: string;
  hasCustomCertificate?: boolean;
  pendingUpdateCount?: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
  maxConnections?: number;
  allowedUpdates?: string[];
}

export interface SetWebhookInput {
  url: string;
  secretToken: string;
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
}

export interface GetUpdatesInput {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowedUpdates?: string[];
}

export interface TelegramBotUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: TelegramUser;
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    date: number;
    text?: string;
  };
}

export interface TelegramBotApiClient {
  getMe(): Promise<TelegramBotApiResult<TelegramUser>>;
  getManagedBotToken(botId: number): Promise<TelegramBotApiResult<string>>;
  setWebhook(input: SetWebhookInput): Promise<TelegramBotApiResult<true>>;
  getWebhookInfo(): Promise<TelegramBotApiResult<TelegramWebhookInfo>>;
  deleteWebhook(dropPendingUpdates?: boolean): Promise<TelegramBotApiResult<true>>;
  getUpdates(input?: GetUpdatesInput): Promise<TelegramBotApiResult<TelegramBotUpdate[]>>;
}

interface ApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function classifyErrorKind(
  status: number,
  data: ApiEnvelope<unknown> | null,
): TelegramErrorKind {
  if (status === 429 || data?.parameters?.retry_after !== undefined) {
    return "rate_limited";
  }
  if (status === 403) return "blocked";
  if (status === 401 || status === 404) return "api_error";
  return "api_error";
}

export function createTelegramBotApiClient(
  botToken: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): TelegramBotApiClient {
  if (
    typeof botToken !== "string" ||
    botToken.trim().length === 0
  ) {
    throw new Error("A Telegram bot token is required.");
  }

  const token = botToken.trim();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 10_000;

  async function call<T>(
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<TelegramBotApiResult<T>> {
    try {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      let data: ApiEnvelope<T> | null = null;

      try {
        const text = await response.text();
        if (text.length > 0) data = JSON.parse(text) as ApiEnvelope<T>;
      } catch {
        data = null;
      }

      if (!response.ok || !data?.ok) {
        const errorKind = classifyErrorKind(response.status, data);
        return {
          ok: false,
          error: sanitizeTelegramError(
            data?.description ?? `Telegram ${method} failed`,
            token,
          ),
          errorKind,
          httpStatus: response.status,
          retryAfterSeconds: data?.parameters?.retry_after,
        };
      }

      return { ok: true, result: data.result as T };
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");

      return {
        ok: false,
        error: sanitizeTelegramError(
          isTimeout
            ? "Connection to Telegram timed out"
            : "Network error contacting Telegram",
          token,
        ),
        errorKind: isTimeout ? "timeout" : "network_error",
      };
    }
  }

  return {
    getMe() {
      return call<TelegramUser>("getMe");
    },

    getManagedBotToken(botId: number) {
      return call<string>("getManagedBotToken", { user_id: botId });
    },

    setWebhook(input: SetWebhookInput) {
      const body: Record<string, unknown> = {
        url: input.url,
        secret_token: input.secretToken,
      };

      if (input.allowedUpdates) {
        body.allowed_updates = input.allowedUpdates;
      }
      if (input.dropPendingUpdates !== undefined) {
        body.drop_pending_updates = input.dropPendingUpdates;
      }

      return call<true>("setWebhook", body);
    },

    async getWebhookInfo() {
      const result = await call<TelegramWebhookInfo>("getWebhookInfo");

      if (!result.ok) return result;

      return {
        ok: true,
        result: {
          url: typeof result.result?.url === "string" ? result.result.url : "",
          hasCustomCertificate: result.result?.hasCustomCertificate,
          pendingUpdateCount: result.result?.pendingUpdateCount,
          lastErrorDate: result.result?.lastErrorDate,
          lastErrorMessage: result.result?.lastErrorMessage,
          maxConnections: result.result?.maxConnections,
          allowedUpdates: result.result?.allowedUpdates,
        },
      };
    },

    deleteWebhook(dropPendingUpdates = false) {
      return call<true>("deleteWebhook", {
        drop_pending_updates: dropPendingUpdates,
      });
    },

    getUpdates(input: GetUpdatesInput = {}) {
      const body: Record<string, unknown> = {};

      if (input.offset !== undefined) body.offset = input.offset;
      if (input.limit !== undefined) body.limit = input.limit;
      if (input.timeout !== undefined) body.timeout = input.timeout;
      if (input.allowedUpdates) body.allowed_updates = input.allowedUpdates;

      return call<TelegramBotUpdate[]>("getUpdates", body);
    },
  };
}
