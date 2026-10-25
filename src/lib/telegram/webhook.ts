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
import { parseToken, type ParsedToken } from "./tokens";
import {
  classifyErrorToSafeDiagnostic,
  createFetchTelegramTransport,
  formatSafeDiagnostic,
  StandardExecutionDeadline,
} from "./transport";
import type {
  ExecutionDeadline,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramTransport,
  TelegramUpdate,
} from "./types";
import {
  FencingRejectedError,
  TelegramTransportError,
} from "./types";

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
export const DEFAULT_EXECUTION_BUDGET_MS = 25_000;

export interface WebhookHandlerOptions {
  db?: Database;
  transport?: TelegramTransport;
  botToken?: string;
  webhookSecret?: string;
  executionBudgetMs?: number;
  deadline?: ExecutionDeadline;
  now?: () => number;
}

export type ValidatedUpdate =
  | {
      updateType: "message";
      update: TelegramUpdate;
      message: TelegramMessage;
    }
  | {
      updateType: "callback_query";
      update: TelegramUpdate;
      callbackQuery: TelegramCallbackQuery;
      parsedToken: ParsedToken;
    };

/**
 * Validates the runtime shape of an incoming Telegram update before any claim or business effects.
 *
 * Rules:
 * 1. update_id must be a finite safe integer in [1..Number.MAX_SAFE_INTEGER].
 * 2. An update cannot contain both `message` and `callback_query` (contradictory shape).
 * 3. Message updates:
 *    - message_id must be a safe positive integer.
 *    - chat must have safe integer id and string type.
 *    - Non-private chat messages are safely ignored without database writes.
 *    - from must be present with safe positive integer id.
 *    - Optional fields (first_name, last_name, username, is_bot, language_code) must have correct types when present.
 *    - text must be a string if present.
 * 4. Callback query updates:
 *    - id must be a non-empty string.
 *    - from must be present with safe positive integer id.
 *    - message (if present) must have safe positive integer message_id and chat with safe integer id and string type.
 *    - Non-private callback messages are safely ignored without database writes.
 *    - data must be a string with 1..64 UTF-8 bytes and must parse to a recognized token grammar.
 * 5. Malformed updates return { valid: false } (which triggers HTTP 400 Bad request with zero DB writes).
 * 6. Legitimate unsupported update types (e.g. channel_post) return { valid: true, ignored: true } (HTTP 200).
 */
export function validateIncomingUpdate(
  rawBody: unknown,
):
  | { valid: false; error: string }
  | { valid: true; ignored: true }
  | { valid: true; ignored: false; data: ValidatedUpdate } {
  if (typeof rawBody !== "object" || rawBody === null) {
    return { valid: false, error: "Malformed payload" };
  }

  const obj = rawBody as Record<string, unknown>;

  // 1. Validate update_id
  if (
    typeof obj.update_id !== "number" ||
    !Number.isInteger(obj.update_id) ||
    obj.update_id < 1 ||
    obj.update_id > Number.MAX_SAFE_INTEGER
  ) {
    return { valid: false, error: "Invalid update_id" };
  }

  const hasMessage = "message" in obj && obj.message !== null && obj.message !== undefined;
  const hasCallback =
    "callback_query" in obj && obj.callback_query !== null && obj.callback_query !== undefined;

  // 2. Reject contradictory supported update shapes
  if (hasMessage && hasCallback) {
    return { valid: false, error: "Contradictory update fields" };
  }

  // 3. Message update validation
  if (hasMessage) {
    if (typeof obj.message !== "object" || obj.message === null) {
      return { valid: false, error: "Malformed message object" };
    }
    const msg = obj.message as Record<string, unknown>;

    // message_id
    if (
      typeof msg.message_id !== "number" ||
      !Number.isInteger(msg.message_id) ||
      msg.message_id < 1 ||
      msg.message_id > Number.MAX_SAFE_INTEGER
    ) {
      return { valid: false, error: "Malformed message_id" };
    }

    // chat
    if (typeof msg.chat !== "object" || msg.chat === null) {
      return { valid: false, error: "Missing chat object" };
    }
    const chat = msg.chat as Record<string, unknown>;
    if (
      typeof chat.id !== "number" ||
      !Number.isInteger(chat.id) ||
      !Number.isSafeInteger(chat.id) ||
      typeof chat.type !== "string"
    ) {
      return { valid: false, error: "Malformed chat fields" };
    }

    // Only private chats are supported in this phase; non-private safely ignored
    if (chat.type !== "private") {
      return { valid: true, ignored: true };
    }

    // from (required for private chat message interactions)
    if (typeof msg.from !== "object" || msg.from === null) {
      return { valid: false, error: "Missing from object in private chat" };
    }
    const from = msg.from as Record<string, unknown>;
    if (
      typeof from.id !== "number" ||
      !Number.isInteger(from.id) ||
      from.id < 1 ||
      from.id > Number.MAX_SAFE_INTEGER
    ) {
      return { valid: false, error: "Malformed from.id" };
    }

    if (from.is_bot !== undefined && typeof from.is_bot !== "boolean") {
      return { valid: false, error: "Malformed from.is_bot" };
    }
    if (from.first_name !== undefined && typeof from.first_name !== "string") {
      return { valid: false, error: "Malformed from.first_name" };
    }
    if (from.last_name !== undefined && typeof from.last_name !== "string") {
      return { valid: false, error: "Malformed from.last_name" };
    }
    if (from.username !== undefined && typeof from.username !== "string") {
      return { valid: false, error: "Malformed from.username" };
    }
    if (from.language_code !== undefined && typeof from.language_code !== "string") {
      return { valid: false, error: "Malformed from.language_code" };
    }

    // text
    if (msg.text !== undefined && typeof msg.text !== "string") {
      return { valid: false, error: "Malformed text field" };
    }

    return {
      valid: true,
      ignored: false,
      data: {
        updateType: "message",
        update: obj as unknown as TelegramUpdate,
        message: msg as unknown as TelegramMessage,
      },
    };
  }

  // 4. Callback query update validation
  if (hasCallback) {
    if (typeof obj.callback_query !== "object" || obj.callback_query === null) {
      return { valid: false, error: "Malformed callback_query object" };
    }
    const cb = obj.callback_query as Record<string, unknown>;

    // id
    if (typeof cb.id !== "string" || cb.id.trim().length === 0) {
      return { valid: false, error: "Malformed callback_query id" };
    }

    // from
    if (typeof cb.from !== "object" || cb.from === null) {
      return { valid: false, error: "Missing callback_query from" };
    }
    const from = cb.from as Record<string, unknown>;
    if (
      typeof from.id !== "number" ||
      !Number.isInteger(from.id) ||
      !Number.isSafeInteger(from.id) ||
      from.id < 1
    ) {
      return { valid: false, error: "Malformed callback_query from.id" };
    }
    if (
      typeof from.first_name !== "string" ||
      from.first_name.trim().length === 0
    ) {
      return { valid: false, error: "Missing or empty callback_query from.first_name" };
    }
    if (from.is_bot !== undefined && typeof from.is_bot !== "boolean") {
      return { valid: false, error: "Malformed callback_query from.is_bot" };
    }
    if (from.last_name !== undefined && typeof from.last_name !== "string") {
      return { valid: false, error: "Malformed callback_query from.last_name" };
    }
    if (from.username !== undefined && typeof from.username !== "string") {
      return { valid: false, error: "Malformed callback_query from.username" };
    }
    if (from.language_code !== undefined && typeof from.language_code !== "string") {
      return { valid: false, error: "Malformed callback_query from.language_code" };
    }

    // Callbacks without a message (e.g. inline-mode queries) are unsupported
    if (cb.message === undefined || cb.message === null) {
      return { valid: true, ignored: true };
    }

    if (typeof cb.message !== "object" || cb.message === null) {
      return { valid: false, error: "Malformed callback message" };
    }
    const cbMsg = cb.message as Record<string, unknown>;
    if (
      typeof cbMsg.message_id !== "number" ||
      !Number.isInteger(cbMsg.message_id) ||
      !Number.isSafeInteger(cbMsg.message_id) ||
      cbMsg.message_id < 1
    ) {
      return { valid: false, error: "Malformed callback message_id" };
    }
    if (typeof cbMsg.chat !== "object" || cbMsg.chat === null) {
      return { valid: false, error: "Missing callback chat" };
    }
    const cbChat = cbMsg.chat as Record<string, unknown>;
    if (
      typeof cbChat.id !== "number" ||
      !Number.isInteger(cbChat.id) ||
      !Number.isSafeInteger(cbChat.id) ||
      typeof cbChat.type !== "string"
    ) {
      return { valid: false, error: "Malformed callback chat fields" };
    }

    if (cbChat.type !== "private") {
      return { valid: true, ignored: true };
    }

    // data and grammar validation BEFORE claim/customer effects
    if (typeof cb.data !== "string") {
      return { valid: false, error: "Missing callback_query data" };
    }
    const byteLen = Buffer.byteLength(cb.data, "utf8");
    if (byteLen < 1 || byteLen > 64) {
      return { valid: false, error: "Invalid callback_data byte length" };
    }

    const parsedToken = parseToken(cb.data);
    if (parsedToken.type === "unknown") {
      return { valid: false, error: "Unrecognized callback token grammar" };
    }

    return {
      valid: true,
      ignored: false,
      data: {
        updateType: "callback_query",
        update: obj as unknown as TelegramUpdate,
        callbackQuery: cb as unknown as TelegramCallbackQuery,
        parsedToken,
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

  // 4. Runtime validation of update shape & callback grammar BEFORE any DB writes
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

  const validatedData = validation.data;
  const update = validatedData.update;
  const updateType = validatedData.updateType;

  // 5. Establish execution deadline consistent with the 30s lease
  const budgetMs = options?.executionBudgetMs ?? DEFAULT_EXECUTION_BUDGET_MS;
  const deadline =
    options?.deadline ?? new StandardExecutionDeadline(budgetMs, options?.now);

  let attemptId: string | undefined;
  let db: Database | undefined;

  // 6. Complete error boundary protecting DB acquisition, claiming, dispatch, and completion
  try {
    db = options?.db ?? getDb();
    const transport =
      options?.transport ??
      createFetchTelegramTransport(botToken, { deadline });

    if (options?.transport && "deadline" in options.transport) {
      (options.transport as { deadline?: ExecutionDeadline }).deadline = deadline;
    }

    deadline.checkOrThrow();

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

    // Incomplete competing work returns retryable status (HTTP 429) so Telegram will retry
    // if the current owner fails or abandons, while preserving zero duplicate execution
    if (claim.status === "in_flight") {
      return new Response(
        JSON.stringify({ error: "Update is currently in flight" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        },
      );
    }

    attemptId = claim.attemptId;
    deadline.checkOrThrow();

    // 7. Dispatch business logic
    if (validatedData.updateType === "message") {
      const msg = validatedData.message;
      const text = msg.text?.trim() ?? "";
      if (START_COMMAND_REGEX.test(text)) {
        await handleStartCommand(db, transport, msg);
      } else {
        // Helpful plain-text guidance for non-start text messages
        const guideRes = await transport.sendMessage({
          chatId: msg.chat.id,
          text: "To browse our catalog, please send /start",
        });
        if (!guideRes.ok) {
          throw new TelegramTransportError(
            guideRes.error ?? "Failed to deliver guidance message",
            {
              errorKind: guideRes.errorKind ?? "api_error",
              retryAfterSeconds: guideRes.retryAfterSeconds,
            },
          );
        }
      }
    } else {
      await handleCallbackQuery(
        db,
        transport,
        validatedData.callbackQuery,
        validatedData.parsedToken,
      );
    }

    deadline.checkOrThrow();

    // 8. Mark attempt successfully processed and enforce completion fencing
    const marked = await markTelegramUpdateProcessed(db, {
      updateId: update.update_id,
      attemptId,
    });

    if (!marked) {
      throw new FencingRejectedError(
        "Attempt lost ownership before completion; completion rejected",
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const diagnostic = classifyErrorToSafeDiagnostic(err);
    const safeDiagnosticString = formatSafeDiagnostic(diagnostic);

    // 9. Safe failure bookkeeping: persist allowlisted safe diagnostic (never raw errors or SQL)
    if (db && attemptId) {
      try {
        await markTelegramUpdateFailed(db, {
          updateId: update.update_id,
          attemptId,
          errorMessage: safeDiagnosticString,
        });
      } catch {
        // Failure bookkeeping must never mask the original dispatch error
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let status = 500;
    let errorMessage = "Internal server error";

    if (diagnostic.category === "rate_limited" && diagnostic.retryAfterSeconds !== undefined) {
      status = 429;
      headers["Retry-After"] = String(diagnostic.retryAfterSeconds);
      errorMessage = "Too Many Requests";
    } else if (diagnostic.category === "budget_exceeded") {
      status = 503;
      headers["Retry-After"] = "5";
      errorMessage = "Service Unavailable";
    }

    // Public response uses fixed sanitized message
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status,
        headers,
      },
    );
  }
}
