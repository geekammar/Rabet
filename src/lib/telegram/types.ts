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

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

export interface TelegramAnswerResult {
  ok: boolean;
  error?: string;
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
