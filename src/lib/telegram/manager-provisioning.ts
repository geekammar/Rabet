import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  store,
  telegramConnection,
  telegramLinkAttempt,
} from "@/db/schema";
import {
  getTransactionDb,
  type TransactionDatabase as ApplicationTransactionDatabase,
} from "@/db/transaction-client";
import type { StoreScope } from "@/lib/data/store-scope";
import { mapDatabaseError, RabetDataError } from "@/lib/data/errors";
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
  generateLinkNonce,
  generateWebhookSecret,
  hashLinkNonce,
  hashWebhookSecret,
} from "./connection-secrets";
import {
  buildManagedWebhookUrl,
  suggestedBotUsername,
} from "./manager-config";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
} from "./manager-api";
import { sanitizeTelegramError } from "./transport";
import type { TelegramMessage, TelegramTransport } from "./types";

export const TELEGRAM_LINK_ATTEMPT_TTL_MS = 15 * 60 * 1000;

type AttemptTransaction = Parameters<
  Parameters<TransactionDatabase["transaction"]>[0]
>[0];

const ACTIVE_ATTEMPT_STATUSES = [
  "pending",
  "provisioning",
  "awaiting_confirmation",
] as const;

export type StartedLinkAttempt = {
  attemptId: string;
  nonce: string;
  expiresAt: Date;
};

function advisoryLockKey(prefix: string, value: string): string {
  return `${prefix}:${value}`;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return false;
}

/**
 * Creates the single active server-owned link attempt for a store.
 *
 * A new attempt revokes the previous pending attempt for the same store. The
 * transaction and advisory lock make concurrent clicks deterministic; partial
 * unique indexes are the final database boundary.
 */
export async function createTelegramLinkAttempt(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    managerBotUsername: string;
    now?: Date;
  },
): Promise<StartedLinkAttempt> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS);
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  const encryptedNonce = encryptConnectionSecret(nonce);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          input.storeId,
        )}))`,
      );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, now),
          ),
        );

      // A new attempt supersedes any provisioned-but-unconfirmed connection.
      // Its old webhook becomes inert because the connection is no longer
      // ready; the bot is not silently attached to the new attempt.
      await tx
        .update(telegramConnection)
        .set({ status: "revoked" })
        .where(
          and(
            eq(telegramConnection.storeId, input.storeId),
            inArray(telegramConnection.status, [
              "provisioning",
              "awaiting_confirmation",
            ]),
          ),
        );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "cancelled", failureCode: "superseded" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        );

      const [attempt] = await tx
        .insert(telegramLinkAttempt)
        .values({
          storeId: input.storeId,
          merchantUserId: input.merchantUserId,
          managerBotUsername: input.managerBotUsername,
          nonceDigest,
          nonceCiphertext: encryptedNonce.ciphertext,
          nonceKeyId: encryptedNonce.keyId,
          status: "pending",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: telegramLinkAttempt.id });

      return { attemptId: attempt.id, nonce, expiresAt };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RabetDataError(
        "CONFLICT",
        "Another Telegram connection attempt is already active.",
        { cause: error },
      );
    }

    throw mapDatabaseError(error);
  }
}

export type LinkAttemptLookup = {
  id: string;
  storeId: string;
  merchantUserId: string;
  managerBotUsername: string;
  status: string;
  telegramUserId: number | null;
  telegramBotId: number | null;
  expiresAt: Date;
  storeName: string;
  storeSlug: string;
};

async function findAttemptByNonce(
  tx: AttemptTransaction,
  nonceDigest: string,
): Promise<LinkAttemptLookup | null> {
  const rows = await tx
    .select({
      id: telegramLinkAttempt.id,
      storeId: telegramLinkAttempt.storeId,
      merchantUserId: telegramLinkAttempt.merchantUserId,
      managerBotUsername: telegramLinkAttempt.managerBotUsername,
      status: telegramLinkAttempt.status,
      telegramUserId: telegramLinkAttempt.telegramUserId,
      telegramBotId: telegramLinkAttempt.telegramBotId,
      expiresAt: telegramLinkAttempt.expiresAt,
      storeName: store.name,
      storeSlug: store.slug,
    })
    .from(telegramLinkAttempt)
    .innerJoin(store, eq(store.id, telegramLinkAttempt.storeId))
    .where(eq(telegramLinkAttempt.nonceDigest, nonceDigest))
    .limit(1);

  return rows[0] ?? null;
}

export type BindAttemptResult =
  | { status: "bound" | "already_bound" | "mismatch"; attempt: LinkAttemptLookup }
  | { status: "not_found" | "expired" | "conflict"; attempt: LinkAttemptLookup | null };

/**
 * Binds the Telegram account that opened the manager-bot deep link to exactly
 * one pending attempt. The Telegram user id comes from the authenticated
 * manager-bot update, never from a URL. Replaying the nonce from the same
 * account is idempotent; a different account cannot take over the attempt.
 */
export async function bindLinkAttemptToTelegramUser(
  db: TransactionDatabase,
  input: {
    nonce: string;
    telegramUserId: number;
    now?: Date;
  },
): Promise<BindAttemptResult> {
  const now = input.now ?? new Date();
  const digest = hashLinkNonce(input.nonce);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-nonce",
          digest,
        )}))`,
      );

      const attempt = await findAttemptByNonce(tx, digest);

      if (!attempt) return { status: "not_found", attempt: null };

      if (
        !(ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(
          attempt.status,
        )
      ) {
        return { status: "expired", attempt };
      }

      if (attempt.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(
            and(
              eq(telegramLinkAttempt.id, attempt.id),
              inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            ),
          );
        return { status: "expired", attempt };
      }

      if (attempt.telegramUserId !== null) {
        return {
          status:
            attempt.telegramUserId === input.telegramUserId
              ? "already_bound"
              : "mismatch",
          attempt,
        };
      }

      const [updated] = await tx
        .update(telegramLinkAttempt)
        .set({
          telegramUserId: input.telegramUserId,
          boundAt: now,
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, attempt.id),
            eq(telegramLinkAttempt.status, "pending"),
            sql`${telegramLinkAttempt.telegramUserId} IS NULL`,
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!updated) {
        return { status: "conflict", attempt };
      }

      return {
        status: "bound",
        attempt: { ...attempt, telegramUserId: input.telegramUserId },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "conflict", attempt: null };
    }
    throw mapDatabaseError(error);
  }
}

function creationLink(attempt: LinkAttemptLookup): string {
  const username = suggestedBotUsername(attempt.storeSlug);
  return `https://t.me/newbot/${encodeURIComponent(
    attempt.managerBotUsername,
  )}/${encodeURIComponent(username)}?name=${encodeURIComponent(
    `${attempt.storeName} store`,
  )}`;
}

/**
 * Handles an authenticated `/start <nonce>` from the manager bot.
 *
 * The nonce only selects the pending attempt; it is never treated as a store
 * authorization. The manager bot replies with Telegram's documented creation
 * link for that exact chat.
 */
export async function handleManagerStartMessage(
  db: TransactionDatabase,
  transport: TelegramTransport,
  message: TelegramMessage,
  options?: { now?: Date },
): Promise<void> {
  const from = message.from;
  const text = typeof message.text === "string" ? message.text.trim() : "";

  if (!from || !text.startsWith("/start")) {
    return;
  }

  const nonce = text.slice("/start".length).trim();

  if (nonce.length === 0) {
    const result = await transport.sendMessage({
      chatId: message.chat.id,
      text:
        "Open the Rabet merchant dashboard and choose Connect Telegram to start a secure connection.",
    });
    if (!result.ok) {
      throw new Error(sanitizeTelegramError(result.error ?? "Send failed"));
    }
    return;
  }

  const bound = await bindLinkAttemptToTelegramUser(db, {
    nonce,
    telegramUserId: from.id,
    now: options?.now,
  });

  if (bound.status === "not_found" || bound.status === "expired") {
    const result = await transport.sendMessage({
      chatId: message.chat.id,
      text:
        "This connection link is no longer valid. Return to the Rabet merchant dashboard and start a new connection.",
    });
    if (!result.ok) {
      throw new Error(sanitizeTelegramError(result.error ?? "Send failed"));
    }
    return;
  }

  if (bound.status === "mismatch" || bound.status === "conflict") {
    const result = await transport.sendMessage({
      chatId: message.chat.id,
      text:
        "This connection link was already opened by another Telegram account. Return to the Rabet merchant dashboard and start a new connection.",
    });
    if (!result.ok) {
      throw new Error(sanitizeTelegramError(result.error ?? "Send failed"));
    }
    return;
  }

  if (!bound.attempt) {
    return;
  }

  const result = await transport.sendMessage({
    chatId: message.chat.id,
    text:
      "Create the Telegram bot that will serve your store. " +
      "Telegram will show the suggested name and username; you may edit both.\n\n" +
      "After you confirm, return to the Rabet dashboard to verify and approve the connection.",
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: "Create store bot",
            url: creationLink(bound.attempt),
          },
        ],
      ],
    },
  });

  if (!result.ok) {
    throw new Error(sanitizeTelegramError(result.error ?? "Send failed"));
  }
}

export type ManagedBotEventInput = {
  creatorUserId: number;
  botId: number;
  botUsername: string | null;
  botName: string | null;
};

export type ProvisioningDependencies = {
  managerApi: TelegramBotApiClient;
  createBotApi?: (token: string) => TelegramBotApiClient;
  webhookOrigin: string;
  now?: Date;
};

type CorrelationOutcome =
  | { status: "already_provisioned"; attemptId: string; connectionId: string | null }
  | { status: "in_progress" }
  | { status: "unmatched" }
  | { status: "expired" }
  | { status: "ambiguous" }
  | { status: "bot_bound_elsewhere" }
  | { status: "superseded" };

export type ProvisionResult =
  | {
      status: "awaiting_confirmation";
      attemptId: string;
      connectionId: string;
      botUsername: string;
    }
  | { status: "already_provisioned"; attemptId: string; connectionId: string | null }
  | { status: "in_progress" }
  | { status: "unmatched" }
  | { status: "expired" }
  | { status: "ambiguous" }
  | { status: "bot_bound_elsewhere" }
  | { status: "superseded" }
  | { status: "retryable"; reason: string }
  | { status: "failed"; reason: string };

type AttemptCandidateClaim = {
  attemptId: string;
  storeId: string;
  managerBotUsername: string;
};

async function failActiveAttempt(
  tx: AttemptTransaction,
  attemptId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await tx
    .update(telegramLinkAttempt)
    .set({ status: "failed", failureCode: reason })
    .where(
      and(
        eq(telegramLinkAttempt.id, attemptId),
        inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
        gt(telegramLinkAttempt.expiresAt, now),
      ),
    );
}

async function retryableCandidateFailure(
  db: TransactionDatabase,
  attemptId: string,
  reason: string,
  now: Date,
): Promise<ProvisionResult> {
  try {
    await db
      .update(telegramLinkAttempt)
      .set({ status: "pending", failureCode: reason })
      .where(
        and(
          eq(telegramLinkAttempt.id, attemptId),
          eq(telegramLinkAttempt.status, "provisioning"),
          gt(telegramLinkAttempt.expiresAt, now),
        ),
      );
  } catch {
    // Preserve the original Telegram/database failure.
  }

  return { status: "retryable", reason };
}

/**
 * Correlates one manager-bot `managed_bot` event to at most one pending
 * attempt and prepares a candidate connection for dashboard confirmation.
 *
 * This path deliberately performs **no webhook mutation**. It fetches the
 * managed bot token, verifies the bot identity, encrypts the token and stores
 * an `awaiting_confirmation` candidate. The buyer webhook is registered only
 * after the signed-in merchant confirms, in `confirmTelegramConnection`.
 */
export async function handleManagedBotEvent(
  db: TransactionDatabase,
  event: ManagedBotEventInput,
  deps: ProvisioningDependencies,
): Promise<ProvisionResult> {
  const now = deps.now ?? new Date();

  if (
    !Number.isSafeInteger(event.creatorUserId) ||
    event.creatorUserId <= 0 ||
    !Number.isSafeInteger(event.botId) ||
    event.botId <= 0
  ) {
    return { status: "unmatched" };
  }

  let claimed: AttemptCandidateClaim | CorrelationOutcome | null = null;

  try {
    claimed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-managed-bot",
          String(event.creatorUserId),
        )}))`,
      );

      const active = await tx
        .select({
          id: telegramLinkAttempt.id,
          storeId: telegramLinkAttempt.storeId,
          managerBotUsername: telegramLinkAttempt.managerBotUsername,
          status: telegramLinkAttempt.status,
          telegramBotId: telegramLinkAttempt.telegramBotId,
          connectionId: telegramLinkAttempt.connectionId,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.telegramUserId, event.creatorUserId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt));

      if (active.length === 0) {
        const [completed] = await tx
          .select({
            id: telegramLinkAttempt.id,
            storeId: telegramLinkAttempt.storeId,
            connectionId: telegramLinkAttempt.connectionId,
          })
          .from(telegramLinkAttempt)
          .where(
            and(
              eq(telegramLinkAttempt.telegramUserId, event.creatorUserId),
              eq(telegramLinkAttempt.telegramBotId, event.botId),
            ),
          )
          .orderBy(desc(telegramLinkAttempt.createdAt))
          .limit(1);

        if (completed?.connectionId) {
          const [existingConnection] = await tx
            .select({ id: telegramConnection.id, storeId: telegramConnection.storeId })
            .from(telegramConnection)
            .where(eq(telegramConnection.id, completed.connectionId))
            .limit(1);

          if (
            existingConnection &&
            existingConnection.storeId === completed.storeId
          ) {
            return {
              status: "already_provisioned",
              attemptId: completed.id,
              connectionId: completed.connectionId,
            } as const;
          }
        }

        return { status: "unmatched" } as const;
      }

      if (active.length > 1) {
        for (const attempt of active) {
          await failActiveAttempt(tx, attempt.id, "ambiguous_event", now);
        }
        return { status: "ambiguous" } as const;
      }

      const attempt = active[0];

      if (attempt.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(eq(telegramLinkAttempt.id, attempt.id));
        return { status: "expired" } as const;
      }

      if (
        attempt.telegramBotId !== null &&
        attempt.telegramBotId !== event.botId
      ) {
        await failActiveAttempt(
          tx,
          attempt.id,
          "conflicting_bot_event",
          now,
        );
        return { status: "ambiguous" } as const;
      }

      if (attempt.telegramBotId === event.botId && attempt.connectionId) {
        return {
          status: "already_provisioned",
          attemptId: attempt.id,
          connectionId: attempt.connectionId,
        } as const;
      }

      const [boundElsewhere] = await tx
        .select({ id: telegramConnection.id, storeId: telegramConnection.storeId })
        .from(telegramConnection)
        .where(eq(telegramConnection.botId, event.botId))
        .limit(1);

      if (boundElsewhere && boundElsewhere.storeId !== attempt.storeId) {
        await failActiveAttempt(
          tx,
          attempt.id,
          "bot_bound_elsewhere",
          now,
        );
        return { status: "bot_bound_elsewhere" } as const;
      }

      if (attempt.status === "provisioning") {
        return { status: "in_progress" } as const;
      }

      const [claimedAttempt] = await tx
        .update(telegramLinkAttempt)
        .set({
          status: "provisioning",
          telegramBotId: event.botId,
          telegramBotUsername: event.botUsername,
          telegramBotName: event.botName,
          failureCode: null,
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, attempt.id),
            inArray(telegramLinkAttempt.status, [
              "pending",
              "awaiting_confirmation",
            ]),
            gt(telegramLinkAttempt.expiresAt, now),
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!claimedAttempt) {
        return { status: "in_progress" } as const;
      }

      return {
        attemptId: attempt.id,
        storeId: attempt.storeId,
        managerBotUsername: attempt.managerBotUsername,
      };
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (claimed === null) return { status: "in_progress" };
  if ("status" in claimed) return claimed;

  const { attemptId } = claimed;

  const tokenResult = await deps.managerApi.getManagedBotToken(event.botId);
  if (!tokenResult.ok) {
    return retryableCandidateFailure(
      db,
      attemptId,
      "token_fetch_failed",
      now,
    );
  }

  const token = tokenResult.result;
  if (typeof token !== "string" || token.trim().length === 0) {
    return retryableCandidateFailure(
      db,
      attemptId,
      "token_fetch_failed",
      now,
    );
  }

  let managedApi: TelegramBotApiClient;

  try {
    managedApi =
      deps.createBotApi?.(token) ??
      createTelegramBotApiClient(token);
  } catch {
    return retryableCandidateFailure(
      db,
      attemptId,
      "api_unavailable",
      now,
    );
  }

  const me = await managedApi.getMe();
  if (
    !me.ok ||
    me.result.id !== event.botId ||
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    me.result.username.length === 0
  ) {
    return retryableCandidateFailure(
      db,
      attemptId,
      "verification_failed",
      now,
    );
  }

  const verifiedUsername = me.result.username;
  const verifiedName =
    typeof me.result.first_name === "string" ? me.result.first_name : null;

  let encryptedToken: { ciphertext: string; keyId: string };

  try {
    encryptedToken = encryptConnectionSecret(token);
  } catch {
    return retryableCandidateFailure(
      db,
      attemptId,
      "secret_storage_failed",
      now,
    );
  }

  type PersistResult =
    | {
        status: "saved";
        connectionId: string;
        botUsername: string;
      }
    | { status: "superseded" | "expired" | "bot_bound_elsewhere" };

  let persisted: PersistResult;

  try {
    persisted = await db.transaction(async (tx): Promise<PersistResult> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-connection-store",
          claimed.storeId,
        )}))`,
      );

      const [currentAttempt] = await tx
        .select({
          id: telegramLinkAttempt.id,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.id, attemptId),
            eq(telegramLinkAttempt.status, "provisioning"),
          ),
        )
        .limit(1);

      if (!currentAttempt) {
        return { status: "superseded" } as const;
      }

      if (currentAttempt.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(eq(telegramLinkAttempt.id, attemptId));
        return { status: "expired" } as const;
      }

      const [existingForBot] = await tx
        .select({
          id: telegramConnection.id,
          storeId: telegramConnection.storeId,
          webhookUrl: telegramConnection.webhookUrl,
        })
        .from(telegramConnection)
        .where(eq(telegramConnection.botId, event.botId))
        .limit(1);

      if (existingForBot && existingForBot.storeId !== claimed.storeId) {
        await failActiveAttempt(
          tx,
          attemptId,
          "bot_bound_elsewhere",
          now,
        );
        return { status: "bot_bound_elsewhere" } as const;
      }

      let connectionId: string;

      if (existingForBot) {
        connectionId = existingForBot.id;

        await tx
          .update(telegramConnection)
          .set({
            botUsername: verifiedUsername,
            botName: verifiedName,
            tokenCiphertext: encryptedToken.ciphertext,
            tokenKeyId: encryptedToken.keyId,
            webhookSecretHash: hashWebhookSecret(generateWebhookSecret()),
            status: "awaiting_confirmation",
            verifiedAt: now,
          })
          .where(eq(telegramConnection.id, existingForBot.id));
      } else {
        connectionId = crypto.randomUUID();
        const baseWebhookUrl = buildManagedWebhookUrl(
          deps.webhookOrigin,
          connectionId,
        );

        await tx.insert(telegramConnection).values({
          id: connectionId,
          storeId: claimed.storeId,
          botId: event.botId,
          botUsername: verifiedUsername,
          botName: verifiedName,
          tokenCiphertext: encryptedToken.ciphertext,
          tokenKeyId: encryptedToken.keyId,
          webhookSecretHash: hashWebhookSecret(generateWebhookSecret()),
          webhookUrl: baseWebhookUrl,
          status: "awaiting_confirmation",
          verifiedAt: now,
        });
      }

      const [updatedAttempt] = await tx
        .update(telegramLinkAttempt)
        .set({
          status: "awaiting_confirmation",
          connectionId,
          telegramBotUsername: verifiedUsername,
          telegramBotName: verifiedName,
          failureCode: null,
          verifiedAt: now,
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, attemptId),
            eq(telegramLinkAttempt.status, "provisioning"),
            gt(telegramLinkAttempt.expiresAt, now),
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!updatedAttempt) {
        throw new RabetDataError(
          "CONFLICT",
          "The link attempt changed while preparing the candidate.",
        );
      }

      return {
        status: "saved",
        connectionId,
        botUsername: verifiedUsername,
      } as const;
    });
  } catch (error) {
    if (
      error instanceof RabetDataError &&
      error.code === "CONFLICT"
    ) {
      return { status: "superseded" };
    }

    if (isUniqueViolation(error)) {
      try {
        await db
          .update(telegramLinkAttempt)
          .set({ status: "failed", failureCode: "connection_conflict" })
          .where(
            and(
              eq(telegramLinkAttempt.id, attemptId),
              inArray(telegramLinkAttempt.status, [
                ...ACTIVE_ATTEMPT_STATUSES,
              ]),
            ),
          );
      } catch {
        // Preserve the original conflict.
      }

      return { status: "failed", reason: "connection_conflict" };
    }

    return retryableCandidateFailure(
      db,
      attemptId,
      "connection_persist_failed",
      now,
    );
  }

  if (persisted.status !== "saved") return persisted;

  return {
    status: "awaiting_confirmation",
    attemptId,
    connectionId: persisted.connectionId,
    botUsername: persisted.botUsername,
  };
}

export type ActivationDependencies = {
  createBotApi?: (token: string) => TelegramBotApiClient;
  now?: Date;
};

export type ConfirmConnectionResult =
  | { status: "ready"; connectionId: string; botUsername: string }
  | { status: "already_ready"; connectionId: string; botUsername: string }
  | {
      status: "retryable";
      connectionId: string;
      botUsername: string;
      reason: string;
    }
  | {
      status:
        | "not_found"
        | "expired"
        | "superseded"
        | "conflict"
        | "foreign_webhook"
        | "bot_bound_elsewhere";
    };

type ActivationClaim =
  | {
      status: "claimed";
      attemptId: string;
      connectionId: string;
      botId: number;
      botUsername: string;
      tokenCiphertext: string;
      tokenKeyId: string;
      baseWebhookUrl: string;
    }
  | {
      status:
        | "not_found"
        | "expired"
        | "superseded"
        | "conflict"
        | "already_ready";
      connectionId?: string;
      botUsername?: string;
    };

function activationUrl(baseWebhookUrl: string, activationId: string): string {
  const url = new URL(baseWebhookUrl);
  url.searchParams.set("v", activationId);
  return url.toString();
}

/**
 * A webhook URL belongs to this Nokmel connection when its origin and path
 * match the persisted per-connection endpoint. Telegram's secret is not
 * exposed by getWebhookInfo, so the activation version query is what makes
 * cleanup target one activation and never a newer one.
 */
function isOwnedManagedWebhookUrl(
  currentUrl: string,
  baseWebhookUrl: string,
): boolean {
  if (currentUrl.length === 0) return true;

  try {
    const current = new URL(currentUrl);
    const base = new URL(baseWebhookUrl);

    return (
      current.origin === base.origin &&
      current.pathname === base.pathname &&
      current.searchParams.has("v")
    );
  } catch {
    return false;
  }
}

async function cleanupActivationWebhook(
  api: TelegramBotApiClient,
  expectedActivationUrl: string,
): Promise<void> {
  try {
    const info = await api.getWebhookInfo();
    if (info.ok && info.result.url === expectedActivationUrl) {
      await api.deleteWebhook(false);
    }
  } catch {
    // Cleanup is best-effort and must never mask the activation result.
  }
}

async function releaseActivationClaim(
  db: TransactionDatabase,
  input: {
    attemptId: string;
    connectionId: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(telegramConnection)
        .set({ status: "awaiting_confirmation" })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.status, "provisioning"),
          ),
        );

      await tx
        .update(telegramLinkAttempt)
        .set({ failureCode: input.reason })
        .where(
          and(
            eq(telegramLinkAttempt.id, input.attemptId),
            eq(telegramLinkAttempt.status, "awaiting_confirmation"),
            gt(telegramLinkAttempt.expiresAt, input.now),
          ),
        );
    });
  } catch {
    // A later attempt or expiry may have won; preserve that state.
  }
}

async function markActivationTerminal(
  db: TransactionDatabase,
  input: {
    attemptId: string;
    connectionId: string;
    reason: string;
    connectionStatus: "needs_review" | "revoked";
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(telegramConnection)
        .set({ status: input.connectionStatus })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.status, "provisioning"),
          ),
        );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "failed", failureCode: input.reason })
        .where(
          and(
            eq(telegramLinkAttempt.id, input.attemptId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        );
    });
  } catch {
    // Preserve the original terminal decision.
  }
}

/**
 * Starts external activation only after the signed-in merchant confirms the
 * verified bot. The claim is a short transaction; Telegram calls happen outside
 * the transaction; the result is committed with conditional state checks and
 * exact-URL cleanup on failure.
 */
export async function confirmTelegramConnection(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    connectionId: string;
  },
  deps: ActivationDependencies = {},
): Promise<ConfirmConnectionResult> {
  const now = deps.now ?? new Date();

  let claim: ActivationClaim;

  try {
    claim = await db.transaction(async (tx): Promise<ActivationClaim> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-connection-confirm",
          input.storeId,
        )}))`,
      );

      const rows = await tx
        .select({
          connectionId: telegramConnection.id,
          connectionStatus: telegramConnection.status,
          botId: telegramConnection.botId,
          botUsername: telegramConnection.botUsername,
          tokenCiphertext: telegramConnection.tokenCiphertext,
          tokenKeyId: telegramConnection.tokenKeyId,
          webhookUrl: telegramConnection.webhookUrl,
          attemptId: telegramLinkAttempt.id,
          attemptStatus: telegramLinkAttempt.status,
          attemptBotId: telegramLinkAttempt.telegramBotId,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramConnection)
        .innerJoin(
          telegramLinkAttempt,
          eq(telegramLinkAttempt.connectionId, telegramConnection.id),
        )
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.storeId, input.storeId),
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt))
        .limit(1);

      const row = rows[0];

      if (!row) return { status: "not_found" } as const;

      if (row.attemptBotId !== null && row.attemptBotId !== row.botId) {
        return { status: "conflict" } as const;
      }

      if (
        row.connectionStatus === "ready" &&
        row.attemptStatus === "completed"
      ) {
        return {
          status: "already_ready",
          connectionId: row.connectionId,
          botUsername: row.botUsername,
        } as const;
      }

      if (
        row.connectionStatus !== "awaiting_confirmation" ||
        row.attemptStatus !== "awaiting_confirmation"
      ) {
        return { status: "conflict" } as const;
      }

      if (row.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(eq(telegramLinkAttempt.id, row.attemptId));
        await tx
          .update(telegramConnection)
          .set({ status: "revoked" })
          .where(eq(telegramConnection.id, row.connectionId));
        return { status: "expired" } as const;
      }

      const [claimedConnection] = await tx
        .update(telegramConnection)
        .set({ status: "provisioning" })
        .where(
          and(
            eq(telegramConnection.id, row.connectionId),
            eq(telegramConnection.status, "awaiting_confirmation"),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!claimedConnection) {
        return { status: "conflict" } as const;
      }

      return {
        status: "claimed",
        attemptId: row.attemptId,
        connectionId: row.connectionId,
        botId: row.botId,
        botUsername: row.botUsername,
        tokenCiphertext: row.tokenCiphertext,
        tokenKeyId: row.tokenKeyId,
        baseWebhookUrl: row.webhookUrl,
      } as const;
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (claim.status !== "claimed") {
    if (claim.status === "already_ready") {
      return {
        status: "already_ready",
        connectionId: claim.connectionId!,
        botUsername: claim.botUsername!,
      };
    }

    return { status: claim.status };
  }

  let api: TelegramBotApiClient;

  try {
    const token = decryptConnectionSecret(
      claim.tokenCiphertext,
      claim.tokenKeyId,
    );
    api =
      deps.createBotApi?.(token) ??
      createTelegramBotApiClient(token);
  } catch {
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "secret_unavailable",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "secret_unavailable",
    };
  }

  const currentInfo = await api.getWebhookInfo();

  if (!currentInfo.ok) {
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "webhook_inspection_failed",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "webhook_inspection_failed",
    };
  }

  if (
    !isOwnedManagedWebhookUrl(
      currentInfo.result.url,
      claim.baseWebhookUrl,
    )
  ) {
    await markActivationTerminal(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "foreign_webhook",
      connectionStatus: "needs_review",
    });
    return { status: "foreign_webhook" };
  }

  const activationId = crypto.randomUUID();
  const expectedUrl = activationUrl(claim.baseWebhookUrl, activationId);
  const secret = generateWebhookSecret();

  const setWebhook = await api.setWebhook({
    url: expectedUrl,
    secretToken: secret,
    allowedUpdates: ["message", "callback_query"],
    dropPendingUpdates: false,
  });

  if (!setWebhook.ok) {
    await cleanupActivationWebhook(api, expectedUrl);
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "webhook_registration_failed",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "webhook_registration_failed",
    };
  }

  const verifiedInfo = await api.getWebhookInfo();

  if (!verifiedInfo.ok || verifiedInfo.result.url !== expectedUrl) {
    await cleanupActivationWebhook(api, expectedUrl);
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "webhook_verification_failed",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "webhook_verification_failed",
    };
  }

  const commitNow = new Date();

  try {
    const committed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-connection-store",
          input.storeId,
        )}))`,
      );

      const [currentAttempt] = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.id, claim.attemptId),
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          ),
        )
        .limit(1);

      if (!currentAttempt) return { status: "not_found" } as const;

      if (currentAttempt.expiresAt.getTime() <= commitNow.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(eq(telegramLinkAttempt.id, claim.attemptId));
        await tx
          .update(telegramConnection)
          .set({ status: "revoked" })
          .where(eq(telegramConnection.id, claim.connectionId));
        return { status: "expired" } as const;
      }

      if (currentAttempt.status !== "awaiting_confirmation") {
        return { status: "superseded" } as const;
      }

      const [connection] = await tx
        .select({
          id: telegramConnection.id,
          status: telegramConnection.status,
        })
        .from(telegramConnection)
        .where(
          and(
            eq(telegramConnection.id, claim.connectionId),
            eq(telegramConnection.storeId, input.storeId),
          ),
        )
        .limit(1);

      if (
        !connection ||
        connection.status !== "provisioning"
      ) {
        return { status: "superseded" } as const;
      }

      const [updatedAttempt] = await tx
        .update(telegramLinkAttempt)
        .set({ status: "completed", completedAt: commitNow, failureCode: null })
        .where(
          and(
            eq(telegramLinkAttempt.id, claim.attemptId),
            eq(telegramLinkAttempt.status, "awaiting_confirmation"),
            gt(telegramLinkAttempt.expiresAt, commitNow),
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!updatedAttempt) {
        throw new RabetDataError(
          "CONFLICT",
          "The link attempt changed during activation.",
        );
      }

      const [activated] = await tx
        .update(telegramConnection)
        .set({
          status: "ready",
          webhookUrl: expectedUrl,
          webhookSecretHash: hashWebhookSecret(secret),
          verifiedAt: commitNow,
        })
        .where(
          and(
            eq(telegramConnection.id, claim.connectionId),
            eq(telegramConnection.status, "provisioning"),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!activated) {
        throw new RabetDataError(
          "CONFLICT",
          "The connection changed during activation.",
        );
      }

      return { status: "ready" } as const;
    });

    if (committed.status !== "ready") {
      await cleanupActivationWebhook(api, expectedUrl);
      return { status: committed.status };
    }

    return {
      status: "ready",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
    };
  } catch (error) {
    await cleanupActivationWebhook(api, expectedUrl);

    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }

    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      reason: "activation_commit_failed",
      now,
    });

    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "activation_commit_failed",
    };
  }
}

export type MerchantTelegramConnectionState =
  | { state: "not_connected" }
  | {
      state: "waiting";
      deepLink: string;
      expiresAt: string;
      telegramBound: boolean;
    }
  | {
      state: "confirm";
      connectionId: string;
      botUsername: string;
      expiresAt: string;
      lastError: string | null;
    }
  | {
      state: "connected";
      botUsername: string;
      botName: string | null;
      openUrl: string;
    }
  | { state: "failed"; reason: string };

function stateFromAttempt(
  attempt: {
    status: string;
    managerBotUsername: string;
    nonceCiphertext: string;
    nonceKeyId: string;
    telegramUserId: number | null;
    expiresAt: Date;
    failureCode: string | null;
    connectionId: string | null;
  },
  now: Date,
): MerchantTelegramConnectionState {
  if (attempt.expiresAt.getTime() <= now.getTime()) {
    return { state: "failed", reason: "expired" };
  }

  if (attempt.status === "failed") {
    return { state: "failed", reason: attempt.failureCode ?? "failed" };
  }

  if (attempt.status === "cancelled") {
    return { state: "failed", reason: "superseded" };
  }

  if (attempt.status === "expired") {
    return { state: "failed", reason: "expired" };
  }

  let nonce: string;

  try {
    nonce = decryptConnectionSecret(
      attempt.nonceCiphertext,
      attempt.nonceKeyId,
    );
  } catch {
    return { state: "failed", reason: "unavailable" };
  }

  return {
    state: "waiting",
    deepLink: `https://t.me/${encodeURIComponent(
      attempt.managerBotUsername,
    )}?start=${encodeURIComponent(nonce)}`,
    expiresAt: attempt.expiresAt.toISOString(),
    telegramBound: attempt.telegramUserId !== null,
  };
}

/**
 * Reads the merchant-visible state. Only a connection the merchant explicitly
 * confirmed is reported as connected. No token, key or webhook digest is
 * returned.
 */
export async function readMerchantTelegramConnectionState(
  db: Database,
  input: {
    scope: StoreScope;
    merchantUserId: string;
    now?: Date;
  },
): Promise<MerchantTelegramConnectionState> {
  const now = input.now ?? new Date();

  const [ready] = await db
    .select({
      botUsername: telegramConnection.botUsername,
      botName: telegramConnection.botName,
    })
    .from(telegramConnection)
    .where(
      and(
        eq(telegramConnection.storeId, input.scope.storeId),
        eq(telegramConnection.status, "ready"),
      ),
    )
    .orderBy(desc(telegramConnection.verifiedAt))
    .limit(1);

  if (ready) {
    return {
      state: "connected",
      botUsername: ready.botUsername,
      botName: ready.botName,
      openUrl: `https://t.me/${encodeURIComponent(ready.botUsername)}`,
    };
  }

  const [attempt] = await db
    .select({
      status: telegramLinkAttempt.status,
      managerBotUsername: telegramLinkAttempt.managerBotUsername,
      nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
      nonceKeyId: telegramLinkAttempt.nonceKeyId,
      telegramUserId: telegramLinkAttempt.telegramUserId,
      expiresAt: telegramLinkAttempt.expiresAt,
      failureCode: telegramLinkAttempt.failureCode,
      connectionId: telegramLinkAttempt.connectionId,
      botUsername: telegramLinkAttempt.telegramBotUsername,
    })
    .from(telegramLinkAttempt)
    .where(
      and(
        eq(telegramLinkAttempt.storeId, input.scope.storeId),
        eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
      ),
    )
    .orderBy(desc(telegramLinkAttempt.createdAt))
    .limit(1);

  if (!attempt) return { state: "not_connected" };

  if (attempt.status === "completed" || attempt.status === "cancelled") {
    return { state: "not_connected" };
  }

  if (attempt.status === "awaiting_confirmation" && attempt.connectionId) {
    if (attempt.expiresAt.getTime() <= now.getTime()) {
      return { state: "failed", reason: "expired" };
    }

    if (attempt.botUsername) {
      return {
        state: "confirm",
        connectionId: attempt.connectionId,
        botUsername: attempt.botUsername,
        expiresAt: attempt.expiresAt.toISOString(),
        lastError: attempt.failureCode,
      };
    }
  }

  return stateFromAttempt(attempt, now);
}

export type ReadyManagedConnection = {
  id: string;
  storeId: string;
  storeName: string;
  botId: number;
  botUsername: string;
  tokenCiphertext: string;
  tokenKeyId: string;
  webhookSecretHash: string;
};

/**
 * Resolves a buyer webhook by its random public connection id. A connection is
 * usable only when it is ready and its store is active. A store id supplied in
 * a URL, callback or update never participates.
 */
export async function readReadyManagedConnection(
  db: Database,
  connectionId: string,
): Promise<ReadyManagedConnection | null> {
  const rows = await db
    .select({
      id: telegramConnection.id,
      storeId: telegramConnection.storeId,
      storeName: store.name,
      storeStatus: store.status,
      botId: telegramConnection.botId,
      botUsername: telegramConnection.botUsername,
      tokenCiphertext: telegramConnection.tokenCiphertext,
      tokenKeyId: telegramConnection.tokenKeyId,
      webhookSecretHash: telegramConnection.webhookSecretHash,
    })
    .from(telegramConnection)
    .innerJoin(store, eq(store.id, telegramConnection.storeId))
    .where(
      and(
        eq(telegramConnection.id, connectionId),
        eq(telegramConnection.status, "ready"),
        eq(store.status, "active"),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return {
    id: row.id,
    storeId: row.storeId,
    storeName: row.storeName,
    botId: row.botId,
    botUsername: row.botUsername,
    tokenCiphertext: row.tokenCiphertext,
    tokenKeyId: row.tokenKeyId,
    webhookSecretHash: row.webhookSecretHash,
  };
}

/** Test seam: the production manager webhook uses the shared transaction client. */
export function getProvisioningDb(): ApplicationTransactionDatabase {
  return getTransactionDb();
}
