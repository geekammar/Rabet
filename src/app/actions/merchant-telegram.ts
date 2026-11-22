"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getTransactionDb } from "@/db/transaction-client";
import { isMerchantAppEnabled } from "@/lib/auth/merchant-gate";
import { getMerchantAccess } from "@/lib/auth/merchant-session";
import {
  createTelegramBotApiClient,
} from "@/lib/telegram/manager-api";
import { readManagerBotConfig } from "@/lib/telegram/manager-config";
import {
  confirmTelegramConnection,
  createTelegramLinkAttempt,
} from "@/lib/telegram/manager-provisioning";

export type MerchantTelegramActionResult =
  | { ok: true }
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
        | "OPERATION_FAILED";
    };

const connectionIdSchema = z.string().uuid();

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
  } catch {
    return { ok: false, error: "UNAVAILABLE" };
  }

  if (!managerUsername) {
    return { ok: false, error: "UNAVAILABLE" };
  }

  try {
    await createTelegramLinkAttempt(getTransactionDb(), {
      storeId: access.store.id,
      merchantUserId: access.userId,
      managerBotUsername: managerUsername,
    });

    revalidatePath("/app/setup");
    return { ok: true };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "CONFLICT"
    ) {
      return { ok: false, error: "CONFLICT" };
    }

    return { ok: false, error: "OPERATION_FAILED" };
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
