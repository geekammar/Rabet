import "server-only";

import type { Database } from "@/db/client";
import {
  claimDeliveryAttempt,
  getSellerNotificationDelivery,
  markDeliveryCancelled,
  markDeliveryFailed,
  markDeliverySent,
  markDeliveryUnknown,
  readSellerNotificationConfig,
} from "@/lib/data/seller-notifications";
import { getInquiryRecord } from "@/lib/data/inquiry";
import {
  classifyHttpError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  sanitizeTelegramError,
} from "./transport";
import type {
  ExecutionDeadline,
  TelegramErrorKind,
  TelegramInlineKeyboardMarkup,
  TelegramSendResult,
  TelegramTransport,
  TelegramUser,
} from "./types";

export const NOTIFICATION_BOT_TOKEN_ENV = "TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN";

/**
 * Returns the server-only secret token for the seller notification bot.
 * Never exposed to browser or client.
 */
export function getSellerNotificationBotToken(): string | null {
  const token = process.env[NOTIFICATION_BOT_TOKEN_ENV];
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return null;
  }
  return token.trim();
}

export interface BotIdentity {
  id: number;
  username?: string;
  firstName?: string;
}

/**
 * Queries Telegram getMe for the seller notification bot.
 * Never returns or leaks the token in response or error.
 */
export async function getSellerBotMe(
  token?: string,
  timeoutMs = 5000,
): Promise<{ ok: true; bot: BotIdentity } | { ok: false; error: string; errorKind?: TelegramErrorKind }> {
  const effectiveToken = token ?? getSellerNotificationBotToken();
  if (!effectiveToken) {
    return { ok: false, error: "Notification bot token is not configured in environment.", errorKind: "api_error" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${effectiveToken}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: TelegramUser;
      description?: string;
    } | null;

    if (!res.ok || !data?.ok || !data.result) {
      const classified = classifyHttpError(res.status, data ?? undefined, "getMe");
      return {
        ok: false,
        error: sanitizeTelegramError(data?.description ?? "Telegram getMe failed", effectiveToken),
        errorKind: classified.errorKind,
      };
    }

    return {
      ok: true,
      bot: {
        id: data.result.id,
        username: data.result.username,
        firstName: data.result.first_name,
      },
    };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      ok: false,
      error: sanitizeTelegramError(isTimeout ? "Connection timed out" : "Network error contacting Telegram", effectiveToken),
      errorKind: isTimeout ? "timeout" : "network_error",
    };
  }
}

export interface OperatorDetectedChat {
  chatId: string;
  username?: string;
  firstName?: string;
  date: number;
}

/**
 * Safe operator helper: fetches recent private chat interactions from the notification bot
 * to help the seller discover their numeric chat ID without opening shell history or external sites.
 * Uses getUpdates with limit=10 on the notification bot token only.
 */
export async function getSellerBotRecentChats(
  token?: string,
  timeoutMs = 5000,
): Promise<{ ok: true; chats: OperatorDetectedChat[] } | { ok: false; error: string }> {
  const effectiveToken = token ?? getSellerNotificationBotToken();
  if (!effectiveToken) {
    return { ok: false, error: "Notification bot token is not configured in environment." };
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${effectiveToken}/getUpdates?limit=10&allowed_updates=["message"]`,
      {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: Array<{
        message?: {
          chat?: { id: number; type: string; username?: string; first_name?: string };
          date?: number;
        };
      }>;
      description?: string;
    } | null;

    if (!res.ok || !data?.ok || !Array.isArray(data.result)) {
      return {
        ok: false,
        error: sanitizeTelegramError(data?.description ?? "Failed to fetch updates", effectiveToken),
      };
    }

    const seen = new Map<string, OperatorDetectedChat>();
    for (const update of data.result) {
      const msg = update.message;
      if (msg?.chat && msg.chat.type === "private" && typeof msg.chat.id === "number" && msg.chat.id > 0) {
        const idStr = String(msg.chat.id);
        if (!seen.has(idStr) || (msg.date && msg.date > (seen.get(idStr)?.date ?? 0))) {
          seen.set(idStr, {
            chatId: idStr,
            username: msg.chat.username,
            firstName: msg.chat.first_name,
            date: msg.date ?? 0,
          });
        }
      }
    }

    const chats = Array.from(seen.values()).sort((a, b) => b.date - a.date);
    return { ok: true, chats };
  } catch {
    return {
      ok: false,
      error: sanitizeTelegramError("Network error checking bot updates", effectiveToken),
    };
  }
}

/**
 * Sends an unmistakable TEST notification to the seller's destination chat ID.
 */
export async function sendSellerTestNotification(params: {
  destinationChatId: string;
  language: "ar" | "en";
  botToken?: string;
  transport?: TelegramTransport;
  timeoutMs?: number;
}): Promise<{ ok: true; bot: BotIdentity; messageId: number } | { ok: false; error: string; errorKind?: TelegramErrorKind }> {
  const effectiveToken = params.botToken ?? getSellerNotificationBotToken();
  if (!effectiveToken && !params.transport) {
    return { ok: false, error: "Notification bot token is not configured in hosting environment.", errorKind: "api_error" };
  }

  // Verify current bot identity
  let bot: BotIdentity;
  if (params.transport) {
    bot = { id: 999999, username: "test_notification_bot", firstName: "Test Bot" };
  } else {
    const meResult = await getSellerBotMe(effectiveToken ?? undefined, params.timeoutMs ?? 5000);
    if (!meResult.ok) {
      return meResult;
    }
    bot = meResult.bot;
  }

  const nowIso = new Date().toISOString();
  const timeFormatted = `${nowIso.slice(0, 10)} ${nowIso.slice(11, 19)} UTC`;
  const botHandle = bot.username ? `@${bot.username}` : `ID: ${bot.id}`;

  const text =
    params.language === "en"
      ? `🔔 [TEST] Rabet Seller Notification\nThis is a test notification to verify that new inquiry alerts are delivered successfully.\nBot: ${botHandle}\nTime: ${timeFormatted}`
      : `🔔 [تجربة] إشعار التاجر من رابط\nهذه رسالة تجريبية للتأكد من وصول إشعارات الاستفسارات الجديدة بنجاح.\nالبوت: ${botHandle}\nالوقت: ${timeFormatted}`;

  if (params.transport) {
    const sendRes = await params.transport.sendMessage({
      chatId: params.destinationChatId,
      text,
    });
    if (!sendRes.ok) {
      return {
        ok: false,
        error: sendRes.error ?? "Telegram sendMessage failed",
        errorKind: sendRes.errorKind ?? "api_error",
      };
    }
    return { ok: true, bot, messageId: sendRes.messageId ?? 1 };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${effectiveToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: params.destinationChatId,
        text,
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });

    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: { message_id: number };
      description?: string;
    } | null;

    if (!res.ok || !data?.ok || !data.result) {
      const classified = classifyHttpError(res.status, data ?? undefined, "sendMessage");
      return {
        ok: false,
        error: sanitizeTelegramError(data?.description ?? "Telegram sendMessage failed", effectiveToken ?? undefined),
        errorKind: classified.errorKind,
      };
    }

    return {
      ok: true,
      bot,
      messageId: data.result.message_id,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      ok: false,
      error: sanitizeTelegramError(isTimeout ? "Send request timed out" : "Network error contacting Telegram", effectiveToken ?? undefined),
      errorKind: isTimeout ? "timeout" : "network_error",
    };
  }
}

export function formatSellerNotificationMessage(params: {
  isSupport: boolean;
  reference: string;
  deliveryReference: string;
  productName?: string | null;
  categoryName?: string | null;
  createdAt: Date;
  language: "ar" | "en";
  dashboardUrl: string;
}): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
  const iso = (params.createdAt ?? new Date()).toISOString();
  const timeFormatted = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

  if (params.language === "en") {
    const lines = [
      params.isSupport ? "🔔 New Support Inquiry" : "🔔 New Product Inquiry",
      `Reference: ${params.reference}`,
    ];
    if (!params.isSupport && params.productName) {
      lines.push(`Product: ${params.productName.slice(0, 120)}`);
    } else if (params.isSupport && params.categoryName) {
      lines.push(`Category: ${params.categoryName.slice(0, 120)}`);
    }
    lines.push(`Time: ${timeFormatted}`);
    lines.push(`Delivery ID: ${params.deliveryReference}`);

    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "View Inquiry in Dashboard",
              url: params.dashboardUrl,
            },
          ],
        ],
      },
    };
  } else {
    const lines = [
      params.isSupport ? "🔔 استفسار دعم جديد" : "🔔 استفسار جديد عن منتج",
      `المرجع: ${params.reference}`,
    ];
    if (!params.isSupport && params.productName) {
      lines.push(`المنتج: ${params.productName.slice(0, 120)}`);
    } else if (params.isSupport && params.categoryName) {
      lines.push(`التصنيف: ${params.categoryName.slice(0, 120)}`);
    }
    lines.push(`الوقت: ${timeFormatted}`);
    lines.push(`مرجع الإشعار: ${params.deliveryReference}`);

    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "عرض الاستفسار في لوحة التحكم",
              url: params.dashboardUrl,
            },
          ],
        ],
      },
    };
  }
}

export interface AttemptDeliveryOptions {
  db: Database;
  deliveryId: string;
  deadline?: ExecutionDeadline;
  transport?: TelegramTransport;
  botToken?: string;
  acknowledgeUnknownRisk?: boolean;
}

export type DeliveryAttemptResult =
  | { status: "sent"; messageId: number }
  | { status: "paused"; reason: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; errorCategory: string; retryAfterSeconds?: number }
  | { status: "unknown"; errorCategory: string }
  | { status: "cancelled"; reason: string }
  | { status: "in_flight" };

/**
 * Attempts delivery of a single seller notification record.
 * Follows strict state transitions:
 * - Atomic claiming prevents concurrent execution.
 * - Stale attempts cannot overwrite newer state.
 * - Revision mismatch cancels old deliveries.
 * - HTTP 429 records retry_after_until.
 * - Timeout records 'unknown'.
 * - Never throws unhandled errors up to caller.
 */
export async function attemptSellerNotificationDelivery(
  options: AttemptDeliveryOptions,
): Promise<DeliveryAttemptResult> {
  const { db, deliveryId } = options;

  // 1. Check budget
  if (options.deadline && options.deadline.getRemainingMs() < 2000) {
    return { status: "pending", reason: "budget_exceeded" };
  }

  // 2. Read configuration
  const setting = await readSellerNotificationConfig(db);
  if (!setting || !setting.enabled) {
    return { status: "paused", reason: "notifications_disabled" };
  }

  // 3. Read delivery record
  const record = await getSellerNotificationDelivery(db, deliveryId);
  if (!record) {
    return { status: "cancelled", reason: "record_not_found" };
  }

  if (record.status === "sent") {
    return { status: "sent", messageId: record.telegramMessageId ?? 0 };
  }

  if (record.status === "cancelled") {
    return { status: "cancelled", reason: record.errorCategory ?? "cancelled" };
  }

  // 4. Unknown retry requires explicit acknowledgment
  if (record.status === "unknown" && !options.acknowledgeUnknownRisk) {
    return {
      status: "unknown",
      errorCategory: "requires_duplicate_acknowledgment",
    };
  }

  // 5. Rate limiting check
  if (record.retryAfterUntil && record.retryAfterUntil.getTime() > Date.now()) {
    const remainingSec = Math.ceil((record.retryAfterUntil.getTime() - Date.now()) / 1000);
    return {
      status: "failed",
      errorCategory: "rate_limited",
      retryAfterSeconds: remainingSec,
    };
  }

  // 6. Revision and destination binding check
  if (
    record.revision !== setting.revision ||
    record.destinationChatId !== setting.destinationChatId
  ) {
    await markDeliveryCancelled(db, deliveryId, "incompatible_configuration");
    return { status: "cancelled", reason: "incompatible_configuration" };
  }

  // 7. Atomic claim
  const attemptId = crypto.randomUUID();
  const claimed = await claimDeliveryAttempt(db, deliveryId, attemptId, 60_000);
  if (!claimed) {
    return { status: "in_flight" };
  }

  // 8. Bot token & identity verification
  const token = options.botToken ?? getSellerNotificationBotToken();
  if (!token && !options.transport) {
    await markDeliveryFailed(db, deliveryId, attemptId, "missing_token");
    return { status: "failed", errorCategory: "missing_token" };
  }

  if (!options.transport && token) {
    const meRes = await getSellerBotMe(token, 5000);
    if (!meRes.ok) {
      await markDeliveryFailed(db, deliveryId, attemptId, meRes.errorKind ?? "api_error");
      return { status: "failed", errorCategory: meRes.errorKind ?? "api_error" };
    }
    if (setting.verifiedBotId && meRes.bot.id !== setting.verifiedBotId) {
      await markDeliveryCancelled(db, deliveryId, "bot_identity_changed");
      return { status: "cancelled", reason: "bot_identity_changed" };
    }
  }

  // 9. Load inquiry details for content
  const inquiryRow = await getInquiryRecord(db, record.inquiryId);
  if (!inquiryRow) {
    await markDeliveryCancelled(db, deliveryId, "inquiry_not_found");
    return { status: "cancelled", reason: "inquiry_not_found" };
  }

  const isSupport = inquiryRow.productId === null;
  let productName: string | null = null;
  if (!isSupport && inquiryRow.productSnapshot && typeof inquiryRow.productSnapshot === "object") {
    const snap = inquiryRow.productSnapshot as Record<string, unknown>;
    productName = typeof snap.name === "string" ? snap.name : null;
  }
  const categoryName = inquiryRow.category;

  const rawBaseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const dashboardUrl = `${baseUrl}/inquiries/${inquiryRow.id}`;

  const formatted = formatSellerNotificationMessage({
    isSupport,
    reference: inquiryRow.reference,
    deliveryReference: record.reference,
    productName,
    categoryName,
    createdAt: inquiryRow.createdAt,
    language: setting.language === "en" ? "en" : "ar",
    dashboardUrl,
  });

  // 10. Network transmission
  const timeoutMs = options.deadline
    ? Math.min(DEFAULT_REQUEST_TIMEOUT_MS, options.deadline.getRemainingMs())
    : DEFAULT_REQUEST_TIMEOUT_MS;

  if (timeoutMs <= 0) {
    // Left pending/unknown for recovery
    await markDeliveryUnknown(db, deliveryId, attemptId, "budget_exceeded");
    return { status: "unknown", errorCategory: "budget_exceeded" };
  }

  try {
    let sendResult: TelegramSendResult;

    if (options.transport) {
      sendResult = await options.transport.sendMessage({
        chatId: record.destinationChatId,
        text: formatted.text,
        replyMarkup: formatted.replyMarkup,
      });
    } else {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: record.destinationChatId,
          text: formatted.text,
          reply_markup: formatted.replyMarkup,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: { message_id: number };
        description?: string;
        parameters?: { retry_after?: number };
      } | null;

      if (res.ok && data?.ok && data.result) {
        sendResult = { ok: true, messageId: data.result.message_id };
      } else {
        const classified = classifyHttpError(res.status, data ?? undefined, "sendMessage");
        sendResult = {
          ok: false,
          error: sanitizeTelegramError(data?.description ?? "Send failed", token ?? undefined),
          errorKind: classified.errorKind,
          httpStatus: res.status,
          retryAfterSeconds: data?.parameters?.retry_after,
        };
      }
    }

    if (sendResult.ok && typeof sendResult.messageId === "number") {
      await markDeliverySent(db, deliveryId, attemptId, sendResult.messageId);
      return { status: "sent", messageId: sendResult.messageId };
    }

    // Classify error
    if (sendResult.errorKind === "rate_limited") {
      const retryAfter = sendResult.retryAfterSeconds ?? 10;
      await markDeliveryFailed(db, deliveryId, attemptId, "rate_limited", retryAfter);
      return { status: "failed", errorCategory: "rate_limited", retryAfterSeconds: retryAfter };
    }

    if (sendResult.errorKind === "timeout") {
      await markDeliveryUnknown(db, deliveryId, attemptId, "timeout");
      return { status: "unknown", errorCategory: "timeout" };
    }

    const cat = sendResult.errorKind ?? "api_error";
    await markDeliveryFailed(db, deliveryId, attemptId, cat);
    return { status: "failed", errorCategory: cat };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    if (isTimeout) {
      await markDeliveryUnknown(db, deliveryId, attemptId, "timeout");
      return { status: "unknown", errorCategory: "timeout" };
    }

    await markDeliveryFailed(db, deliveryId, attemptId, "network_error");
    return { status: "failed", errorCategory: "network_error" };
  }
}
