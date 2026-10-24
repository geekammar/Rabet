import type {
  TelegramAnswerResult,
  TelegramInlineKeyboardMarkup,
  TelegramSendResult,
  TelegramTransport,
} from "./types";

/**
 * Strips Telegram bot tokens and query parameters from error messages and URLs
 * to ensure sensitive credentials are never logged or leaked.
 */
export function sanitizeTelegramError(error: unknown, botToken?: string): string {
  let message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  if (botToken && botToken.length > 0) {
    message = message.replaceAll(botToken, "[REDACTED_BOT_TOKEN]");
  }

  // Strip standard Telegram bot URL token patterns e.g. /bot12345:AAAA/
  message = message.replace(/\/bot[0-9]+:[a-zA-Z0-9_-]+/g, "/bot[REDACTED_BOT_TOKEN]");

  return message.slice(0, 300);
}

/**
 * Creates a real HTTP transport for communicating with the official Telegram Bot API via fetch.
 */
export function createFetchTelegramTransport(botToken: string): TelegramTransport {
  if (!botToken || typeof botToken !== "string" || botToken.trim().length === 0) {
    throw new Error("Cannot create Telegram transport: TELEGRAM_BOT_TOKEN is missing or empty.");
  }

  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  return {
    async sendMessage({ chatId, text, replyMarkup }): Promise<TelegramSendResult> {
      try {
        const body: Record<string, unknown> = {
          chat_id: chatId,
          text,
        };
        if (replyMarkup) {
          body.reply_markup = replyMarkup;
        }

        const res = await fetch(`${baseUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = (await res.json()) as {
          ok?: boolean;
          result?: { message_id?: number };
          description?: string;
        };

        if (!res.ok || !data.ok) {
          return {
            ok: false,
            error: sanitizeTelegramError(data.description ?? `HTTP ${res.status}`, botToken),
          };
        }

        return {
          ok: true,
          messageId: data.result?.message_id,
        };
      } catch (err) {
        return {
          ok: false,
          error: sanitizeTelegramError(err, botToken),
        };
      }
    },

    async editMessageText({ chatId, messageId, text, replyMarkup }): Promise<TelegramSendResult> {
      try {
        const body: Record<string, unknown> = {
          chat_id: chatId,
          message_id: messageId,
          text,
        };
        if (replyMarkup) {
          body.reply_markup = replyMarkup;
        }

        const res = await fetch(`${baseUrl}/editMessageText`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = (await res.json()) as {
          ok?: boolean;
          result?: { message_id?: number };
          description?: string;
        };

        if (!res.ok || !data.ok) {
          const desc = data.description ?? `HTTP ${res.status}`;
          // Telegram returns 400 with "message is not modified" if the contents match identically.
          if (desc.includes("message is not modified")) {
            return { ok: true, messageId };
          }

          return {
            ok: false,
            error: sanitizeTelegramError(desc, botToken),
          };
        }

        return {
          ok: true,
          messageId: data.result?.message_id ?? messageId,
        };
      } catch (err) {
        return {
          ok: false,
          error: sanitizeTelegramError(err, botToken),
        };
      }
    },

    async answerCallbackQuery({ callbackQueryId, text, showAlert }): Promise<TelegramAnswerResult> {
      try {
        const body: Record<string, unknown> = {
          callback_query_id: callbackQueryId,
        };
        if (text) body.text = text;
        if (showAlert !== undefined) body.show_alert = showAlert;

        const res = await fetch(`${baseUrl}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = (await res.json()) as {
          ok?: boolean;
          description?: string;
        };

        if (!res.ok || !data.ok) {
          return {
            ok: false,
            error: sanitizeTelegramError(data.description ?? `HTTP ${res.status}`, botToken),
          };
        }

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: sanitizeTelegramError(err, botToken),
        };
      }
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
  failSendWith?: string;
  failEditWith?: string;
  failAnswerWith?: string;
  clear(): void;
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
      if (transport.failSendWith) {
        return { ok: false, error: transport.failSendWith };
      }
      nextMessageId += 1;
      sentMessages.push({ chatId, text, replyMarkup });
      return { ok: true, messageId: nextMessageId };
    },

    async editMessageText({ chatId, messageId, text, replyMarkup }) {
      if (transport.failEditWith) {
        return { ok: false, error: transport.failEditWith };
      }
      editedMessages.push({ chatId, messageId, text, replyMarkup });
      return { ok: true, messageId };
    },

    async answerCallbackQuery({ callbackQueryId, text, showAlert }) {
      if (transport.failAnswerWith) {
        return { ok: false, error: transport.failAnswerWith };
      }
      answeredCallbacks.push({ callbackQueryId, text, showAlert });
      return { ok: true };
    },

    clear() {
      sentMessages.length = 0;
      editedMessages.length = 0;
      answeredCallbacks.length = 0;
      transport.failSendWith = undefined;
      transport.failEditWith = undefined;
      transport.failAnswerWith = undefined;
    },
  };

  return transport;
}
