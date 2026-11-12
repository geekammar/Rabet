import "server-only";

import type { Database } from "@/db/client";
import {
  claimDeliveryAttemptDetailed,
  getSellerNotificationDelivery,
  markDeliveryCancelled,
  markDeliveryCancelledByWorker,
  markDeliveryFailed,
  markDeliverySent,
  markDeliveryUnknown,
  readSellerNotificationConfig,
  releaseDeliveryClaim,
  revalidatePreDispatchAuthorization,
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
 * Validates and constructs a trusted dashboard URL for inquiry notifications.
 * In production:
 * - Requires HTTPS
 * - Strictly forbids localhost and loopback addresses
 */
export function getTrustedDashboardInquiryUrl(
  inquiryId: string,
): { ok: true; url: string } | { ok: false; error: string } {
  if (!inquiryId || typeof inquiryId !== "string" || inquiryId.trim().length === 0) {
    return { ok: false, error: "Invalid inquiry ID." };
  }

  const rawBaseUrl =
    process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;

  const isProduction = process.env.NODE_ENV === "production";

  if (!rawBaseUrl) {
    if (isProduction) {
      return {
        ok: false,
        error: "Missing trusted dashboard base URL in production environment.",
      };
    }
  }

  const baseCandidate = rawBaseUrl || "http://localhost:3000";
  let parsed: URL;
  try {
    parsed = new URL(baseCandidate);
  } catch {
    return { ok: false, error: `Invalid dashboard base URL: ${baseCandidate}` };
  }

  if (isProduction) {
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "Production dashboard URL must use HTTPS." };
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
      return {
        ok: false,
        error: "Production dashboard URL cannot point to localhost/loopback.",
      };
    }
  }

  const cleanBase = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url: `${cleanBase}/inquiries/${encodeURIComponent(inquiryId.trim())}` };
}

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
}): Promise<
  | { ok: true; bot: BotIdentity; messageId: number }
  | { ok: false; error: string; errorKind?: TelegramErrorKind; retryAfterSeconds?: number }
> {
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
        retryAfterSeconds: sendRes.retryAfterSeconds,
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
      parameters?: { retry_after?: number };
    } | null;

    if (!res.ok || !data?.ok || !data.result) {
      const classified = classifyHttpError(res.status, data ?? undefined, "sendMessage");
      return {
        ok: false,
        error: sanitizeTelegramError(data?.description ?? "Telegram sendMessage failed", effectiveToken ?? undefined),
        errorKind: classified.errorKind,
        retryAfterSeconds: data?.parameters?.retry_after,
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

  // 1. Check budget before touching state
  if (options.deadline && options.deadline.getRemainingMs() < 2000) {
    return { status: "pending", reason: "budget_exceeded" };
  }

  // 2. Read delivery record
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

  // 3. Read configuration
  const setting = await readSellerNotificationConfig(db);
  if (!setting || !setting.enabled) {
    return { status: "paused", reason: "notifications_disabled" };
  }

  // 4. Rate limiting check prior to claim
  if (record.retryAfterUntil && record.retryAfterUntil.getTime() > Date.now()) {
    const remainingSec = Math.ceil((record.retryAfterUntil.getTime() - Date.now()) / 1000);
    return {
      status: "failed",
      errorCategory: "rate_limited",
      retryAfterSeconds: Math.max(1, remainingSec),
    };
  }

  // 5. Revision and destination binding check prior to claim
  if (
    record.revision !== setting.revision ||
    record.destinationChatId !== setting.destinationChatId
  ) {
    await markDeliveryCancelled(db, deliveryId, "incompatible_configuration");
    return { status: "cancelled", reason: "incompatible_configuration" };
  }

  // 6. Atomic claim forwarding explicit unknown duplicate risk acknowledgment
  const attemptId = crypto.randomUUID();
  const claimRes = await claimDeliveryAttemptDetailed(db, deliveryId, {
    attemptId,
    leaseMs: 60_000,
    acknowledgeUnknownRisk: Boolean(options.acknowledgeUnknownRisk),
  });

  if (!claimRes.claimed) {
    if (claimRes.reason === "already_sent") {
      return { status: "sent", messageId: claimRes.messageId ?? 0 };
    }
    if (claimRes.reason === "cancelled") {
      return { status: "cancelled", reason: claimRes.errorCategory ?? "cancelled" };
    }
    if (claimRes.reason === "requires_duplicate_acknowledgment") {
      return {
        status: "unknown",
        errorCategory: "requires_duplicate_acknowledgment",
      };
    }
    if (claimRes.reason === "rate_limited") {
      const remainingSec = claimRes.retryAfterUntil
        ? Math.ceil((claimRes.retryAfterUntil.getTime() - Date.now()) / 1000)
        : 10;
      return {
        status: "failed",
        errorCategory: "rate_limited",
        retryAfterSeconds: Math.max(1, remainingSec),
      };
    }
    if (claimRes.reason === "in_flight") {
      return { status: "in_flight" };
    }
    return { status: "cancelled", reason: "record_not_found" };
  }

  // From here onward, the record is CLAIMED ('sending' status with active attemptId).
  // Any terminal transition must pass attemptId to guarantee freshness.

  // 7. Validate dashboard URL
  const dashboardUrlRes = getTrustedDashboardInquiryUrl(record.inquiryId);
  if (!dashboardUrlRes.ok) {
    await markDeliveryFailed(db, deliveryId, attemptId, "invalid_dashboard_url");
    return { status: "failed", errorCategory: "invalid_dashboard_url" };
  }

  // 8. Bot token check
  const token = options.botToken ?? getSellerNotificationBotToken();
  if (!token && !options.transport) {
    await markDeliveryFailed(db, deliveryId, attemptId, "missing_token");
    return { status: "failed", errorCategory: "missing_token" };
  }

  // 9. Deadline check before network work starts
  const remainingBudget = options.deadline
    ? options.deadline.getRemainingMs()
    : DEFAULT_REQUEST_TIMEOUT_MS;

  if (remainingBudget < 2000) {
    // Release claim back to pending without marking unknown since no send was attempted
    await releaseDeliveryClaim(db, deliveryId, attemptId);
    return { status: "pending", reason: "budget_exceeded" };
  }

  // 10. Bot identity verification
  if (!options.transport && token) {
    const meTimeout = Math.min(5000, Math.max(1000, remainingBudget - 1000));
    const meRes = await getSellerBotMe(token, meTimeout);
    if (!meRes.ok) {
      if (meRes.errorKind === "timeout" || meRes.errorKind === "network_error") {
        await releaseDeliveryClaim(db, deliveryId, attemptId);
        return { status: "pending", reason: meRes.errorKind };
      }
      await markDeliveryFailed(db, deliveryId, attemptId, meRes.errorKind ?? "api_error");
      return { status: "failed", errorCategory: meRes.errorKind ?? "api_error" };
    }
    if (setting.verifiedBotId && meRes.bot.id !== setting.verifiedBotId) {
      await markDeliveryCancelledByWorker(db, deliveryId, attemptId, "bot_identity_changed");
      return { status: "cancelled", reason: "bot_identity_changed" };
    }
  }

  // 11. Load inquiry details for content
  const inquiryRow = await getInquiryRecord(db, record.inquiryId);
  if (!inquiryRow) {
    await markDeliveryCancelledByWorker(db, deliveryId, attemptId, "inquiry_not_found");
    return { status: "cancelled", reason: "inquiry_not_found" };
  }

  const isSupport = inquiryRow.productId === null;
  let productName: string | null = null;
  if (!isSupport && inquiryRow.productSnapshot && typeof inquiryRow.productSnapshot === "object") {
    const snap = inquiryRow.productSnapshot as Record<string, unknown>;
    productName = typeof snap.name === "string" ? snap.name : null;
  }
  const categoryName = inquiryRow.category;

  const formatted = formatSellerNotificationMessage({
    isSupport,
    reference: inquiryRow.reference,
    deliveryReference: record.reference,
    productName,
    categoryName,
    createdAt: inquiryRow.createdAt,
    language: setting.language === "en" ? "en" : "ar",
    dashboardUrl: dashboardUrlRes.url,
  });

  // 12. Final budget check before dispatching sendMessage
  // Reserve 1500ms for database persistence and webhook response completion
  const sendBudget = options.deadline
    ? options.deadline.getRemainingMs()
    : DEFAULT_REQUEST_TIMEOUT_MS;

  const RESERVED_PERSISTENCE_BUDGET_MS = 1500;
  const usableSendBudget = sendBudget - RESERVED_PERSISTENCE_BUDGET_MS;

  if (usableSendBudget < 1500) {
    await releaseDeliveryClaim(db, deliveryId, attemptId);
    return { status: "pending", reason: "budget_exceeded" };
  }

  // 13. Authoritative pre-dispatch authorization check
  // Verifies current enabled state, configuration revision, destination, verified bot,
  // record status, and active attempt ID immediately before network dispatch.
  const authCheck = await revalidatePreDispatchAuthorization(db, {
    deliveryId,
    attemptId,
    expectedRevision: record.revision,
    expectedDestination: record.destinationChatId,
    expectedBotId: setting.verifiedBotId,
  });

  if (!authCheck.authorized) {
    if (authCheck.reason === "claim_lost") {
      return { status: "in_flight" };
    }
    if (authCheck.reason === "incompatible_configuration") {
      return { status: "cancelled", reason: "incompatible_configuration" };
    }
    return { status: "pending", reason: "notifications_disabled" };
  }

  // 14. Network transmission
  try {
    let sendResult: TelegramSendResult;

    if (options.transport) {
      sendResult = await options.transport.sendMessage({
        chatId: record.destinationChatId,
        text: formatted.text,
        replyMarkup: formatted.replyMarkup,
      });
    } else {
      const sendTimeout = Math.min(DEFAULT_REQUEST_TIMEOUT_MS, usableSendBudget);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: record.destinationChatId,
          text: formatted.text,
          reply_markup: formatted.replyMarkup,
        }),
        signal: AbortSignal.timeout(sendTimeout),
      });

      const rawText = await res.text().catch(() => null);
      let data: {
        ok?: boolean;
        result?: { message_id?: number };
        description?: string;
        parameters?: { retry_after?: number };
      } | null = null;
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = null;
        }
      }

      if (res.ok && data?.ok === true && typeof data.result?.message_id === "number") {
        sendResult = { ok: true, messageId: data.result.message_id };
      } else if (res.status === 200) {
        // Telegram accepted the HTTP request and replied 200 OK, but JSON was malformed
        // or message_id was missing/invalid. Acceptance cannot be ruled out -> UNKNOWN!
        sendResult = {
          ok: false,
          error: "Ambiguous Telegram 200 response without valid message acknowledgment",
          errorKind: "api_error",
          httpStatus: 200,
        };
      } else if (res.status === 429) {
        sendResult = {
          ok: false,
          error: sanitizeTelegramError(data?.description ?? "Telegram rate limited", token ?? undefined),
          errorKind: "rate_limited",
          httpStatus: 429,
          retryAfterSeconds: data?.parameters?.retry_after ?? 10,
        };
      } else if (res.status >= 400 && res.status < 500) {
        const classified = classifyHttpError(res.status, data ?? undefined, "sendMessage");
        sendResult = {
          ok: false,
          error: sanitizeTelegramError(data?.description ?? "Send failed", token ?? undefined),
          errorKind: classified.errorKind,
          httpStatus: res.status,
        };
      } else {
        // 5xx server error, or non-standard status
        sendResult = {
          ok: false,
          error: sanitizeTelegramError(data?.description ?? `Telegram server error ${res.status}`, token ?? undefined),
          errorKind: "api_error",
          httpStatus: res.status,
        };
      }
    }

    if (sendResult.ok && typeof sendResult.messageId === "number") {
      try {
        const applied = await markDeliverySent(db, deliveryId, attemptId, sendResult.messageId);
        if (!applied) {
          const current = await getSellerNotificationDelivery(db, deliveryId);
          if (current?.status === "sent") {
            return { status: "sent", messageId: current.telegramMessageId ?? sendResult.messageId };
          }
          return { status: "unknown", errorCategory: "persistence_mismatch" };
        }
        return { status: "sent", messageId: sendResult.messageId };
      } catch {
        return { status: "unknown", errorCategory: "persistence_error" };
      }
    }

    // Classify Telegram response
    if (sendResult.errorKind === "rate_limited") {
      const retryAfter = sendResult.retryAfterSeconds ?? 10;
      const failedRes = await markDeliveryFailed(db, deliveryId, attemptId, "rate_limited", retryAfter);
      if (!failedRes.applied) {
        const current = await getSellerNotificationDelivery(db, deliveryId);
        if (current?.status === "sent") {
          return { status: "sent", messageId: current.telegramMessageId ?? 0 };
        }
        if (current?.status === "cancelled") {
          return { status: "cancelled", reason: current.errorCategory ?? "cancelled" };
        }
        return {
          status: "failed",
          errorCategory: "rate_limited",
          retryAfterSeconds: retryAfter,
        };
      }
      return { status: "failed", errorCategory: "rate_limited", retryAfterSeconds: retryAfter };
    }

    // Uncertain failures after send dispatched: timeout, network error, ambiguous response, or 5xx server error
    if (
      sendResult.errorKind === "timeout" ||
      sendResult.errorKind === "network_error" ||
      sendResult.httpStatus === 200 ||
      (sendResult.httpStatus && sendResult.httpStatus >= 500)
    ) {
      const errCategory =
        sendResult.errorKind === "timeout"
          ? "timeout"
          : sendResult.httpStatus === 200
          ? "ambiguous_telegram_response"
          : sendResult.httpStatus && sendResult.httpStatus >= 500
          ? "telegram_server_error"
          : "network_uncertainty";
      const unknownRes = await markDeliveryUnknown(db, deliveryId, attemptId, errCategory);
      if (!unknownRes.applied) {
        const current = await getSellerNotificationDelivery(db, deliveryId);
        if (current?.status === "sent") {
          return { status: "sent", messageId: current.telegramMessageId ?? 0 };
        }
        if (current?.status === "cancelled") {
          return { status: "cancelled", reason: current.errorCategory ?? "cancelled" };
        }
        return { status: "unknown", errorCategory: errCategory };
      }
      return { status: "unknown", errorCategory: errCategory };
    }

    // Definitive client/authentication rejection (400, 401, 403, 404, etc.)
    const cat = sendResult.errorKind ?? "api_error";
    const failedRes = await markDeliveryFailed(db, deliveryId, attemptId, cat);
    if (!failedRes.applied) {
      const current = await getSellerNotificationDelivery(db, deliveryId);
      if (current?.status === "sent") {
        return { status: "sent", messageId: current.telegramMessageId ?? 0 };
      }
      if (current?.status === "cancelled") {
        return { status: "cancelled", reason: current.errorCategory ?? "cancelled" };
      }
      return { status: "failed", errorCategory: cat };
    }
    return { status: "failed", errorCategory: cat };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    const errorCat = isTimeout ? "timeout" : "network_uncertainty";
    const unknownRes = await markDeliveryUnknown(db, deliveryId, attemptId, errorCat);
    if (!unknownRes.applied) {
      const current = await getSellerNotificationDelivery(db, deliveryId);
      if (current?.status === "sent") {
        return { status: "sent", messageId: current.telegramMessageId ?? 0 };
      }
      if (current?.status === "cancelled") {
        return { status: "cancelled", reason: current.errorCategory ?? "cancelled" };
      }
      return { status: "unknown", errorCategory: errorCat };
    }
    return { status: "unknown", errorCategory: errorCat };
  }
}

