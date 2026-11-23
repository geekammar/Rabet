"use server";

import { and, eq, sql } from "drizzle-orm";
import { store, telegramConnection } from "@/db/schema";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  createTelegramBotApiClient,
} from "@/lib/telegram/manager-api";
import {
  readManagerBotConfig,
  resolveTrustedAppOrigin,
} from "@/lib/telegram/manager-config";
import {
  confirmTelegramConnection,
  ensureTelegramLinkAttempt,
  merchantManagerDeepLink,
  recoverManagedTelegramCandidate,
} from "@/lib/telegram/manager-provisioning";
import { createFetchTelegramTransport } from "@/lib/telegram/transport";

export type MerchantTelegramActionResult =
  | { ok: true; deepLink?: string }
  | {
      ok: false;
      error:
        | "UNAVAILABLE"
        | "DENIED"
        | "NOT_FOUND"
        | "EXPIRED"
        | "CONFLICT"
        | "RETRYABLE"
        | "REVIEW"
        | "BOT_REQUIRED"
        | "RECOVERY_FAILED"
        | "OPERATION_FAILED";
    };

const connectionIdSchema = z.string().uuid();

const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Logs only an allowlisted phase and error code. Raw messages, SQL parameters,
 * keys, tokens and nonces never reach the log stream.
 */
function safeStartDiagnostic(
  phase: string,
  error: unknown,
): { phase: string; category: string } {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    SAFE_ERROR_CODE_PATTERN.test((error as { code: string }).code)
  ) {
    return { phase, category: (error as { code: string }).code };
  }

  if (
    error instanceof Error &&
    SAFE_ERROR_CODE_PATTERN.test(error.name)
  ) {
    return { phase, category: error.name };
  }

  return { phase, category: "unknown" };
}

/**
 * Starts a new server-owned link attempt for the signed-in merchant's store.
 *
 * The manager bot username is read from Telegram (`getMe`) and stored on the
 * attempt. The browser receives neither the nonce's digest nor any credential;
 * the setup page re-reads the pending state from the server.
 */
export async function startMerchantTelegramConnection(): Promise<MerchantTelegramActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  let managerConfig;
  let managerUsername: string | null = null;

  try {
    managerConfig = readManagerBotConfig();
    const api = createTelegramBotApiClient(managerConfig.token);
    const me = await api.getMe();

    if (
      me.ok &&
      me.result.is_bot === true &&
      typeof me.result.username === "string" &&
      me.result.username.length > 0
    ) {
      managerUsername = me.result.username;
    }
  } catch (error) {
    console.error(
      "[merchant-telegram] connect start failed",
      safeStartDiagnostic("manager_config", error),
    );
    return { ok: false, error: "UNAVAILABLE" };
  }

  if (!managerUsername) {
    console.error("[merchant-telegram] connect start failed", {
      phase: "manager_identity",
      category: "unverified",
    });
    return { ok: false, error: "UNAVAILABLE" };
  }

  try {
    const ensured = await ensureTelegramLinkAttempt(getTransactionDb(), {
      storeId: access.store.id,
      merchantUserId: access.userId,
      managerBotUsername: managerUsername,
    });

    revalidatePath("/app/setup");

    if (ensured.status === "created" || ensured.status === "reused") {
      return {
        ok: true,
        deepLink: merchantManagerDeepLink(managerUsername, ensured.nonce),
      };
    }

    if (
      ensured.status === "candidate" ||
      ensured.status === "preparing" ||
      ensured.status === "recoverable" ||
      ensured.status === "connected"
    ) {
      return { ok: true };
    }

    return { ok: false, error: "CONFLICT" };
  } catch (error) {
    console.error(
      "[merchant-telegram] connect start failed",
      safeStartDiagnostic("attempt_write", error),
    );

    return { ok: false, error: "OPERATION_FAILED" };
  }
}

const recoveryInputSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    attemptId: z.string().uuid().optional(),
  })
  .refine(
    (value) => Boolean(value.connectionId || value.attemptId),
    "A recovery target is required.",
  );

/**
 * Re-opens a bot that Telegram already confirmed for this store. The client
 * cannot choose a store or a bot; it only identifies the server-derived
 * evidence row. Telegram is re-queried for the token and bot identity before
 * the candidate is offered for confirmation.
 */
export async function recoverMerchantTelegramConnection(
  input: unknown,
): Promise<MerchantTelegramActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const parsed = recoveryInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: "NOT_FOUND" };
  }

  let config;

  try {
    config = readManagerBotConfig();
  } catch (error) {
    console.error(
      "[merchant-telegram] recovery failed",
      safeStartDiagnostic("manager_config", error),
    );
    return { ok: false, error: "UNAVAILABLE" };
  }

  let origin: string;

  try {
    origin = resolveTrustedAppOrigin();
  } catch (error) {
    console.error(
      "[merchant-telegram] recovery failed",
      safeStartDiagnostic("manager_origin", error),
    );
    return { ok: false, error: "UNAVAILABLE" };
  }

  try {
    const result = await recoverManagedTelegramCandidate(
      getTransactionDb(),
      {
        storeId: access.store.id,
        merchantUserId: access.userId,
        connectionId: parsed.data.connectionId ?? null,
        attemptId: parsed.data.attemptId ?? null,
      },
      {
        managerApi: createTelegramBotApiClient(config.token),
        transport: createFetchTelegramTransport(config.token),
        webhookOrigin: origin,
      },
    );

    revalidatePath("/app/setup");

    if (result.status === "recovered" || result.status === "already_candidate") {
      return { ok: true };
    }

    if (result.status === "retryable") {
      return { ok: false, error: "RETRYABLE" };
    }

    if (result.status === "bot_bound_elsewhere") {
      return { ok: false, error: "CONFLICT" };
    }

    return {
      ok: false,
      error: result.status === "not_found" ? "NOT_FOUND" : "RECOVERY_FAILED",
    };
  } catch (error) {
    console.error(
      "[merchant-telegram] recovery failed",
      safeStartDiagnostic("recovery_write", error),
    );
    return { ok: false, error: "RECOVERY_FAILED" };
  }
}

/**
 * Finalizes a verified connection only after the signed-in merchant confirms
 * the bot shown by the server. The submitted value is just the public
 * connection id; the store, membership and merchant identity come from the
 * session.
 */
export async function confirmMerchantTelegramConnection(
  input: unknown,
): Promise<MerchantTelegramActionResult> {
  if (!isMerchantAppEnabled()) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  const access = await getMerchantAccess();

  if (!access) {
    return { ok: false, error: "DENIED" };
  }

  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const submitted =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};

  const connectionId = connectionIdSchema.safeParse(submitted.connectionId);

  if (!connectionId.success) {
    return { ok: false, error: "NOT_FOUND" };
  }

  try {
    const result = await confirmTelegramConnection(getTransactionDb(), {
      storeId: access.store.id,
      merchantUserId: access.userId,
      connectionId: connectionId.data,
    });

    if (result.status === "ready" || result.status === "already_ready") {
      revalidatePath("/app/setup");
      return { ok: true };
    }

    if (result.status === "retryable") {
      revalidatePath("/app/setup");
      return { ok: false, error: "RETRYABLE" };
    }

    if (result.status === "review") {
      revalidatePath("/app/setup");
      return { ok: false, error: "REVIEW" };
    }

    revalidatePath("/app/setup");

    return {
      ok: false,
      error:
        result.status === "expired" || result.status === "superseded"
          ? "EXPIRED"
          : result.status === "conflict" ||
              result.status === "foreign_webhook" ||
              result.status === "bot_bound_elsewhere"
            ? "CONFLICT"
            : "NOT_FOUND",
    };
  } catch {
    return { ok: false, error: "OPERATION_FAILED" };
  }
}

/** Explicitly publishes the signed-in owner's onboarding store once its bot is ready. */
export async function publishMerchantTelegramStore(): Promise<MerchantTelegramActionResult> {
  const access = await getMerchantAccess();
  if (!access || access.readOnly) return { ok: false, error: "DENIED" };
  if (access.store.status === "active") return { ok: true };

  try {
    const [published] = await getTransactionDb()
      .update(store)
      .set({ status: "active" })
      .where(and(
        eq(store.id, access.store.id),
        eq(store.status, "onboarding"),
        sql`exists (
          select 1 from ${telegramConnection}
          where ${telegramConnection.storeId} = ${store.id}
            and ${telegramConnection.status} = 'ready'
        )`,
      ))
      .returning({ id: store.id });

    // A concurrent successful publish is reflected on the next render.
    revalidatePath("/app/setup");
    return published ? { ok: true } : { ok: false, error: "BOT_REQUIRED" };
  } catch {
    return { ok: false, error: "OPERATION_FAILED" };
  }
}
