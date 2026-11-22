import "server-only";

import type { TransactionDatabase } from "@/db/transaction-client";
import { getTransactionDb } from "@/db/transaction-client";
import {
  claimManagedTelegramUpdate,
  markManagedTelegramUpdateFailed,
  markManagedTelegramUpdateProcessed,
} from "./managed-updates";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
} from "./manager-api";
import {
  readManagerBotConfig,
  resolveTrustedAppOrigin,
} from "./manager-config";
import {
  handleManagedBotEvent,
  handleManagerStartMessage,
} from "./manager-provisioning";
import {
  classifyErrorToSafeDiagnostic,
  createFetchTelegramTransport,
  formatSafeDiagnostic,
} from "./transport";
import type { TelegramMessage, TelegramTransport } from "./types";
import { safeCompareSecret } from "./webhook";

/**
 * Manager-bot webhook.
 *
 * Unlike the legacy customer webhook this endpoint never touches the legacy
 * store or `telegram_update` table. It authenticates the operator-owned
 * manager bot secret, deduplicates under the manager bot's own id, and handles
 * only `/start <nonce>` and `managed_bot` updates.
 */

export interface ManagerWebhookOptions {
  db?: TransactionDatabase;
  transport?: TelegramTransport;
  managerApi?: TelegramBotApiClient;
  managerBotId?: number;
  webhookOrigin?: string;
  managerToken?: string;
  managerWebhookSecret?: string;
  now?: Date;
  createBotApi?: (token: string) => TelegramBotApiClient;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ValidatedManagerUpdate =
  | { type: "message"; updateId: number; message: TelegramMessage }
  | {
      type: "managed_bot";
      updateId: number;
      creatorUserId: number;
      botId: number;
      botUsername: string | null;
      botName: string | null;
    }
  | { type: "ignored"; updateId: number };

function validateManagerUpdate(raw: unknown): ValidatedManagerUpdate | null {
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const updateId = obj.update_id;

  if (
    typeof updateId !== "number" ||
    !Number.isSafeInteger(updateId) ||
    updateId < 1
  ) {
    return null;
  }

  if (obj.message !== undefined && obj.message !== null) {
    const message = obj.message as Record<string, unknown>;
    const chat = message.chat as Record<string, unknown> | undefined;
    const from = message.from as Record<string, unknown> | undefined;

    if (
      typeof message.message_id !== "number" ||
      !Number.isSafeInteger(message.message_id) ||
      !chat ||
      typeof chat.id !== "number" ||
      typeof chat.type !== "string"
    ) {
      return null;
    }

    if (chat.type !== "private") {
      return { type: "ignored", updateId };
    }

    if (
      !from ||
      typeof from.id !== "number" ||
      !Number.isSafeInteger(from.id) ||
      from.id < 1
    ) {
      return null;
    }

    if (message.text !== undefined && typeof message.text !== "string") {
      return null;
    }

    return {
      type: "message",
      updateId,
      message: message as unknown as TelegramMessage,
    };
  }

  if (obj.managed_bot !== undefined && obj.managed_bot !== null) {
    const event = obj.managed_bot as Record<string, unknown>;
    const user = event.user as Record<string, unknown> | undefined;
    const bot = event.bot as Record<string, unknown> | undefined;

    if (
      !user ||
      typeof user.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      user.id < 1 ||
      !bot ||
      typeof bot.id !== "number" ||
      !Number.isSafeInteger(bot.id) ||
      bot.id < 1 ||
      bot.is_bot !== true
    ) {
      return null;
    }

    return {
      type: "managed_bot",
      updateId,
      creatorUserId: user.id,
      botId: bot.id,
      botUsername:
        typeof bot.username === "string" ? bot.username : null,
      botName:
        typeof bot.first_name === "string" ? bot.first_name : null,
    };
  }

  return { type: "ignored", updateId };
}

export async function handleManagerTelegramWebhookRequest(
  req: Request,
  options?: ManagerWebhookOptions,
): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let token: string;
  let webhookSecret: string;

  try {
    if (options?.managerToken && options.managerWebhookSecret) {
      token = options.managerToken;
      webhookSecret = options.managerWebhookSecret;
    } else {
      const config = readManagerBotConfig();
      token = config.token;
      webhookSecret = config.webhookSecret;
    }
  } catch {
    return json({ error: "Telegram manager webhook is not configured." }, 503);
  }

  const incomingSecret = req.headers.get(
    "x-telegram-bot-api-secret-token",
  );

  if (
    !incomingSecret ||
    !safeCompareSecret(incomingSecret, webhookSecret)
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }

  const update = validateManagerUpdate(rawBody);

  if (!update) {
    return json({ error: "Bad request" }, 400);
  }

  if (update.type === "ignored") {
    return json({ ok: true, ignored: true });
  }

  let db: TransactionDatabase;

  try {
    db = options?.db ?? getTransactionDb();
  } catch {
    return json({ error: "Service unavailable" }, 503);
  }

  const managerApi =
    options?.managerApi ??
    createTelegramBotApiClient(token);

  let managerBotId = options?.managerBotId;

  if (managerBotId === undefined) {
    const me = await managerApi.getMe();

    if (!me.ok || !Number.isSafeInteger(me.result.id)) {
      return json({ error: "Service unavailable" }, 503);
    }

    managerBotId = me.result.id;
  }

  let attemptToken: string | undefined;

  try {
    const claim = await claimManagedTelegramUpdate(db, {
      botId: managerBotId,
      updateId: update.updateId,
      updateType: update.type,
    });

    if (claim.status === "already_processed") {
      return json({ ok: true, status: "already_processed" });
    }

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

    attemptToken = claim.attemptToken;

    const transport =
      options?.transport ??
      createFetchTelegramTransport(token);

    if (update.type === "message") {
      await handleManagerStartMessage(db, transport, update.message, {
        now: options?.now,
      });
    } else {
      const origin =
        options?.webhookOrigin ?? resolveTrustedAppOrigin();

      await handleManagedBotEvent(
        db,
        {
          creatorUserId: update.creatorUserId,
          botId: update.botId,
          botUsername: update.botUsername,
          botName: update.botName,
        },
        {
          managerApi,
          createBotApi: options?.createBotApi,
          webhookOrigin: origin,
          now: options?.now,
        },
      );
    }

    const marked = await markManagedTelegramUpdateProcessed(db, {
      botId: managerBotId,
      updateId: update.updateId,
      attemptToken,
    });

    if (!marked) {
      throw new Error("Manager update completion was not accepted");
    }

    return json({ ok: true });
  } catch (error) {
    const diagnostic = classifyErrorToSafeDiagnostic(error);

    if (attemptToken) {
      try {
        await markManagedTelegramUpdateFailed(db, {
          botId: managerBotId,
          updateId: update.updateId,
          attemptToken,
          errorMessage: formatSafeDiagnostic(diagnostic),
        });
      } catch {
        // Keep the original error.
      }
    }

    if (
      diagnostic.category === "rate_limited" &&
      diagnostic.retryAfterSeconds !== undefined
    ) {
      return new Response(
        JSON.stringify({ error: "Too Many Requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(diagnostic.retryAfterSeconds),
          },
        },
      );
    }

    return json({ error: "Internal server error" }, 500);
  }
}
