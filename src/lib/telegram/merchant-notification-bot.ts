import "server-only";

import crypto from "node:crypto";

import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
  type TelegramBotUpdate,
} from "./manager-api";
import { createFetchTelegramTransport } from "./transport";
import type {
  TelegramErrorKind,
  TelegramSendResult,
  TelegramTransport,
} from "./types";

/**
 * Server-only Telegram operations for a merchant-owned notification bot.
 *
 * This module is deliberately independent of checkout, order state and payment
 * state. It validates a bot token, detects the private chat that completed a
 * short-lived pairing payload, and sends a test message. Every error returned
 * here is an allowlisted code: raw Telegram descriptions and the bot token are
 * never included in a result, a page or a log line.
 */

const BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,128}$/;
const BOT_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PAIRING_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PRIVATE_CHAT_ID_PATTERN = /^[1-9][0-9]{4,19}$/;

export const MERCHANT_NOTIFICATION_PAIRING_TTL_MS = 10 * 60 * 1000;

export type MerchantNotificationBotIdentity = {
  id: number;
  username: string;
  name: string | null;
};

export type MerchantNotificationBotIdentityResult =
  | { ok: true; bot: MerchantNotificationBotIdentity }
  | {
      ok: false;
      code: "INVALID_TOKEN" | "TELEGRAM_UNAVAILABLE";
      retryAfterSeconds?: number;
    };

/** Trims a submitted token and rejects empty or malformed values. */
export function normalizeMerchantNotificationBotToken(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;

  const token = value.trim();

  if (token.length === 0 || token.length > 200) return null;
  if (!BOT_TOKEN_PATTERN.test(token)) return null;

  return token;
}

export function generateMerchantNotificationPairingCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function hashMerchantNotificationPairingCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

export function merchantNotificationPairingDeepLink(
  botUsername: string,
  code: string,
): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`;
}

/**
 * Reads the bot identity with `getMe`. A token that Telegram rejects maps to
 * `INVALID_TOKEN`; transport failures map to `TELEGRAM_UNAVAILABLE`.
 */
export async function readMerchantNotificationBotIdentity(
  token: string,
  deps?: { api?: TelegramBotApiClient },
): Promise<MerchantNotificationBotIdentityResult> {
  const api = deps?.api ?? createTelegramBotApiClient(token);
  const me = await api.getMe();

  if (!me.ok) {
    if (me.httpStatus === 401 || me.httpStatus === 404) {
      return { ok: false, code: "INVALID_TOKEN" };
    }

    return {
      ok: false,
      code: "TELEGRAM_UNAVAILABLE",
      retryAfterSeconds: me.retryAfterSeconds,
    };
  }

  if (
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    !BOT_USERNAME_PATTERN.test(me.result.username)
  ) {
    return { ok: false, code: "INVALID_TOKEN" };
  }

  return {
    ok: true,
    bot: {
      id: me.result.id,
      username: me.result.username,
      name: me.result.first_name ?? null,
    },
  };
}

/**
 * Extracts the payload from a `/start` deep link or accepts a bare pairing
 * code. Anything else is ignored. The pair payload is short-lived and random;
 * this function never treats ordinary chat text as a code unless it exactly
 * matches the stored digest later.
 */
export function merchantNotificationPairingPayloadFromText(
  text: unknown,
): string | null {
  if (typeof text !== "string") return null;

  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > 256) return null;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === "/start" || command.startsWith("/start@")) {
    return parts[1] ?? null;
  }

  if (parts.length === 1) return parts[0];

  return null;
}

export type MerchantNotificationPairingMatch =
  | { status: "pending" }
  | {
      status: "paired";
      chat: {
        chatId: string;
        title: string | null;
        username: string | null;
      };
    }
  | { status: "ambiguous" };

function privateChatCandidate(message: {
  chat: {
    id: number;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  from?: {
    first_name?: string;
    last_name?: string;
    username?: string;
    is_bot?: boolean;
  };
  date: number;
  text?: string;
}): {
  chatId: string;
  title: string | null;
  username: string | null;
  date: number;
  payload: string;
} | null {
  if (message.chat.type !== "private") return null;
  if (message.from?.is_bot === true) return null;

  const chatId = String(message.chat.id);

  if (!PRIVATE_CHAT_ID_PATTERN.test(chatId)) return null;

  const payload = merchantNotificationPairingPayloadFromText(message.text);

  if (!payload || !PAIRING_CODE_PATTERN.test(payload)) return null;

  const fromName = [message.from?.first_name, message.from?.last_name]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();

  const title =
    message.chat.title ??
    (fromName.length > 0 ? fromName : null) ??
    message.chat.first_name ??
    null;

  return {
    chatId,
    title,
    username: message.chat.username ?? message.from?.username ?? null,
    date: message.date,
    payload,
  };
}

/**
 * Finds the single private chat whose latest message carries the pairing code
 * matching `expectedHash`. Multiple distinct chats are reported as ambiguous
 * instead of choosing one.
 */
export function findMerchantNotificationPairingMatch(
  updates: TelegramBotUpdate[],
  expectedHash: string,
): MerchantNotificationPairingMatch {
  if (!PAIRING_HASH_PATTERN.test(expectedHash)) {
    return { status: "pending" };
  }

  const matches = new Map<
    string,
    { chatId: string; title: string | null; username: string | null; date: number }
  >();

  for (const update of updates) {
    const message = update.message;

    if (!message) continue;

    const candidate = privateChatCandidate(message);

    if (!candidate) continue;

    if (
      hashMerchantNotificationPairingCode(candidate.payload) !== expectedHash
    ) {
      continue;
    }

    const current = matches.get(candidate.chatId);

    if (!current || candidate.date >= current.date) {
      matches.set(candidate.chatId, {
        chatId: candidate.chatId,
        title: candidate.title,
        username: candidate.username,
        date: candidate.date,
      });
    }
  }

  if (matches.size === 0) return { status: "pending" };

  if (matches.size > 1) return { status: "ambiguous" };

  const [chat] = matches.values();

  return {
    status: "paired",
    chat: {
      chatId: chat.chatId,
      title: chat.title,
      username: chat.username,
    },
  };
}

type MerchantNotificationPairingProgress = {
  /**
   * The next Telegram update id to request, or null when the batch contained
   * no updates. Persisted only for the same live challenge.
   */
  nextOffset: number | null;
};

export type MerchantNotificationBotPairingResult =
  | (MerchantNotificationPairingMatch & MerchantNotificationPairingProgress)
  | {
      status: "error";
      code:
        | "INVALID_TOKEN"
        | "WEBHOOK_ACTIVE"
        | "RATE_LIMITED"
        | "NETWORK"
        | "UNAVAILABLE";
      retryAfterSeconds?: number;
    };

function classifyPairingFailure(result: {
  error?: string;
  errorKind?: TelegramErrorKind;
  httpStatus?: number;
  retryAfterSeconds?: number;
}): Extract<MerchantNotificationBotPairingResult, { status: "error" }> {
  if (result.errorKind === "rate_limited") {
    return {
      status: "error",
      code: "RATE_LIMITED",
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }

  if (
    result.httpStatus === 409 ||
    (result.error ?? "").toLowerCase().includes("webhook")
  ) {
    return { status: "error", code: "WEBHOOK_ACTIVE" };
  }

  if (result.httpStatus === 401 || result.httpStatus === 404) {
    return { status: "error", code: "INVALID_TOKEN" };
  }

  if (
    result.errorKind === "timeout" ||
    result.errorKind === "network_error"
  ) {
    return { status: "error", code: "NETWORK" };
  }

  return { status: "error", code: "UNAVAILABLE" };
}

const PAIRING_UPDATE_BATCH_LIMIT = 100;
const DEFAULT_PAIRING_MAX_BATCHES = 10;
const MAX_PAIRING_MAX_BATCHES = 50;

function boundedBatchCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PAIRING_MAX_BATCHES;
  }

  return Math.min(
    MAX_PAIRING_MAX_BATCHES,
    Math.max(1, Math.floor(value)),
  );
}

function validOffset(value: number | null | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
    ? value
    : undefined;
}

/**
 * Reads update batches from the notification bot and looks for the pairing
 * code. The persisted offset makes repeated checks advance through a backlog
 * in bounded batches. A batch is always evaluated before the next request
 * confirms it, so an update that may contain the active challenge is never
 * discarded first.
 *
 * The bot must not have a webhook registered; Telegram rejects `getUpdates`
 * with a conflict when one is active, which is reported as `WEBHOOK_ACTIVE`.
 */
export async function readMerchantNotificationBotPairing(
  token: string,
  expectedHash: string,
  deps?: {
    api?: TelegramBotApiClient;
    offset?: number | null;
    maxBatches?: number;
  },
): Promise<MerchantNotificationBotPairingResult> {
  const api = deps?.api ?? createTelegramBotApiClient(token);
  const maxBatches = boundedBatchCount(deps?.maxBatches);
  let offset = validOffset(deps?.offset);

  let highestUpdateId: number | null = null;

  for (let batch = 0; batch < maxBatches; batch++) {
    const updates = await api.getUpdates({
      ...(offset !== undefined ? { offset } : {}),
      limit: PAIRING_UPDATE_BATCH_LIMIT,
      allowedUpdates: ["message"],
    });

    if (!updates.ok) {
      return classifyPairingFailure(updates);
    }

    if (updates.result.length === 0) break;

    let batchHighest: number | null = null;

    for (const update of updates.result) {
      if (Number.isSafeInteger(update.update_id)) {
        batchHighest =
          batchHighest === null
            ? update.update_id
            : Math.max(batchHighest, update.update_id);
      }
    }

    const batchNextOffset =
      batchHighest === null ? null : batchHighest + 1;

    // Evaluate the whole batch before any later request can confirm it.
    const match = findMerchantNotificationPairingMatch(
      updates.result,
      expectedHash,
    );

    if (match.status === "paired") {
      return { ...match, nextOffset: batchNextOffset };
    }

    if (match.status === "ambiguous") {
      return { ...match, nextOffset: batchNextOffset };
    }

    if (batchHighest === null) break;

    // A server or fake that ignores offset must not make this loop spin.
    if (
      highestUpdateId !== null &&
      batchHighest <= highestUpdateId
    ) {
      break;
    }

    highestUpdateId = batchHighest;

    // The next getUpdates call confirms the batch we just evaluated.
    offset = batchHighest + 1;
  }

  return {
    status: "pending",
    nextOffset:
      highestUpdateId === null ? null : highestUpdateId + 1,
  };
}

export type MerchantNotificationTestFailureCode =
  | "INVALID_TOKEN"
  | "BLOCKED"
  | "CHAT_NOT_FOUND"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TELEGRAM_REJECTED";

export type MerchantNotificationTestResult =
  | { ok: true; messageId?: number }
  | {
      ok: false;
      code: MerchantNotificationTestFailureCode;
      retryAfterSeconds?: number;
    };

function classifyTestSendFailure(
  result: TelegramSendResult,
): Extract<MerchantNotificationTestResult, { ok: false }> {
  if (result.isBlocked === true || result.errorKind === "blocked") {
    return { ok: false, code: "BLOCKED" };
  }

  if (result.errorKind === "rate_limited") {
    return {
      ok: false,
      code: "RATE_LIMITED",
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }

  if (
    result.errorKind === "timeout" ||
    result.errorKind === "network_error"
  ) {
    return { ok: false, code: "NETWORK" };
  }

  const description = (result.error ?? "").toLowerCase();

  if (
    description.includes("chat not found") ||
    description.includes("chat_id is empty") ||
    description.includes("user not found")
  ) {
    return { ok: false, code: "CHAT_NOT_FOUND" };
  }

  if (result.httpStatus === 401 || description.includes("unauthorized")) {
    return { ok: false, code: "INVALID_TOKEN" };
  }

  return { ok: false, code: "TELEGRAM_REJECTED" };
}

export function buildMerchantNotificationTestMessage(
  locale: "ar" | "en",
  storeName: string,
): string {
  const safeName = storeName.trim().slice(0, 120);

  if (locale === "ar") {
    const name = safeName.length > 0 ? safeName : "متجرك";
    return [
      `✅ تم ربط إشعارات ${name} بنجاح.`,
      "هذه رسالة تجريبية من إعدادات الإشعارات.",
    ].join("\n");
  }

  const name = safeName.length > 0 ? safeName : "Your store";
  return [
    `✅ ${name} notifications are connected.`,
    "This is a test message from your notification settings.",
  ].join("\n");
}

/**
 * Sends the test notification through the shared Telegram transport, so the
 * same sanitisation and rate-limit classification used elsewhere applies here.
 */
export async function sendMerchantNotificationBotTest(input: {
  token: string;
  chatId: string;
  locale: "ar" | "en";
  storeName: string;
  transport?: TelegramTransport;
}): Promise<MerchantNotificationTestResult> {
  const transport =
    input.transport ?? createFetchTelegramTransport(input.token);

  const result = await transport.sendMessage({
    chatId: input.chatId,
    text: buildMerchantNotificationTestMessage(
      input.locale,
      input.storeName,
    ),
  });

  if (!result.ok) {
    return classifyTestSendFailure(result);
  }

  return { ok: true, messageId: result.messageId };
}
