/**
 * Telegram Bot API and webhook types for Rabet.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: unknown;
  channel_post?: unknown;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export type TelegramErrorKind =
  | "not_modified"
  | "not_editable"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "api_error";

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  errorKind?: TelegramErrorKind;
  retryAfterSeconds?: number;
}

export interface TelegramAnswerResult {
  ok: boolean;
  error?: string;
  errorKind?: TelegramErrorKind;
  retryAfterSeconds?: number;
}

export interface TelegramTransport {
  sendMessage(params: {
    chatId: number | string;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult>;

  editMessageText(params: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult>;

  answerCallbackQuery(params: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<TelegramAnswerResult>;
}

export class TelegramTransportError extends Error {
  readonly errorKind: TelegramErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options?: {
      errorKind?: TelegramErrorKind;
      httpStatus?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "TelegramTransportError";
    this.errorKind = options?.errorKind ?? "api_error";
    this.httpStatus = options?.httpStatus;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class BudgetExceededError extends Error {
  constructor(message = "Execution budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class FencingRejectedError extends Error {
  constructor(message = "Completion fencing rejected update") {
    super(message);
    this.name = "FencingRejectedError";
  }
}

export interface ExecutionDeadline {
  getRemainingMs(): number;
  isExpired(): boolean;
  checkOrThrow(): void;
}

export type SafeDiagnosticCategory =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "not_editable"
  | "not_modified"
  | "api_error"
  | "db_error"
  | "budget_exceeded"
  | "fencing_rejected"
  | "internal_error";

export interface SafeDiagnostic {
  category: SafeDiagnosticCategory;
  httpStatus?: number;
  retryAfterSeconds?: number;
}
