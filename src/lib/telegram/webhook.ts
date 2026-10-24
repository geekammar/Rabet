import "server-only";

import crypto from "node:crypto";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
} from "@/lib/data/telegram";
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

const START_COMMAND_REGEX = /^\/start(?:@\w+)?(?:\s+.*)?$/i;

export interface WebhookHandlerOptions {
  db?: Database;
  transport?: TelegramTransport;
  botToken?: string;
  webhookSecret?: string;
}

interface ValidatedUpdate {
  update: TelegramUpdate;
  updateType: "message" | "callback_query";
}

/**
 * Validates the runtime shape of an incoming Telegram update.
 * Returns { valid: false, error: string } for malformed updates,
 * { valid: true, ignored: true } for unsupported update types / non-private chats,
 * or { valid: true, data: ValidatedUpdate } for valid private chat updates.
 */
function validateIncomingUpdate(
  rawBody: unknown,
):
  | { valid: false; error: string }
  | { valid: true; ignored: true }
  | { valid: true; ignored: false; data: ValidatedUpdate } {
  if (typeof rawBody !== "object" || rawBody === null) {
    return { valid: false, error: "Malformed payload" };
  }

  const obj = rawBody as Record<string, unknown>;

  if (
    typeof obj.update_id !== "number" ||
    !Number.isInteger(obj.update_id) ||
    obj.update_id < 1 ||
    obj.update_id > Number.MAX_SAFE_INTEGER
  ) {
    return { valid: false, error: "Invalid update_id" };
  }

  // 1. Message update
  if ("message" in obj && obj.message !== null && obj.message !== undefined) {
    if (typeof obj.message !== "object" || obj.message === null) {
      return { valid: false, error: "Malformed message object" };
    }
    const msg = obj.message as Record<string, unknown>;

    if (
      typeof msg.message_id !== "number" ||
      !Number.isInteger(msg.message_id) ||
      msg.message_id < 1 ||
      typeof msg.chat !== "object" ||
      msg.chat === null
    ) {
      return { valid: false, error: "Malformed message fields" };
    }

    const chat = msg.chat as Record<string, unknown>;
    if (typeof chat.id !== "number" || typeof chat.type !== "string") {
      return { valid: false, error: "Malformed chat fields" };
    }

    if (msg.from !== undefined && (typeof msg.from !== "object" || msg.from === null)) {
      return { valid: false, error: "Malformed from field" };
    }

    // Only private chats are supported in this phase
    if (chat.type !== "private") {
      return { valid: true, ignored: true };
    }

    return {
      valid: true,
      ignored: false,
      data: {
        update: obj as unknown as TelegramUpdate,
        updateType: "message",
      },
    };
  }

  // 2. Callback query update
  if ("callback_query" in obj && obj.callback_query !== null && obj.callback_query !== undefined) {
    if (typeof obj.callback_query !== "object" || obj.callback_query === null) {
      return { valid: false, error: "Malformed callback_query object" };
    }
    const cb = obj.callback_query as Record<string, unknown>;

    if (
      typeof cb.id !== "string" ||
      cb.id.trim().length === 0 ||
      typeof cb.from !== "object" ||
      cb.from === null ||
      typeof (cb.from as Record<string, unknown>).id !== "number"
    ) {
      return { valid: false, error: "Malformed callback_query fields" };
    }

    // If callback query has an attached message, validate it and check chat type
    if (cb.message !== undefined && cb.message !== null) {
      if (typeof cb.message !== "object" || cb.message === null) {
        return { valid: false, error: "Malformed callback message" };
      }
      const cbMsg = cb.message as Record<string, unknown>;
      if (
        typeof cbMsg.message_id !== "number" ||
        typeof cbMsg.chat !== "object" ||
        cbMsg.chat === null
      ) {
        return { valid: false, error: "Malformed callback message fields" };
      }
      const cbChat = cbMsg.chat as Record<string, unknown>;
      if (typeof cbChat.id !== "number" || typeof cbChat.type !== "string") {
        return { valid: false, error: "Malformed callback chat fields" };
      }

      if (cbChat.type !== "private") {
        return { valid: true, ignored: true };
      }
    }

    return {
      valid: true,
      ignored: false,
      data: {
        update: obj as unknown as TelegramUpdate,
        updateType: "callback_query",
      },
    };
  }

  // Unsupported update type (e.g. channel_post, inline_query, etc.)
  return { valid: true, ignored: true };
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
      JSON.stringify({ error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 3. JSON body parsing
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Bad request" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 4. Runtime validation of update shape
  const validation = validateIncomingUpdate(rawBody);
  if (!validation.valid) {
    return new Response(
      JSON.stringify({ error: "Bad request" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (validation.ignored) {
    return new Response(
      JSON.stringify({ ok: true, ignored: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const { update, updateType } = validation.data;
  let attemptId: string | undefined;
  let db: Database | undefined;

  // 5. Complete error boundary protecting DB acquisition, claiming, dispatch, and completion
  try {
    db = options?.db ?? getDb();
    const transport = options?.transport ?? createFetchTelegramTransport(botToken);

    // Atomically claim attempt ownership
    const claim = await claimTelegramUpdate(db, {
      updateId: update.update_id,
      updateType,
      payload: update,
    });

    if (claim.status === "already_processed") {
      return new Response(
        JSON.stringify({ ok: true, status: "already_processed" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (claim.status === "in_flight") {
      return new Response(
        JSON.stringify({ ok: true, status: "in_flight" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    attemptId = claim.attemptId;

    // 6. Dispatch business logic
    if (update.message) {
      const text = update.message.text?.trim() ?? "";
      if (START_COMMAND_REGEX.test(text)) {
        await handleStartCommand(db, transport, update.message);
      } else {
        // Helpful plain-text guidance for non-start text messages
        const guideRes = await transport.sendMessage({
          chatId: update.message.chat.id,
          text: "To browse our catalog, please send /start",
        });
        if (!guideRes.ok) {
          throw new Error(guideRes.error ?? "Failed to deliver guidance message");
        }
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(db, transport, update.callback_query);
    }

    // 7. Mark attempt successfully processed
    await markTelegramUpdateProcessed(db, {
      updateId: update.update_id,
      attemptId,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // 8. Safe failure bookkeeping: do not leak tokens, secrets, or SQL
    if (db && attemptId) {
      try {
        const sanitizedDiagnostic = sanitizeTelegramError(err, [botToken, webhookSecret]);
        await markTelegramUpdateFailed(db, {
          updateId: update.update_id,
          attemptId,
          errorMessage: sanitizedDiagnostic,
        });
      } catch {
        // Failure bookkeeping must never mask the original dispatch error
      }
    }

    // Public response uses fixed sanitized message
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
