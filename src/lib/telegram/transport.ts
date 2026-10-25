import type {
  ExecutionDeadline,
  SafeDiagnostic,
  TelegramAnswerResult,
  TelegramErrorKind,
  TelegramInlineKeyboardMarkup,
  TelegramSendResult,
  TelegramTransport,
} from "./types";
import {
  BudgetExceededError,
  FencingRejectedError,
  TelegramTransportError,
} from "./types";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const TELEGRAM_MAX_CALLBACK_BYTES = 64;

/**
 * Standard execution deadline tracker.
 */
export class StandardExecutionDeadline implements ExecutionDeadline {
  private readonly endTimestamp: number;
  private readonly nowFn: () => number;

  constructor(budgetMs: number, nowFn: () => number = Date.now) {
    this.nowFn = nowFn;
    this.endTimestamp = nowFn() + budgetMs;
  }

  getRemainingMs(): number {
    return Math.max(0, this.endTimestamp - this.nowFn());
  }

  isExpired(): boolean {
    return this.getRemainingMs() <= 0;
  }

  checkOrThrow(): void {
    if (this.isExpired()) {
      throw new BudgetExceededError("Execution budget exceeded before completing work");
    }
  }
}

/**
 * Formats a safe diagnostic descriptor using an allowlisted schema.
 * Never includes raw exception messages, query strings, SQL statements, or customer text.
 */
export function formatSafeDiagnostic(diagnostic: SafeDiagnostic): string {
  const parts: string[] = [`category=${diagnostic.category}`];
  if (typeof diagnostic.httpStatus === "number" && Number.isInteger(diagnostic.httpStatus)) {
    parts.push(`status=${diagnostic.httpStatus}`);
  }
  if (
    typeof diagnostic.retryAfterSeconds === "number" &&
    Number.isInteger(diagnostic.retryAfterSeconds)
  ) {
    parts.push(`retry_after=${diagnostic.retryAfterSeconds}`);
  }
  return parts.join(";");
}

/**
 * Classifies any caught exception into an allowlisted safe diagnostic descriptor.
 */
export function classifyErrorToSafeDiagnostic(err: unknown): SafeDiagnostic {
  if (err instanceof TelegramTransportError) {
    return {
      category: err.errorKind,
      httpStatus: err.httpStatus ?? (err.errorKind === "rate_limited" ? 429 : undefined),
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  if (err instanceof BudgetExceededError) {
    return { category: "budget_exceeded" };
  }
  if (err instanceof FencingRejectedError) {
    return { category: "fencing_rejected" };
  }
  if (err instanceof Error) {
    if (err.name === "BudgetExceededError") return { category: "budget_exceeded" };
    if (err.name === "FencingRejectedError") return { category: "fencing_rejected" };
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { category: "timeout" };
    }
    if (err.name === "RabetDataError") {
      return { category: "db_error" };
    }
  }
  return { category: "internal_error" };
}

/**
 * Strips Telegram bot tokens, database URLs, and sensitive secrets from error messages
 * to ensure sensitive credentials are never logged or leaked.
 */
export function sanitizeTelegramError(
  error: unknown,
  sensitiveSecrets?: string | Array<string | undefined>,
): string {
  let message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  const secretsList = Array.isArray(sensitiveSecrets)
    ? sensitiveSecrets
    : sensitiveSecrets
      ? [sensitiveSecrets]
      : [];

  for (const secret of secretsList) {
    if (secret && typeof secret === "string" && secret.trim().length > 0) {
      message = message.replaceAll(secret, "[REDACTED_BOT_TOKEN]");
    }
  }

  // Strip standard Telegram bot URL token patterns e.g. /bot12345:AAAA/
  message = message.replace(/\/bot[0-9]+:[a-zA-Z0-9_-]+/g, "/bot[REDACTED_BOT_TOKEN]");

  // Strip database connection strings
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URL]");

  // Strip bearer tokens
  message = message.replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED]");

  return message.slice(0, 300);
}

interface TelegramApiResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export function classifyHttpError(
  status: number,
  data?: TelegramApiResponse,
  method?: string,
): { errorKind: TelegramErrorKind; retryAfterSeconds?: number } {
  const desc = (data?.description ?? "").toLowerCase();

  if (status === 429 || data?.parameters?.retry_after !== undefined) {
    return {
      errorKind: "rate_limited",
      retryAfterSeconds: data?.parameters?.retry_after,
    };
  }

  if (desc.includes("message is not modified")) {
    return { errorKind: "not_modified" };
  }

  if (
    desc.includes("message can't be edited") ||
    desc.includes("message to edit not found") ||
    desc.includes("message cannot be edited")
  ) {
    return { errorKind: "not_editable" };
  }

  // Narrowly classify expired callback query on answerCallbackQuery ONLY
  // Telegram Bot API returns HTTP 400 with "query is too old and response timeout expired or query id is invalid"
  if (method === "answerCallbackQuery" && desc.includes("query is too old")) {
    return { errorKind: "callback_expired" };
  }

  return { errorKind: "api_error" };
}

function classifyNetworkException(err: unknown): { errorKind: TelegramErrorKind } {
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return { errorKind: "timeout" };
  }
  return { errorKind: "network_error" };
}

export interface FetchTelegramTransportOptions {
  timeoutMs?: number;
  deadline?: ExecutionDeadline;
}

/**
 * Creates a real HTTP transport for communicating with the official Telegram Bot API via fetch.
 */
export function createFetchTelegramTransport(
  botToken: string,
  options?: FetchTelegramTransportOptions,
): TelegramTransport {
  if (!botToken || typeof botToken !== "string" || botToken.trim().length === 0) {
    throw new Error("Cannot create Telegram transport: TELEGRAM_BOT_TOKEN is missing or empty.");
  }

  const baseUrl = `https://api.telegram.org/bot${botToken}`;
  const defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = options?.deadline;

  async function postTelegram<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<
    | { ok: true; result?: T }
    | { ok: false; error: string; errorKind: TelegramErrorKind; httpStatus?: number; retryAfterSeconds?: number }
  > {
    if (deadline) {
      deadline.checkOrThrow();
    }

    const remainingMs = deadline ? deadline.getRemainingMs() : defaultTimeoutMs;
    const effectiveTimeout = Math.min(defaultTimeoutMs, remainingMs);
    if (effectiveTimeout <= 0) {
      throw new BudgetExceededError("Execution budget exceeded before initiating Telegram request");
    }

    try {
      const res = await fetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(effectiveTimeout),
      });

      let data: TelegramApiResponse<T> | undefined;
      try {
        const text = await res.text();
        if (text) {
          data = JSON.parse(text) as TelegramApiResponse<T>;
        }
      } catch {
        // Body was not valid JSON (e.g. 502 Bad Gateway HTML)
      }

      if (!res.ok || !data?.ok) {
        const desc = data?.description ?? `HTTP ${res.status}`;
        const classification = classifyHttpError(res.status, data, method);

        // Special case: "message is not modified" on editMessageText is treated as success
        if (classification.errorKind === "not_modified") {
          return { ok: true, result: data?.result };
        }

        return {
          ok: false,
          error: sanitizeTelegramError(desc, botToken),
          errorKind: classification.errorKind,
          httpStatus: res.status,
          retryAfterSeconds: classification.retryAfterSeconds,
        };
      }

      return { ok: true, result: data.result };
    } catch (err) {
      if (deadline?.isExpired()) {
        throw new BudgetExceededError("Execution budget expired during request");
      }
      const classification = classifyNetworkException(err);
      return {
        ok: false,
        error: sanitizeTelegramError(err, botToken),
        errorKind: classification.errorKind,
      };
    }
  }

  return {
    async sendMessage({ chatId, text, replyMarkup }): Promise<TelegramSendResult> {
      const check = validatePayloadLimits(text, replyMarkup);
      if (!check.ok) {
        return check;
      }

      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
      };
      if (replyMarkup) {
        body.reply_markup = replyMarkup;
      }

      const res = await postTelegram<{ message_id?: number }>("sendMessage", body);
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          errorKind: res.errorKind,
          retryAfterSeconds: res.retryAfterSeconds,
        };
      }

      return {
        ok: true,
        messageId: res.result?.message_id,
      };
    },

    async editMessageText({ chatId, messageId, text, replyMarkup }): Promise<TelegramSendResult> {
      const check = validatePayloadLimits(text, replyMarkup);
      if (!check.ok) {
        return check;
      }

      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        text,
      };
      if (replyMarkup) {
        body.reply_markup = replyMarkup;
      }

      const res = await postTelegram<{ message_id?: number }>("editMessageText", body);
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          errorKind: res.errorKind,
          retryAfterSeconds: res.retryAfterSeconds,
        };
      }

      return {
        ok: true,
        messageId: res.result?.message_id ?? messageId,
      };
    },

    async answerCallbackQuery({ callbackQueryId, text, showAlert }): Promise<TelegramAnswerResult> {
      const body: Record<string, unknown> = {
        callback_query_id: callbackQueryId,
      };
      if (text) body.text = text;
      if (showAlert !== undefined) body.show_alert = showAlert;

      const res = await postTelegram<boolean>("answerCallbackQuery", body);
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          errorKind: res.errorKind,
          retryAfterSeconds: res.retryAfterSeconds,
        };
      }

      return { ok: true };
    },
  };
}

export interface FakeSentMessage {
  chatId: number | string;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface FakeEditedMessage {
  chatId: number | string;
  messageId: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface FakeAnsweredCallback {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

export interface FakeTelegramTransport extends TelegramTransport {
  sentMessages: FakeSentMessage[];
  editedMessages: FakeEditedMessage[];
  answeredCallbacks: FakeAnsweredCallback[];
  deadline?: ExecutionDeadline;
  failSendWith?: string;
  failSendKind?: TelegramErrorKind;
  failSendRetryAfter?: number;
  failEditWith?: string;
  failEditKind?: TelegramErrorKind;
  failEditRetryAfter?: number;
  failAnswerWith?: string;
  failAnswerKind?: TelegramErrorKind;
  failAnswerRetryAfter?: number;
  clear(): void;
}

export function validatePayloadLimits(
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): { ok: true } | { ok: false; error: string; errorKind: TelegramErrorKind } {
  if (text.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: `Message text exceeds Telegram limit of ${TELEGRAM_MAX_MESSAGE_CHARS} characters (received ${text.length})`,
      errorKind: "api_error",
    };
  }

  if (replyMarkup?.inline_keyboard) {
    for (const row of replyMarkup.inline_keyboard) {
      for (const btn of row) {
        if (btn.url && btn.callback_data) {
          return {
            ok: false,
            error: "Button representation cannot combine url and callback_data",
            errorKind: "api_error",
          };
        }
        if (!btn.url && !btn.callback_data) {
          return {
            ok: false,
            error: "Button must have either url or callback_data",
            errorKind: "api_error",
          };
        }
        if (btn.callback_data) {
          const byteLen = Buffer.byteLength(btn.callback_data, "utf8");
          if (byteLen > TELEGRAM_MAX_CALLBACK_BYTES) {
            return {
              ok: false,
              error: `Callback data exceeds Telegram limit of ${TELEGRAM_MAX_CALLBACK_BYTES} bytes (received ${byteLen})`,
              errorKind: "api_error",
            };
          }
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Creates an in-memory fake transport for hermetic testing.
 */
export function createFakeTelegramTransport(): FakeTelegramTransport {
  const sentMessages: FakeSentMessage[] = [];
  const editedMessages: FakeEditedMessage[] = [];
  const answeredCallbacks: FakeAnsweredCallback[] = [];

  let nextMessageId = 1000;

  const transport: FakeTelegramTransport = {
    sentMessages,
    editedMessages,
    answeredCallbacks,

    async sendMessage({ chatId, text, replyMarkup }) {
      if (transport.deadline?.isExpired()) {
        throw new BudgetExceededError("Execution budget exceeded in fake transport");
      }
      if (transport.failSendWith) {
        return {
          ok: false,
          error: transport.failSendWith,
          errorKind: transport.failSendKind ?? "api_error",
          retryAfterSeconds: transport.failSendRetryAfter,
        };
      }
      const check = validatePayloadLimits(text, replyMarkup);
      if (!check.ok) {
        return check;
      }
      nextMessageId += 1;
      sentMessages.push({ chatId, text, replyMarkup });
      return { ok: true, messageId: nextMessageId };
    },

    async editMessageText({ chatId, messageId, text, replyMarkup }) {
      if (transport.deadline?.isExpired()) {
        throw new BudgetExceededError("Execution budget exceeded in fake transport");
      }
      if (transport.failEditWith) {
        return {
          ok: false,
          error: transport.failEditWith,
          errorKind: transport.failEditKind ?? "api_error",
          retryAfterSeconds: transport.failEditRetryAfter,
        };
      }
      const check = validatePayloadLimits(text, replyMarkup);
      if (!check.ok) {
        return check;
      }
      editedMessages.push({ chatId, messageId, text, replyMarkup });
      return { ok: true, messageId };
    },

    async answerCallbackQuery({ callbackQueryId, text, showAlert }) {
      if (transport.deadline?.isExpired()) {
        throw new BudgetExceededError("Execution budget exceeded in fake transport");
      }
      if (transport.failAnswerWith) {
        let errorKind = transport.failAnswerKind;
        if (!errorKind) {
          const lower = transport.failAnswerWith.toLowerCase();
          if (lower.includes("query is too old")) {
            errorKind = "callback_expired";
          } else {
            errorKind = "api_error";
          }
        }
        return {
          ok: false,
          error: transport.failAnswerWith,
          errorKind,
          retryAfterSeconds: transport.failAnswerRetryAfter,
        };
      }
      answeredCallbacks.push({ callbackQueryId, text, showAlert });
      return { ok: true };
    },

    clear() {
      sentMessages.length = 0;
      editedMessages.length = 0;
      answeredCallbacks.length = 0;
      transport.deadline = undefined;
      transport.failSendWith = undefined;
      transport.failSendKind = undefined;
      transport.failSendRetryAfter = undefined;
      transport.failEditWith = undefined;
      transport.failEditKind = undefined;
      transport.failEditRetryAfter = undefined;
      transport.failAnswerWith = undefined;
      transport.failAnswerKind = undefined;
      transport.failAnswerRetryAfter = undefined;
    },
  };

  return transport;
}
