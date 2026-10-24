import "server-only";

import crypto from "node:crypto";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
  recordTelegramUpdate,
} from "@/lib/data";
import { handleCallbackQuery, handleStartCommand } from "./catalog-journey";
import {
  createFetchTelegramTransport,
  sanitizeTelegramError,
} from "./transport";
import type { TelegramTransport, TelegramUpdate } from "./types";

/**
 * Constant-time comparison of secret tokens to prevent timing attacks.
 */
export function safeCompareSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    // Run dummy timingSafeEqual to normalize execution time
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

export interface WebhookHandlerOptions {
  db?: Database;
  transport?: TelegramTransport;
  botToken?: string;
  webhookSecret?: string;
}

/**
 * Authoritatively handles incoming Telegram webhook requests.
 */
export async function handleTelegramWebhookRequest(
  req: Request,
  options?: WebhookHandlerOptions,
): Promise<Response> {
  const botToken = options?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = options?.webhookSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET;

  // 1. Mandatory configuration validation (fails closed with sanitized response)
  if (!botToken || !webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Telegram webhook is not configured." }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 2. Mandatory request secret validation (X-Telegram-Bot-Api-Secret-Token)
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!incomingSecret || !safeCompareSecret(incomingSecret, webhookSecret)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: Invalid or missing secret token." }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 3. JSON body parsing and update structure validation
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Bad Request: Malformed JSON body." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    !("update_id" in rawBody) ||
    typeof (rawBody as { update_id: unknown }).update_id !== "number"
  ) {
    return new Response(
      JSON.stringify({ error: "Bad Request: Missing or invalid update_id." }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const update = rawBody as TelegramUpdate;

  // 4. Update type identification and private chat scoping
  let updateType: string | null = null;
  let isPrivate = false;

  if (update.message) {
    updateType = "message";
    isPrivate = update.message.chat?.type === "private";
  } else if (update.callback_query) {
    updateType = "callback_query";
    isPrivate = update.callback_query.message?.chat?.type === "private";
  }

  // Unsupported update type or non-private chat: ignore safely without creating business records
  if (!updateType || !isPrivate) {
    return new Response(
      JSON.stringify({ ok: true, ignored: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const db = options?.db ?? getDb();
  const transport = options?.transport ?? createFetchTelegramTransport(botToken);

  // 5. Update deduplication in database
  const dedup = await recordTelegramUpdate(db, {
    updateId: update.update_id,
    updateType,
    payload: update,
  });

  if (!dedup.inserted) {
    // Already processed successfully
    if (dedup.row.processedAt !== null) {
      return new Response(
        JSON.stringify({ ok: true, status: "already_processed" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // In flight by another concurrent request
    if (dedup.row.processingError === null) {
      return new Response(
        JSON.stringify({ ok: true, status: "in_flight" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Otherwise: processingError was set, so this is a retry of a failed attempt. Proceed.
  }

  // 6. Dispatch and error handling
  try {
    if (update.message) {
      const text = update.message.text?.trim() ?? "";
      if (text.startsWith("/start")) {
        await handleStartCommand(db, transport, update.message);
      } else {
        // Helpful plain-text guidance for non-start text messages
        await transport.sendMessage({
          chatId: update.message.chat.id,
          text: "To browse our catalog, please send /start",
        });
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(db, transport, update.callback_query);
    }

    // Mark successfully processed
    await markTelegramUpdateProcessed(db, update.update_id);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const sanitizedError = sanitizeTelegramError(err, botToken);
    await markTelegramUpdateFailed(db, update.update_id, sanitizedError);

    return new Response(
      JSON.stringify({
        error: "Internal error processing Telegram update.",
        details: sanitizedError,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
