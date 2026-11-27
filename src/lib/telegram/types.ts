/**
 * Telegram Bot API and webhook types for Rabet.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
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

export interface TelegramContact {
  phone_number: string;
  first_name?: string;
  last_name?: string;
  user_id?: number;
  vcard?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Minimal `InputMediaPhoto` representation accepted by `editMessageMedia`.
 *
 * The transport only sends one synthesized photo from a managed product's
 * `imageUrl`; `file_id` strings are also valid Telegram photo identifiers.
 */
export interface TelegramInputMediaPhoto {
  type: "photo";
  media: string;
  caption?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  contact?: TelegramContact;
  photo?: TelegramPhotoSize[];
  reply_markup?: TelegramInlineKeyboardMarkup;
  reply_to_message?: {
    message_id: number;
    chat?: TelegramChat;
  };
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

export interface TelegramReplyKeyboardButton {
  text: string;
  request_contact?: boolean;
}

export interface TelegramReplyKeyboardMarkup {
  keyboard: TelegramReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
}

export interface TelegramForceReplyMarkup {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
}

export type TelegramReplyMarkup =
  | TelegramInlineKeyboardMarkup
  | TelegramReplyKeyboardMarkup
  | TelegramForceReplyMarkup
  | { remove_keyboard: true };

export type TelegramErrorKind =
  | "not_modified"
  | "not_editable"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "callback_expired"
  | "blocked"
  | "api_error";

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  errorKind?: TelegramErrorKind;
  httpStatus?: number;
  retryAfterSeconds?: number;
  isBlocked?: boolean;
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
    replyMarkup?: TelegramReplyMarkup;
  }): Promise<TelegramSendResult>;

  sendPhoto(params: {
    chatId: number | string;
    photo: string;
    caption?: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult>;

  editMessageText(params: {
    chatId: number | string;
    messageId: number;
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult>;

  editMessageMedia(params: {
    chatId: number | string;
    messageId: number;
    media: TelegramInputMediaPhoto;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  }): Promise<TelegramSendResult>;

  editMessageReplyMarkup(params: {
    chatId: number | string;
    messageId: number;
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
  | "callback_expired"
  | "blocked"
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
