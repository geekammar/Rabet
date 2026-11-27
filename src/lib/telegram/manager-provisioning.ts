import "server-only";

import crypto from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import {
  merchantNotificationBot,
  store,
  telegramConnection,
  telegramLinkAttempt,
} from "@/db/schema";
import type { TelegramLinkAttemptPurpose } from "@/db/schema";
import {
  getTransactionDb,
  type TransactionDatabase as ApplicationTransactionDatabase,
} from "@/db/transaction-client";
import type { StoreScope } from "@/lib/data/store-scope";
import { mapDatabaseError, RabetDataError } from "@/lib/data/errors";
import {
  lockNotificationBotOnboarding,
  saveManagedMerchantNotificationBot,
} from "@/lib/data/merchant-notification-bot";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
  generateLinkNonce,
  generateWebhookSecret,
  hashLinkNonce,
  hashWebhookSecret,
} from "./connection-secrets";
import { lockConnectionStore } from "./connection-locks";
import {
  buildManagedWebhookUrl,
  suggestedBotUsername,
  suggestedNotificationBotUsername,
} from "./manager-config";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
} from "./manager-api";
import { sanitizeTelegramError } from "./transport";
import type { TelegramMessage, TelegramTransport } from "./types";

export const TELEGRAM_LINK_ATTEMPT_TTL_MS = 15 * 60 * 1000;

/**
 * External webhook mutations (setWebhook/deleteWebhook) are serialized per bot
 * by a durable lease on the connection row. The lease outlives the bounded
 * Telegram HTTP timeout so a resumed stale operation must revalidate and lose
 * ownership before it can mutate again.
 */
export const WEBHOOK_OPERATION_LEASE_MS = 5 * 60 * 1000;

/** A provisioning claim older than this is abandoned and can be reclaimed. */
export const MANAGED_BOT_PROVISIONING_LEASE_MS = 2 * 60 * 1000;

/**
 * Marks a provisioned attempt that is waiting for the merchant to open the
 * exact managed bot and send it the attempt nonce. Until that challenge is
 * verified, the attempt is only a proposal: no connection, token or candidate
 * exists for it.
 */
export const MANAGED_BOT_START_FAILURE_CODE = "awaiting_bot_start";

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
    purpose?: TelegramLinkAttemptPurpose;
    now?: Date;
  },
): Promise<StartedLinkAttempt> {
  const purpose = input.purpose ?? "store_bot";
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS);
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  let encryptedNonce: { ciphertext: string; keyId: string };

  try {
    encryptedNonce = encryptConnectionSecret(nonce);
  } catch (error) {
    console.error("[merchant-telegram] link attempt failed", {
      phase: "encrypt_nonce",
      category:
        error instanceof Error &&
        /^[A-Za-z0-9_]{1,64}$/.test(error.name)
          ? error.name
          : "unknown",
    });
    throw error;
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          `${input.storeId}:${purpose}`,
        )}))`,
      );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, purpose),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, now),
          ),
        );

      // A new store-bot attempt supersedes any provisioned-but-unconfirmed
      // store connection. Notification-bot attempts never touch the store bot.
      if (purpose === "store_bot") {
        await tx
          .update(telegramConnection)
          .set({ status: "revoked", activationAttemptId: null })
          .where(
            and(
              eq(telegramConnection.storeId, input.storeId),
              inArray(telegramConnection.status, [
                "provisioning",
                "awaiting_confirmation",
              ]),
            ),
          );
      }

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "cancelled", failureCode: "superseded" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, purpose),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        );

      const [attempt] = await tx
        .insert(telegramLinkAttempt)
        .values({
          storeId: input.storeId,
          merchantUserId: input.merchantUserId,
          purpose,
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
    console.error("[merchant-telegram] link attempt failed", {
      phase: "attempt_transaction",
      category:
        error instanceof RabetDataError
          ? error.code
          : isUniqueViolation(error)
            ? "CONFLICT"
            : error instanceof Error &&
                /^[A-Za-z0-9_]{1,64}$/.test(error.name)
              ? error.name
              : "unknown",
    });

    if (isUniqueViolation(error)) {
      throw new RabetDataError(
        "CONFLICT",
        "Another Telegram connection attempt is already active for this purpose.",
        { cause: error },
      );
    }

    throw mapDatabaseError(error);
  }
}

/**
 * How long stored Telegram evidence remains eligible for automatic recovery.
 * A verified candidate older than this still needs operator support rather
 * than silently replacing a merchant's current intention.
 */
export const MANAGED_BOT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type EnsuredLinkAttempt =
  | {
      status: "created" | "reused";
      attemptId: string;
      nonce: string;
      expiresAt: Date;
    }
  | {
      status: "candidate";
      attemptId: string;
      connectionId: string;
      botUsername: string;
      botName: string | null;
      expiresAt: Date;
    }
  | {
      status: "preparing";
      attemptId: string;
      expiresAt: Date;
      botUsername?: string | null;
      botName?: string | null;
      verificationUrl?: string;
    }
  | {
      status: "recoverable";
      attemptId: string;
      connectionId: string | null;
      botUsername: string;
      botName: string | null;
    }
  | { status: "connected"; botUsername: string; botName: string | null }
  | { status: "conflict" };

/**
 * Returns the existing live attempt for a store instead of creating a second
 * one. A verified bot candidate is never revoked by a repeated Create tap, a
 * stale restored page, or a retry after Telegram has already confirmed the
 * bot. Only an empty/expired store creates a fresh deep link.
 */
export async function ensureTelegramLinkAttempt(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    managerBotUsername: string;
    now?: Date;
  },
): Promise<EnsuredLinkAttempt> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS);
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  let encryptedNonce: { ciphertext: string; keyId: string };

  try {
    encryptedNonce = encryptConnectionSecret(nonce);
  } catch {
    return { status: "conflict" };
  }

  try {
    return await db.transaction(async (tx): Promise<EnsuredLinkAttempt> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          `${input.storeId}:store_bot`,
        )}))`,
      );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "store_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, now),
          ),
        );

      const [ready] = await tx
        .select({
          botUsername: telegramConnection.botUsername,
          botName: telegramConnection.botName,
        })
        .from(telegramConnection)
        .where(
          and(
            eq(telegramConnection.storeId, input.storeId),
            eq(telegramConnection.status, "ready"),
          ),
        )
        .orderBy(desc(telegramConnection.verifiedAt))
        .limit(1);

      if (ready) {
        return {
          status: "connected",
          botUsername: ready.botUsername,
          botName: ready.botName,
        } as const;
      }

      const active = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          connectionId: telegramLinkAttempt.connectionId,
          nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
          nonceKeyId: telegramLinkAttempt.nonceKeyId,
          telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          telegramBotName: telegramLinkAttempt.telegramBotName,
          failureCode: telegramLinkAttempt.failureCode,
          verifiedAt: telegramLinkAttempt.verifiedAt,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "store_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt));

      if (active.length > 1) {
        return { status: "conflict" } as const;
      }

      const current = active[0];

      if (
        current?.status === "awaiting_confirmation" &&
        current.connectionId &&
        current.telegramBotUsername &&
        current.verifiedAt !== null &&
        current.failureCode !== MANAGED_BOT_START_FAILURE_CODE
      ) {
        return {
          status: "candidate",
          attemptId: current.id,
          connectionId: current.connectionId,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
          expiresAt: current.expiresAt,
        } as const;
      }

      if (current?.status === "provisioning") {
        const nonce =
          current.failureCode === MANAGED_BOT_START_FAILURE_CODE &&
          current.telegramBotUsername
            ? attemptNonceOrNull(
                current.nonceCiphertext,
                current.nonceKeyId,
              )
            : null;

        return {
          status: "preparing",
          attemptId: current.id,
          expiresAt: current.expiresAt,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
          verificationUrl:
            nonce && current.telegramBotUsername
              ? managedBotStartDeepLink(current.telegramBotUsername, nonce)
              : undefined,
        } as const;
      }

      if (
        current?.status === "awaiting_confirmation" &&
        current.connectionId &&
        current.telegramBotUsername &&
        current.verifiedAt === null
      ) {
        const nonce = attemptNonceOrNull(
          current.nonceCiphertext,
          current.nonceKeyId,
        );

        return {
          status: "preparing",
          attemptId: current.id,
          expiresAt: current.expiresAt,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
          verificationUrl: nonce
            ? managedBotStartDeepLink(current.telegramBotUsername, nonce)
            : undefined,
        } as const;
      }

      // A verified candidate whose attempt expired or was superseded must be
      // recovered by ownership re-verification, never replaced by a new bot.
      const recoverable = await findRecoverableCandidateEvidence(tx, {
        storeId: input.storeId,
        merchantUserId: input.merchantUserId,
        now,
      });

      if (recoverable) {
        return {
          status: "recoverable",
          attemptId: recoverable.attemptId,
          connectionId: recoverable.connectionId,
          botUsername: recoverable.botUsername,
          botName: recoverable.botName,
        } as const;
      }

      if (current?.status === "pending") {
        try {
          return {
            status: "reused",
            attemptId: current.id,
            nonce: decryptConnectionSecret(
              current.nonceCiphertext,
              current.nonceKeyId,
            ),
            expiresAt: current.expiresAt,
          } as const;
        } catch {
          return { status: "conflict" } as const;
        }
      }

      const [attempt] = await tx
        .insert(telegramLinkAttempt)
        .values({
          storeId: input.storeId,
          merchantUserId: input.merchantUserId,
          purpose: "store_bot",
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

      return {
        status: "created",
        attemptId: attempt.id,
        nonce,
        expiresAt,
      } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }

    throw mapDatabaseError(error);
  }
}

type RecoverableCandidateEvidence = {
  attemptId: string;
  connectionId: string | null;
  managerBotUsername: string;
  telegramUserId: number;
  botId: number;
  botUsername: string;
  botName: string | null;
};

/**
 * Finds stored Telegram evidence that a bot was already created for this
 * store. Only the store's own verified connection or its bound attempt is
 * considered; a username alone is never proof.
 */
async function findRecoverableCandidateEvidence(
  tx: AttemptTransaction,
  input: {
    storeId: string;
    merchantUserId: string;
    now: Date;
  },
): Promise<RecoverableCandidateEvidence | null> {
  const cutoff = new Date(input.now.getTime() - MANAGED_BOT_RECOVERY_WINDOW_MS);

  const connections = await tx
    .select({
      connectionId: telegramConnection.id,
      botId: telegramConnection.botId,
      botUsername: telegramConnection.botUsername,
      botName: telegramConnection.botName,
    })
    .from(telegramConnection)
    .where(
      and(
        eq(telegramConnection.storeId, input.storeId),
        inArray(telegramConnection.status, [
          "awaiting_confirmation",
          "revoked",
        ]),
        isNotNull(telegramConnection.verifiedAt),
        gt(telegramConnection.verifiedAt, cutoff),
      ),
    )
    .orderBy(desc(telegramConnection.verifiedAt))
    .limit(2);

  if (connections.length > 1) return null;

  const connection = connections[0];

  if (connection) {
    const [attempt] = await tx
      .select({
        attemptId: telegramLinkAttempt.id,
        managerBotUsername: telegramLinkAttempt.managerBotUsername,
        telegramUserId: telegramLinkAttempt.telegramUserId,
        telegramBotId: telegramLinkAttempt.telegramBotId,
      })
      .from(telegramLinkAttempt)
      .where(
        and(
          eq(telegramLinkAttempt.storeId, input.storeId),
          eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          eq(telegramLinkAttempt.purpose, "store_bot"),
          eq(telegramLinkAttempt.connectionId, connection.connectionId),
          isNotNull(telegramLinkAttempt.telegramUserId),
          isNotNull(telegramLinkAttempt.telegramBotId),
        ),
      )
      .orderBy(desc(telegramLinkAttempt.createdAt))
      .limit(1);

    if (
      attempt &&
      attempt.telegramUserId !== null &&
      attempt.telegramBotId === connection.botId
    ) {
      return {
        attemptId: attempt.attemptId,
        connectionId: connection.connectionId,
        managerBotUsername: attempt.managerBotUsername,
        telegramUserId: attempt.telegramUserId,
        botId: connection.botId,
        botUsername: connection.botUsername,
        botName: connection.botName,
      };
    }
  }

  const attempts = await tx
    .select({
      attemptId: telegramLinkAttempt.id,
      managerBotUsername: telegramLinkAttempt.managerBotUsername,
      telegramUserId: telegramLinkAttempt.telegramUserId,
      botId: telegramLinkAttempt.telegramBotId,
      botUsername: telegramLinkAttempt.telegramBotUsername,
      botName: telegramLinkAttempt.telegramBotName,
    })
    .from(telegramLinkAttempt)
    .where(
      and(
        eq(telegramLinkAttempt.storeId, input.storeId),
        eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
        eq(telegramLinkAttempt.purpose, "store_bot"),
        inArray(telegramLinkAttempt.status, ["expired", "cancelled", "failed"]),
        isNull(telegramLinkAttempt.connectionId),
        isNotNull(telegramLinkAttempt.telegramUserId),
        isNotNull(telegramLinkAttempt.telegramBotId),
        isNotNull(telegramLinkAttempt.telegramBotUsername),
        isNotNull(telegramLinkAttempt.verifiedAt),
        gt(telegramLinkAttempt.updatedAt, cutoff),
      ),
    )
    .orderBy(desc(telegramLinkAttempt.createdAt))
    .limit(2);

  if (attempts.length > 1) return null;

  const attempt = attempts[0];

  if (
    !attempt ||
    attempt.telegramUserId === null ||
    attempt.botId === null ||
    !attempt.botUsername
  ) {
    return null;
  }

  return {
    attemptId: attempt.attemptId,
    connectionId: null,
    managerBotUsername: attempt.managerBotUsername,
    telegramUserId: attempt.telegramUserId,
    botId: attempt.botId,
    botUsername: attempt.botUsername,
    botName: attempt.botName,
  };
}

export type LinkAttemptLookup = {
  id: string;
  storeId: string;
  merchantUserId: string;
  purpose: TelegramLinkAttemptPurpose;
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
      purpose: telegramLinkAttempt.purpose,
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

      // The per-user partial unique index reserves every attempt stored in a
      // live status, even when its TTL has already passed. Expire only those
      // eligible stale attempts for this exact Telegram identity before the
      // bind update; a genuinely unexpired competing attempt still conflicts.
      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired", updatedAt: now })
        .where(
          and(
            eq(telegramLinkAttempt.telegramUserId, input.telegramUserId),
            eq(telegramLinkAttempt.purpose, attempt.purpose),
            ne(telegramLinkAttempt.id, attempt.id),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, now),
          ),
        );

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

export function merchantManagerDeepLink(managerUsername: string, nonce: string): string {
  return `https://t.me/${encodeURIComponent(managerUsername)}?start=${encodeURIComponent(nonce)}`;
}

export function managedBotStartDeepLink(
  botUsername: string,
  nonce: string,
): string {
  return `https://t.me/${encodeURIComponent(
    botUsername,
  )}?start=${encodeURIComponent(nonce)}`;
}

function attemptNonceOrNull(
  ciphertext: string,
  keyId: string,
): string | null {
  try {
    return decryptConnectionSecret(ciphertext, keyId);
  } catch {
    return null;
  }
}

function creationLink(attempt: LinkAttemptLookup): string {
  const isNotification = attempt.purpose === "notification_bot";
  const username = isNotification
    ? suggestedNotificationBotUsername(attempt.storeSlug)
    : suggestedBotUsername(attempt.storeSlug);
  const displayName = isNotification
    ? `${attempt.storeName} notifications`
    : `${attempt.storeName} store`;

  return `https://t.me/newbot/${encodeURIComponent(
    attempt.managerBotUsername,
  )}/${encodeURIComponent(username)}?name=${encodeURIComponent(displayName)}`;
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

  if (bound.status === "mismatch") {
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

  if (bound.status === "conflict") {
    const result = await transport.sendMessage({
      chatId: message.chat.id,
      text:
        "This Telegram account already has another active store connection attempt for this purpose. Finish that attempt or wait for it to expire, then return to the Rabet merchant dashboard and try again.",
    });
    if (!result.ok) {
      throw new Error(sanitizeTelegramError(result.error ?? "Send failed"));
    }
    return;
  }

  if (!bound.attempt) {
    return;
  }

  const isNotification = bound.attempt.purpose === "notification_bot";
  const result = await transport.sendMessage({
    chatId: message.chat.id,
    text: isNotification
      ? "Create the Telegram notification bot that will send alerts for your store. " +
        "Telegram will show the suggested name and username; you may edit both.\n\n" +
        "After you confirm, open the new bot and press Start, then return to the Rabet dashboard to verify it."
      : "Create the Telegram bot that will serve your store. " +
        "Telegram will show the suggested name and username; you may edit both.\n\n" +
        "After you confirm, return to the Rabet dashboard to verify and approve the connection.",
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: isNotification
              ? "Create notification bot / إنشاء بوت الإشعارات"
              : "Create store bot",
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
  transport?: TelegramTransport;
  webhookOrigin: string;
  now?: Date;
};

type CorrelationOutcome =
  | { status: "already_provisioned"; attemptId: string; connectionId: string | null }
  | { status: "already_awaiting_start"; attemptId: string }
  | { status: "in_progress" }
  | { status: "unmatched" }
  | { status: "expired" }
  | { status: "ambiguous" }
  | { status: "bot_bound_elsewhere" }
  | { status: "bot_review" }
  | { status: "superseded" };

export type ProvisionResult =
  | {
      status: "awaiting_confirmation";
      attemptId: string;
      connectionId: string;
      botUsername: string;
    }
  | {
      status: "awaiting_bot_start";
      attemptId: string;
      botUsername: string;
      verificationUrl?: string;
    }
  | { status: "already_provisioned"; attemptId: string; connectionId: string | null }
  | { status: "already_awaiting_start"; attemptId: string }
  | { status: "in_progress" }
  | { status: "unmatched" }
  | { status: "expired" }
  | { status: "ambiguous" }
  | { status: "bot_bound_elsewhere" }
  | { status: "bot_review" }
  | { status: "superseded" }
  | { status: "retryable"; reason: string }
  | { status: "failed"; reason: string };

type AttemptCandidateClaim = {
  attemptId: string;
  storeId: string;
  purpose: TelegramLinkAttemptPurpose;
  managerBotUsername: string;
  nonceCiphertext: string;
  nonceKeyId: string;
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
 * attempt and records it as an unverified proposal.
 *
 * Telegram's documented `managed_bot` / `managed_bot_created` payloads carry
 * only the creator and the bot; they do not echo an attempt id or the
 * `request_managed_bot` request id. A matching creator and bot id are
 * therefore necessary but not sufficient proof. This path deliberately does
 * not fetch the bot token, create a connection, or offer a candidate. It only
 * asks the merchant to prove the exact bot by opening it and sending the
 * attempt nonce; `verifyManagedBotStart` performs the trusted verification.
 *
 * This path performs **no webhook mutation**.
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
          purpose: telegramLinkAttempt.purpose,
          managerBotUsername: telegramLinkAttempt.managerBotUsername,
          status: telegramLinkAttempt.status,
          telegramBotId: telegramLinkAttempt.telegramBotId,
          connectionId: telegramLinkAttempt.connectionId,
          failureCode: telegramLinkAttempt.failureCode,
          nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
          nonceKeyId: telegramLinkAttempt.nonceKeyId,
          expiresAt: telegramLinkAttempt.expiresAt,
          updatedAt: telegramLinkAttempt.updatedAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.telegramUserId, event.creatorUserId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt));

      // The partial unique indexes reserve every attempt stored in an active
      // status, even after its TTL has passed. Only unexpired rows are live
      // candidates for this event; an expired row must not turn a single live
      // attempt into an ambiguous one. A recently expired row still remains
      // visible to the delayed-event guard below once it is marked expired.
      const liveActive = active.filter(
        (attempt) => attempt.expiresAt.getTime() > now.getTime(),
      );
      const expiredActive = active.filter(
        (attempt) => attempt.expiresAt.getTime() <= now.getTime(),
      );

      const attempt = liveActive[0] ?? expiredActive[0];

      if (attempt) {
        const otherExpiredIds = expiredActive
          .filter((candidate) => candidate.id !== attempt.id)
          .map((candidate) => candidate.id);

        if (otherExpiredIds.length > 0) {
          await tx
            .update(telegramLinkAttempt)
            .set({
              status: "expired",
              failureCode: "expired",
              updatedAt: now,
            })
            .where(inArray(telegramLinkAttempt.id, otherExpiredIds));
        }
      }

      if (liveActive.length > 1) {
        for (const liveAttempt of liveActive) {
          await failActiveAttempt(tx, liveAttempt.id, "ambiguous_event", now);
        }
        return { status: "ambiguous" } as const;
      }

      if (!attempt) {
        const [completed] = await tx
          .select({
            id: telegramLinkAttempt.id,
            storeId: telegramLinkAttempt.storeId,
            purpose: telegramLinkAttempt.purpose,
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

        if (completed?.purpose === "notification_bot") {
          const [existingNotificationBot] = await tx
            .select({
              id: merchantNotificationBot.id,
              storeId: merchantNotificationBot.storeId,
            })
            .from(merchantNotificationBot)
            .where(eq(merchantNotificationBot.botId, event.botId))
            .limit(1);

          if (
            existingNotificationBot &&
            existingNotificationBot.storeId === completed.storeId
          ) {
            return {
              status: "already_provisioned",
              attemptId: completed.id,
              connectionId: null,
            } as const;
          }
        }

        if (completed?.connectionId) {
          const [existingConnection] = await tx
            .select({
              id: telegramConnection.id,
              storeId: telegramConnection.storeId,
              status: telegramConnection.status,
            })
            .from(telegramConnection)
            .where(eq(telegramConnection.id, completed.connectionId))
            .limit(1);

          if (
            existingConnection &&
            existingConnection.storeId === completed.storeId
          ) {
            if (existingConnection.status === "needs_review") {
              return { status: "bot_review" } as const;
            }

            return {
              status: "already_provisioned",
              attemptId: completed.id,
              connectionId: completed.connectionId,
            } as const;
          }
        }

        const recent = await tx
          .select({
            id: telegramLinkAttempt.id,
            connectionId: telegramLinkAttempt.connectionId,
          })
          .from(telegramLinkAttempt)
          .where(
            and(
              eq(telegramLinkAttempt.telegramUserId, event.creatorUserId),
              inArray(telegramLinkAttempt.status, [
                "expired",
                "cancelled",
                "failed",
              ]),
              gt(
                telegramLinkAttempt.createdAt,
                new Date(
                  now.getTime() - TELEGRAM_LINK_ATTEMPT_TTL_MS,
                ),
              ),
            ),
          )
          .orderBy(desc(telegramLinkAttempt.createdAt))
          .limit(2);

        if (recent.length === 1) {
          // A late event after its attempt ended is not trusted evidence for
          // that attempt. Recovery may only use challenge-verified rows, so
          // the generic event is acknowledged but never persisted.
          return { status: "superseded" } as const;
        }

        return { status: "unmatched" } as const;
      }

      // A late creation event from another store that used the same Telegram
      // account is not proof for this store. Fail closed when another recent
      // attempt could own this exact bot (same recorded bot id), or when an
      // attempt has no recorded bot id and could be the source of a delayed
      // event. A recent other-store attempt with a different known bot id
      // cannot own this event, so sequential distinct bots remain linkable.
      const recentAttemptCutoff = new Date(
        now.getTime() - TELEGRAM_LINK_ATTEMPT_TTL_MS,
      );

      const otherStoreAttempts = await tx
        .select({
          id: telegramLinkAttempt.id,
          telegramBotId: telegramLinkAttempt.telegramBotId,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.telegramUserId, event.creatorUserId),
            ne(telegramLinkAttempt.id, attempt.id),
            or(
              ne(telegramLinkAttempt.storeId, attempt.storeId),
              ne(telegramLinkAttempt.purpose, attempt.purpose),
            ),
            inArray(telegramLinkAttempt.status, [
              "completed",
              "expired",
              "cancelled",
              "failed",
            ]),
            or(
              gt(telegramLinkAttempt.createdAt, recentAttemptCutoff),
              and(
                eq(telegramLinkAttempt.status, "expired"),
                gt(telegramLinkAttempt.expiresAt, recentAttemptCutoff),
              ),
            ),
          ),
        );

      const hasConflictingOtherStoreEvidence = otherStoreAttempts.some(
        (other) =>
          other.telegramBotId === null ||
          other.telegramBotId === event.botId,
      );

      if (hasConflictingOtherStoreEvidence) {
        return { status: "ambiguous" } as const;
      }

      if (attempt.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({
            status: "expired",
            failureCode: "created_after_expiry",
            updatedAt: now,
          })
          .where(eq(telegramLinkAttempt.id, attempt.id));
        return { status: "expired" } as const;
      }

      if (
        attempt.telegramBotId !== null &&
        attempt.telegramBotId !== event.botId
      ) {
        // While the merchant has an unverified proposal, a different bot event
        // is ignored instead of replacing or failing that proposal. It cannot
        // become a candidate without its own verified bot-start challenge.
        if (
          attempt.status === "provisioning" &&
          attempt.failureCode === MANAGED_BOT_START_FAILURE_CODE
        ) {
          return { status: "ambiguous" } as const;
        }

        await failActiveAttempt(
          tx,
          attempt.id,
          "conflicting_bot_event",
          now,
        );
        return { status: "ambiguous" } as const;
      }

      if (attempt.telegramBotId === event.botId) {
        if (attempt.connectionId) {
          return {
            status: "already_provisioned",
            attemptId: attempt.id,
            connectionId: attempt.connectionId,
          } as const;
        }

        if (
          attempt.status === "provisioning" &&
          attempt.failureCode === MANAGED_BOT_START_FAILURE_CODE
        ) {
          return {
            status: "already_awaiting_start",
            attemptId: attempt.id,
          } as const;
        }
      }

      const [boundNotificationBot] = await tx
        .select({
          id: merchantNotificationBot.id,
          storeId: merchantNotificationBot.storeId,
        })
        .from(merchantNotificationBot)
        .where(eq(merchantNotificationBot.botId, event.botId))
        .limit(1);

      if (boundNotificationBot) {
        if (boundNotificationBot.storeId !== attempt.storeId) {
          await failActiveAttempt(tx, attempt.id, "bot_bound_elsewhere", now);
          return { status: "bot_bound_elsewhere" } as const;
        }

        if (attempt.purpose === "notification_bot") {
          return {
            status: "already_provisioned",
            attemptId: attempt.id,
            connectionId: null,
          } as const;
        }

        await failActiveAttempt(tx, attempt.id, "bot_purpose_conflict", now);
        return { status: "ambiguous" } as const;
      }

      const [boundElsewhere] = await tx
        .select({
          id: telegramConnection.id,
          storeId: telegramConnection.storeId,
          status: telegramConnection.status,
        })
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

      if (boundElsewhere && attempt.purpose === "notification_bot") {
        await failActiveAttempt(tx, attempt.id, "bot_purpose_conflict", now);
        return { status: "ambiguous" } as const;
      }

      if (boundElsewhere?.status === "needs_review") {
        await failActiveAttempt(
          tx,
          attempt.id,
          "webhook_outcome_unknown",
          now,
        );
        return { status: "bot_review" } as const;
      }

      if (attempt.status === "provisioning") {
        const staleCutoff = new Date(
          now.getTime() - MANAGED_BOT_PROVISIONING_LEASE_MS,
        );

        if (attempt.updatedAt.getTime() > staleCutoff.getTime()) {
          return { status: "in_progress" } as const;
        }

        const [reclaimed] = await tx
          .update(telegramLinkAttempt)
          .set({
            status: "pending",
            failureCode: "provisioning_stale",
            updatedAt: now,
          })
          .where(
            and(
              eq(telegramLinkAttempt.id, attempt.id),
              eq(telegramLinkAttempt.status, "provisioning"),
              lte(telegramLinkAttempt.updatedAt, staleCutoff),
            ),
          )
          .returning({ id: telegramLinkAttempt.id });

        if (!reclaimed) {
          return { status: "in_progress" } as const;
        }
      }

      const [claimedAttempt] = await tx
        .update(telegramLinkAttempt)
        .set({
          status: "provisioning",
          telegramBotId: event.botId,
          telegramBotUsername: event.botUsername,
          telegramBotName: event.botName,
          failureCode: MANAGED_BOT_START_FAILURE_CODE,
          // A notification proposal only becomes actionable now that Telegram
          // has reported the created bot. Give the merchant a full challenge
          // window from this first event; duplicate events return
          // `already_awaiting_start` above and never extend it again.
          ...(attempt.purpose === "notification_bot"
            ? {
                expiresAt: new Date(
                  now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS,
                ),
              }
            : {}),
          updatedAt: now,
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
        purpose: attempt.purpose,
        managerBotUsername: attempt.managerBotUsername,
        nonceCiphertext: attempt.nonceCiphertext,
        nonceKeyId: attempt.nonceKeyId,
      };
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (claimed === null) return { status: "in_progress" };
  if ("status" in claimed) return claimed;

  const { attemptId } = claimed;

  const nonce = attemptNonceOrNull(
    claimed.nonceCiphertext,
    claimed.nonceKeyId,
  );

  if (!nonce) {
    return retryableCandidateFailure(
      db,
      attemptId,
      "secret_unavailable",
      now,
    );
  }

  if (!event.botUsername) {
    return retryableCandidateFailure(
      db,
      attemptId,
      "bot_username_missing",
      now,
    );
  }

  const verificationUrl = managedBotStartDeepLink(
    event.botUsername,
    nonce,
  );

  await sendManagedBotStartChallenge(deps.transport, {
    chatId: event.creatorUserId,
    purpose: claimed.purpose,
    botName: event.botName,
    botUsername: event.botUsername,
    verificationUrl,
  });

  return {
    status: "awaiting_bot_start",
    attemptId,
    botUsername: event.botUsername,
    verificationUrl,
  };
}

export const MANAGED_BOT_START_BUTTON_TEXT = "افتح البوت واضغط Start / Open bot and press Start";

export function managedBotStartChallengeCopy(input: {
  purpose?: TelegramLinkAttemptPurpose;
  botName: string | null;
  botUsername: string;
  verificationUrl: string;
}): { text: string; replyMarkup: { inline_keyboard: { text: string; url: string }[][] } } {
  const displayName = input.botName?.trim() || input.botUsername;
  const isNotification = input.purpose === "notification_bot";

  return {
    text:
      (isNotification
        ? `تم استلام طلب إنشاء بوت إشعارات متجرك:\n`
        : `تم استلام طلب إنشاء بوت المتجر:\n`) +
      `${displayName}\n` +
      `@${input.botUsername}\n\n` +
      (isNotification
        ? "لإثبات أن هذا البوت هو بوت إشعارات متجرك، افتحه واضغط Start ثم ارجع إلى نكمل للتحقق.\n" +
          "This notification bot is yours. Open it, press Start, then return to Nokmel to verify it."
        : "لإثبات أن هذا البوت هو بوت متجرك، افتحه واضغط Start ثم ارجع إلى نكمل للتحقق."),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: MANAGED_BOT_START_BUTTON_TEXT,
            url: input.verificationUrl,
          },
        ],
      ],
    },
  };
}

async function sendManagedBotStartChallenge(
  transport: TelegramTransport | undefined,
  input: {
    chatId: number;
    purpose?: TelegramLinkAttemptPurpose;
    botName: string | null;
    botUsername: string;
    verificationUrl: string;
  },
): Promise<void> {
  if (!transport) return;

  try {
    const copy = managedBotStartChallengeCopy(input);
    const result = await transport.sendMessage({
      chatId: input.chatId,
      text: copy.text,
      replyMarkup: copy.replyMarkup,
    });

    if (!result.ok) {
      console.error("[manager-bot] bot start challenge failed", {
        category: result.errorKind ?? "unknown",
      });
    }
  } catch {
    console.error("[manager-bot] bot start challenge failed", {
      category: "exception",
    });
  }
}

export const MANAGED_BOT_RETURN_BUTTON_TEXT = "العودة إلى نكمل";

export function managedBotSetupReturnUrl(origin: string): string {
  const url = new URL("/app/setup", origin);
  url.searchParams.set("telegram", "created");
  return url.toString();
}

export function managedBotConfirmationCopy(input: {
  botName: string | null;
  botUsername: string;
  origin: string;
}): { text: string; replyMarkup: { inline_keyboard: { text: string; url: string }[][] } } {
  const displayName = input.botName?.trim() || input.botUsername;

  return {
    text:
      `تم إنشاء بوت متجرك بنجاح:\n` +
      `${displayName}\n` +
      `@${input.botUsername}\n\n` +
      "ارجع إلى نكمل لتأكيد ربط البوت.",
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: MANAGED_BOT_RETURN_BUTTON_TEXT,
            url: managedBotSetupReturnUrl(input.origin),
          },
        ],
      ],
    },
  };
}

async function sendManagedBotConfirmation(
  transport: TelegramTransport | undefined,
  input: {
    chatId: number;
    botName: string | null;
    botUsername: string;
    origin: string;
  },
): Promise<void> {
  if (!transport) return;

  try {
    const copy = managedBotConfirmationCopy(input);
    const result = await transport.sendMessage({
      chatId: input.chatId,
      text: copy.text,
      replyMarkup: copy.replyMarkup,
    });

    if (!result.ok) {
      console.error("[manager-bot] candidate notification failed", {
        category: result.errorKind ?? "unknown",
      });
    }
  } catch {
    console.error("[manager-bot] candidate notification failed", {
      category: "exception",
    });
  }
}


export type ManagedBotStartVerificationDependencies = {
  managerApi: TelegramBotApiClient;
  createBotApi?: (token: string) => TelegramBotApiClient;
  transport?: TelegramTransport;
  webhookOrigin: string;
  now?: Date;
};

export type VerifyManagedBotStartResult =
  | {
      status: "verified" | "already_verified";
      attemptId: string;
      connectionId: string;
      botUsername: string;
      botName: string | null;
    }
  | { status: "pending" }
  | {
      status:
        | "not_found"
        | "expired"
        | "conflict"
        | "bot_bound_elsewhere"
        | "bot_review";
    }
  | { status: "retryable"; reason: string };

type ManagedBotProposal = {
  attemptId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  telegramUserId: number;
  nonceCiphertext: string;
  nonceKeyId: string;
  expiresAt: Date;
};

/**
 * Verifies that the exact proposed managed bot received `/start <nonce>` from
 * the Telegram account already bound to this attempt.
 *
 * The bot token is only fetched here, after the merchant has acted. A token
 * proves the bot belongs to the manager bot; `getMe` fixes the exact bot id;
 * `getUpdates` for that bot proves the attempt nonce reached it from the
 * authenticated creator. Only then is a connection row created and the
 * merchant offered the explicit confirmation step.
 */
export async function verifyManagedBotStart(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    attemptId?: string | null;
    purpose?: TelegramLinkAttemptPurpose;
  },
  deps: ManagedBotStartVerificationDependencies,
): Promise<VerifyManagedBotStartResult> {
  const purpose = input.purpose ?? "store_bot";
  const lookupNow = deps.now ?? new Date();

  let lookup:
    | { kind: "proposal"; proposal: ManagedBotProposal }
    | { kind: "result"; result: VerifyManagedBotStartResult };

  try {
    lookup = await db.transaction(
      async (tx): Promise<
        | { kind: "proposal"; proposal: ManagedBotProposal }
        | { kind: "result"; result: VerifyManagedBotStartResult }
      > => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
            "telegram-link-attempt",
            `${input.storeId}:store_bot`,
          )}))`,
        );

        const conditions = [
          eq(telegramLinkAttempt.storeId, input.storeId),
          eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          eq(telegramLinkAttempt.purpose, purpose),
          inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
        ];

        if (input.attemptId) {
          conditions.push(eq(telegramLinkAttempt.id, input.attemptId));
        }

        const [attempt] = await tx
          .select({
            id: telegramLinkAttempt.id,
            status: telegramLinkAttempt.status,
            failureCode: telegramLinkAttempt.failureCode,
            connectionId: telegramLinkAttempt.connectionId,
            telegramUserId: telegramLinkAttempt.telegramUserId,
            telegramBotId: telegramLinkAttempt.telegramBotId,
            telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
            telegramBotName: telegramLinkAttempt.telegramBotName,
            nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
            nonceKeyId: telegramLinkAttempt.nonceKeyId,
            verifiedAt: telegramLinkAttempt.verifiedAt,
            expiresAt: telegramLinkAttempt.expiresAt,
          })
          .from(telegramLinkAttempt)
          .where(and(...conditions))
          .orderBy(desc(telegramLinkAttempt.createdAt))
          .limit(1);

        if (!attempt) {
          return { kind: "result", result: { status: "not_found" } };
        }

        if (
          attempt.status === "awaiting_confirmation" &&
          attempt.connectionId &&
          attempt.telegramBotUsername &&
          attempt.verifiedAt !== null &&
          attempt.failureCode !== MANAGED_BOT_START_FAILURE_CODE
        ) {
          return {
            kind: "result",
            result: {
              status: "already_verified",
              attemptId: attempt.id,
              connectionId: attempt.connectionId,
              botUsername: attempt.telegramBotUsername,
              botName: attempt.telegramBotName,
            },
          };
        }

        if (
          attempt.status !== "provisioning" ||
          attempt.failureCode !== MANAGED_BOT_START_FAILURE_CODE ||
          attempt.connectionId !== null ||
          attempt.telegramUserId === null ||
          attempt.telegramBotId === null ||
          !attempt.telegramBotUsername
        ) {
          return { kind: "result", result: { status: "not_found" } };
        }

        if (attempt.expiresAt.getTime() <= lookupNow.getTime()) {
          await tx
            .update(telegramLinkAttempt)
            .set({ status: "expired", failureCode: "expired" })
            .where(
              and(
                eq(telegramLinkAttempt.id, attempt.id),
                eq(telegramLinkAttempt.status, "provisioning"),
              ),
            );
          return { kind: "result", result: { status: "expired" } };
        }

        return {
          kind: "proposal",
          proposal: {
            attemptId: attempt.id,
            botId: attempt.telegramBotId,
            botUsername: attempt.telegramBotUsername,
            botName: attempt.telegramBotName,
            telegramUserId: attempt.telegramUserId,
            nonceCiphertext: attempt.nonceCiphertext,
            nonceKeyId: attempt.nonceKeyId,
            expiresAt: attempt.expiresAt,
          },
        };
      },
    );
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (lookup.kind === "result") return lookup.result;

  const { proposal } = lookup;
  const nonce = attemptNonceOrNull(
    proposal.nonceCiphertext,
    proposal.nonceKeyId,
  );

  if (!nonce) {
    return { status: "retryable", reason: "secret_unavailable" };
  }

  const tokenResult = await deps.managerApi.getManagedBotToken(proposal.botId);

  if (!tokenResult.ok || typeof tokenResult.result !== "string") {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  const token = tokenResult.result.trim();

  if (token.length === 0) {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  let managedApi: TelegramBotApiClient;

  try {
    managedApi =
      deps.createBotApi?.(token) ?? createTelegramBotApiClient(token);
  } catch {
    return { status: "retryable", reason: "api_unavailable" };
  }

  const me = await managedApi.getMe();

  if (
    !me.ok ||
    me.result.id !== proposal.botId ||
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    me.result.username.length === 0
  ) {
    return { status: "retryable", reason: "verification_failed" };
  }

  const verifiedUsername = me.result.username;
  const verifiedName =
    typeof me.result.first_name === "string" ? me.result.first_name : null;

  const webhookInfo = await managedApi.getWebhookInfo();

  if (!webhookInfo.ok) {
    return { status: "retryable", reason: "webhook_inspection_failed" };
  }

  const [existingBound] = await db
    .select({
      id: telegramConnection.id,
      storeId: telegramConnection.storeId,
      status: telegramConnection.status,
      webhookUrl: telegramConnection.webhookUrl,
    })
    .from(telegramConnection)
    .where(eq(telegramConnection.botId, proposal.botId))
    .limit(1);

  const alreadyBoundToThisStore =
    existingBound !== undefined &&
    existingBound.storeId === input.storeId &&
    (existingBound.status === "ready" ||
      existingBound.status === "awaiting_confirmation") &&
    isOwnedManagedWebhookUrl(
      webhookInfo.result.url,
      existingBound.webhookUrl,
    );

  let matched = alreadyBoundToThisStore;

  if (webhookInfo.result.url.length > 0 && !alreadyBoundToThisStore) {
    return { status: "bot_review" };
  }

  if (!matched) {
    const updates = await managedApi.getUpdates({
      limit: 100,
      timeout: 0,
      allowedUpdates: ["message"],
    });

    if (!updates.ok) {
      return { status: "retryable", reason: "update_fetch_failed" };
    }

    const expectedText = `/start ${nonce}`;
    matched = updates.result.some((update) => {
      const message = update.message;

      return (
        message !== undefined &&
        message.from?.id === proposal.telegramUserId &&
        message.chat.type === "private" &&
        message.chat.id === proposal.telegramUserId &&
        typeof message.text === "string" &&
        message.text.trim() === expectedText
      );
    });
  }

  if (!matched) {
    return { status: "pending" };
  }

  let encryptedToken: { ciphertext: string; keyId: string };

  try {
    encryptedToken = encryptConnectionSecret(token);
  } catch {
    return { status: "retryable", reason: "secret_storage_failed" };
  }

  type PersistResult =
    | {
        status: "verified" | "already_verified";
        attemptId: string;
        connectionId: string;
        botUsername: string;
        botName: string | null;
      }
    | {
        status:
          | "expired"
          | "conflict"
          | "bot_bound_elsewhere"
          | "bot_review";
      };

  let persisted: PersistResult;

  try {
    persisted = await db.transaction(async (tx): Promise<PersistResult> => {
      await lockConnectionStore(tx, input.storeId);

      // External Telegram calls and lock acquisition can take long enough for
      // the attempt to expire. Re-read the effective time inside the final
      // transaction and use it for every persistence decision.
      const effectiveNow = deps.now ?? new Date();

      const [current] = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          failureCode: telegramLinkAttempt.failureCode,
          connectionId: telegramLinkAttempt.connectionId,
          telegramUserId: telegramLinkAttempt.telegramUserId,
          telegramBotId: telegramLinkAttempt.telegramBotId,
          telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          telegramBotName: telegramLinkAttempt.telegramBotName,
          verifiedAt: telegramLinkAttempt.verifiedAt,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.id, proposal.attemptId),
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          ),
        )
        .limit(1);

      if (!current) return { status: "conflict" };

      if (
        current.status === "awaiting_confirmation" &&
        current.connectionId &&
        current.telegramBotUsername &&
        current.verifiedAt !== null &&
        current.failureCode !== MANAGED_BOT_START_FAILURE_CODE
      ) {
        return {
          status: "already_verified",
          attemptId: current.id,
          connectionId: current.connectionId,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
        };
      }

      if (
        current.status !== "provisioning" ||
        current.failureCode !== MANAGED_BOT_START_FAILURE_CODE ||
        current.connectionId !== null ||
        current.telegramUserId !== proposal.telegramUserId ||
        current.telegramBotId !== proposal.botId
      ) {
        return { status: "conflict" };
      }

      if (current.expiresAt.getTime() <= effectiveNow.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(
            and(
              eq(telegramLinkAttempt.id, current.id),
              eq(telegramLinkAttempt.status, "provisioning"),
            ),
          );
        return { status: "expired" };
      }

      const [existingForBot] = await tx
        .select({
          id: telegramConnection.id,
          storeId: telegramConnection.storeId,
          status: telegramConnection.status,
        })
        .from(telegramConnection)
        .where(eq(telegramConnection.botId, proposal.botId))
        .limit(1);

      if (existingForBot && existingForBot.storeId !== input.storeId) {
        await failActiveAttempt(
          tx,
          current.id,
          "bot_bound_elsewhere",
          effectiveNow,
        );
        return { status: "bot_bound_elsewhere" };
      }

      if (existingForBot?.status === "needs_review") {
        await failActiveAttempt(
          tx,
          current.id,
          "webhook_outcome_unknown",
          effectiveNow,
        );
        return { status: "bot_review" };
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
            activationAttemptId: null,
            verifiedAt: effectiveNow,
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
          storeId: input.storeId,
          botId: proposal.botId,
          botUsername: verifiedUsername,
          botName: verifiedName,
          tokenCiphertext: encryptedToken.ciphertext,
          tokenKeyId: encryptedToken.keyId,
          webhookSecretHash: hashWebhookSecret(generateWebhookSecret()),
          webhookUrl: baseWebhookUrl,
          status: "awaiting_confirmation",
          verifiedAt: effectiveNow,
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
          verifiedAt: effectiveNow,
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, current.id),
            eq(telegramLinkAttempt.status, "provisioning"),
            eq(
              telegramLinkAttempt.failureCode,
              MANAGED_BOT_START_FAILURE_CODE,
            ),
            isNull(telegramLinkAttempt.connectionId),
            gt(telegramLinkAttempt.expiresAt, effectiveNow),
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!updatedAttempt) {
        throw new RabetDataError(
          "CONFLICT",
          "The link attempt changed while verifying the bot start.",
        );
      }

      return {
        status: "verified",
        attemptId: current.id,
        connectionId,
        botUsername: verifiedUsername,
        botName: verifiedName,
      };
    });
  } catch (error) {
    if (error instanceof RabetDataError && error.code === "CONFLICT") {
      return { status: "conflict" };
    }

    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }

    return { status: "retryable", reason: "connection_persist_failed" };
  }

  if (persisted.status === "verified") {
    await sendManagedBotConfirmation(deps.transport, {
      chatId: proposal.telegramUserId,
      botName: persisted.botName,
      botUsername: persisted.botUsername,
      origin: deps.webhookOrigin,
    });
  }

  return persisted;
}


export type NotificationManagedAttemptState =
  | { state: "idle" }
  | {
      state: "waiting";
      attemptId: string;
      deepLink: string;
      expiresAt: string;
      telegramBound: boolean;
    }
  | {
      state: "awaiting_start";
      attemptId: string;
      botUsername: string;
      botName: string | null;
      verificationUrl: string;
      expiresAt: string;
    }
  | {
      state: "preparing";
      attemptId: string;
      expiresAt: string;
      botUsername?: string | null;
      botName?: string | null;
      verificationUrl?: string;
    }
  | {
      state: "expired";
      reason: string;
      retryable: boolean;
      botUsername?: string | null;
      botName?: string | null;
      resumable?: boolean;
    }
  | { state: "failed"; reason: string; retryable: boolean };

/**
 * Ensures one active notification-bot attempt for this store, independent of
 * the store-bot attempt. The two purposes have separate partial-unique indexes
 * and advisory locks, so they can coexist without overwriting each other.
 */
export async function ensureNotificationBotLinkAttempt(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    managerBotUsername: string;
    now?: Date;
  },
): Promise<EnsuredLinkAttempt> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS);
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  let encryptedNonce: { ciphertext: string; keyId: string };

  try {
    encryptedNonce = encryptConnectionSecret(nonce);
  } catch {
    return { status: "conflict" };
  }

  try {
    return await db.transaction(async (tx): Promise<EnsuredLinkAttempt> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          `${input.storeId}:notification_bot`,
        )}))`,
      );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired" })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, now),
          ),
        );

      const [ready] = await tx
        .select({
          botUsername: merchantNotificationBot.botUsername,
          botName: merchantNotificationBot.botName,
        })
        .from(merchantNotificationBot)
        .where(
          and(
            eq(merchantNotificationBot.storeId, input.storeId),
            isNotNull(merchantNotificationBot.destinationChatId),
          ),
        )
        .limit(1);

      if (ready) {
        return {
          status: "connected",
          botUsername: ready.botUsername,
          botName: ready.botName,
        } as const;
      }

      const active = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
          nonceKeyId: telegramLinkAttempt.nonceKeyId,
          telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          telegramBotName: telegramLinkAttempt.telegramBotName,
          failureCode: telegramLinkAttempt.failureCode,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt))
        .limit(1);

      const current = active[0];

      if (current?.status === "pending") {
        try {
          return {
            status: "reused",
            attemptId: current.id,
            nonce: decryptConnectionSecret(
              current.nonceCiphertext,
              current.nonceKeyId,
            ),
            expiresAt: current.expiresAt,
          } as const;
        } catch {
          return { status: "conflict" } as const;
        }
      }

      if (current?.status === "provisioning") {
        const liveNonce =
          current.failureCode === MANAGED_BOT_START_FAILURE_CODE &&
          current.telegramBotUsername
            ? attemptNonceOrNull(current.nonceCiphertext, current.nonceKeyId)
            : null;

        return {
          status: "preparing",
          attemptId: current.id,
          expiresAt: current.expiresAt,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
          verificationUrl:
            liveNonce && current.telegramBotUsername
              ? managedBotStartDeepLink(current.telegramBotUsername, liveNonce)
              : undefined,
        } as const;
      }

      if (current?.status === "awaiting_confirmation") {
        const liveNonce = attemptNonceOrNull(
          current.nonceCiphertext,
          current.nonceKeyId,
        );

        return {
          status: "preparing",
          attemptId: current.id,
          expiresAt: current.expiresAt,
          botUsername: current.telegramBotUsername,
          botName: current.telegramBotName,
          verificationUrl:
            liveNonce && current.telegramBotUsername
              ? managedBotStartDeepLink(current.telegramBotUsername, liveNonce)
              : undefined,
        } as const;
      }

      const [attempt] = await tx
        .insert(telegramLinkAttempt)
        .values({
          storeId: input.storeId,
          merchantUserId: input.merchantUserId,
          purpose: "notification_bot",
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

      return {
        status: "created",
        attemptId: attempt.id,
        nonce,
        expiresAt,
      } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "conflict" };
    throw mapDatabaseError(error);
  }
}

/** Reads the merchant-visible notification-bot onboarding progress. */
export async function readMerchantNotificationManagedAttemptState(
  db: Database,
  input: {
    storeId: string;
    merchantUserId: string;
    now?: Date;
  },
): Promise<NotificationManagedAttemptState> {
  const now = input.now ?? new Date();

  const [attempt] = await db
    .select({
      id: telegramLinkAttempt.id,
      status: telegramLinkAttempt.status,
      managerBotUsername: telegramLinkAttempt.managerBotUsername,
      nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
      nonceKeyId: telegramLinkAttempt.nonceKeyId,
      telegramUserId: telegramLinkAttempt.telegramUserId,
      telegramBotId: telegramLinkAttempt.telegramBotId,
      telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
      telegramBotName: telegramLinkAttempt.telegramBotName,
      failureCode: telegramLinkAttempt.failureCode,
      expiresAt: telegramLinkAttempt.expiresAt,
    })
    .from(telegramLinkAttempt)
    .where(
      and(
        eq(telegramLinkAttempt.storeId, input.storeId),
        eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
        eq(telegramLinkAttempt.purpose, "notification_bot"),
      ),
    )
    .orderBy(desc(telegramLinkAttempt.createdAt))
    .limit(1);

  if (!attempt) return { state: "idle" };

  const resumable =
    attempt.telegramBotId !== null &&
    attempt.telegramUserId !== null &&
    Boolean(attempt.telegramBotUsername) &&
    (attempt.status === "provisioning" || attempt.status === "expired") &&
    attempt.failureCode !== "superseded_by_manual";

  if (attempt.expiresAt.getTime() <= now.getTime()) {
    return {
      state: "expired",
      reason: "expired",
      retryable: true,
      botUsername: attempt.telegramBotUsername,
      botName: attempt.telegramBotName,
      resumable,
    };
  }

  if (attempt.status === "completed") return { state: "idle" };

  if (attempt.status === "expired") {
    return {
      state: "expired",
      reason: "expired",
      retryable: true,
      botUsername: attempt.telegramBotUsername,
      botName: attempt.telegramBotName,
      resumable,
    };
  }

  if (attempt.status === "cancelled") {
    return { state: "failed", reason: "superseded", retryable: true };
  }

  if (attempt.status === "failed") {
    return {
      state: "failed",
      reason: attempt.failureCode ?? "failed",
      retryable: true,
    };
  }

  if (attempt.status === "provisioning") {
    const nonce =
      attempt.failureCode === MANAGED_BOT_START_FAILURE_CODE &&
      attempt.telegramBotUsername
        ? attemptNonceOrNull(attempt.nonceCiphertext, attempt.nonceKeyId)
        : null;

    if (
      attempt.failureCode === MANAGED_BOT_START_FAILURE_CODE &&
      attempt.telegramBotUsername &&
      nonce
    ) {
      return {
        state: "awaiting_start",
        attemptId: attempt.id,
        botUsername: attempt.telegramBotUsername,
        botName: attempt.telegramBotName,
        verificationUrl: managedBotStartDeepLink(
          attempt.telegramBotUsername,
          nonce,
        ),
        expiresAt: attempt.expiresAt.toISOString(),
      };
    }

    return {
      state: "preparing",
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
      botUsername: attempt.telegramBotUsername,
      botName: attempt.telegramBotName,
    };
  }

  if (attempt.status === "awaiting_confirmation") {
    const nonce = attemptNonceOrNull(
      attempt.nonceCiphertext,
      attempt.nonceKeyId,
    );

    return {
      state: "preparing",
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
      botUsername: attempt.telegramBotUsername,
      botName: attempt.telegramBotName,
      verificationUrl:
        nonce && attempt.telegramBotUsername
          ? managedBotStartDeepLink(attempt.telegramBotUsername, nonce)
          : undefined,
    };
  }

  try {
    const nonce = decryptConnectionSecret(
      attempt.nonceCiphertext,
      attempt.nonceKeyId,
    );

    return {
      state: "waiting",
      attemptId: attempt.id,
      deepLink: merchantManagerDeepLink(attempt.managerBotUsername, nonce),
      expiresAt: attempt.expiresAt.toISOString(),
      telegramBound: attempt.telegramUserId !== null,
    };
  } catch {
    return { state: "failed", reason: "unavailable", retryable: true };
  }
}

type NotificationBotProposal = {
  attemptId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  telegramUserId: number;
  nonceCiphertext: string;
  nonceKeyId: string;
  expiresAt: Date;
};

export type VerifyManagedNotificationBotResult =
  | {
      status: "verified" | "already_verified";
      attemptId: string;
      botUsername: string;
      botName: string | null;
    }
  | { status: "pending" }
  | { status: "plain_start" }
  | { status: "challenge_mismatch" }
  | {
      status:
        | "not_found"
        | "expired"
        | "conflict"
        | "superseded"
        | "bot_bound_elsewhere"
        | "bot_review";
    }
  | { status: "retryable"; reason: string };

/**
 * Verifies a managed notification bot only after the bound Telegram account
 * presses Start in the new bot. The bot token is fetched from the manager bot,
 * `getMe` fixes the exact bot id, and the private Start message fixes the
 * recipient chat. Only then is the encrypted token and verified destination
 * persisted; no webhook is registered.
 */
export async function verifyManagedNotificationBotStart(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    sessionVersion: number;
    attemptId?: string | null;
  },
  deps: ManagedBotStartVerificationDependencies,
): Promise<VerifyManagedNotificationBotResult> {
  const lookupNow = deps.now ?? new Date();

  let lookup:
    | { kind: "proposal"; proposal: NotificationBotProposal }
    | { kind: "result"; result: VerifyManagedNotificationBotResult };

  try {
    lookup = await db.transaction(
      async (tx): Promise<
        | { kind: "proposal"; proposal: NotificationBotProposal }
        | { kind: "result"; result: VerifyManagedNotificationBotResult }
      > => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
            "telegram-link-attempt",
            `${input.storeId}:notification_bot`,
          )}))`,
        );

        const conditions = [
          eq(telegramLinkAttempt.storeId, input.storeId),
          eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
          eq(telegramLinkAttempt.purpose, "notification_bot"),
          inArray(telegramLinkAttempt.status, [
            ...ACTIVE_ATTEMPT_STATUSES,
            "completed",
          ]),
        ];

        if (input.attemptId) {
          conditions.push(eq(telegramLinkAttempt.id, input.attemptId));
        }

        const [attempt] = await tx
          .select({
            id: telegramLinkAttempt.id,
            status: telegramLinkAttempt.status,
            failureCode: telegramLinkAttempt.failureCode,
            connectionId: telegramLinkAttempt.connectionId,
            telegramUserId: telegramLinkAttempt.telegramUserId,
            telegramBotId: telegramLinkAttempt.telegramBotId,
            telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
            telegramBotName: telegramLinkAttempt.telegramBotName,
            nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
            nonceKeyId: telegramLinkAttempt.nonceKeyId,
            verifiedAt: telegramLinkAttempt.verifiedAt,
            expiresAt: telegramLinkAttempt.expiresAt,
          })
          .from(telegramLinkAttempt)
          .where(and(...conditions))
          .orderBy(desc(telegramLinkAttempt.createdAt))
          .limit(1);

        if (!attempt) {
          return { kind: "result", result: { status: "not_found" } };
        }

        if (attempt.status === "completed") {
          const [existing] = await tx
            .select({ id: merchantNotificationBot.id })
            .from(merchantNotificationBot)
            .where(
              and(
                eq(merchantNotificationBot.storeId, input.storeId),
                eq(merchantNotificationBot.botId, attempt.telegramBotId ?? 0),
              ),
            )
            .limit(1);

          if (existing && attempt.telegramBotUsername) {
            return {
              kind: "result",
              result: {
                status: "already_verified",
                attemptId: attempt.id,
                botUsername: attempt.telegramBotUsername,
                botName: attempt.telegramBotName,
              },
            };
          }
        }

        if (
          attempt.status !== "provisioning" ||
          attempt.failureCode !== MANAGED_BOT_START_FAILURE_CODE ||
          attempt.connectionId !== null ||
          attempt.telegramUserId === null ||
          attempt.telegramBotId === null ||
          !attempt.telegramBotUsername
        ) {
          return { kind: "result", result: { status: "not_found" } };
        }

        if (attempt.expiresAt.getTime() <= lookupNow.getTime()) {
          await tx
            .update(telegramLinkAttempt)
            .set({ status: "expired", failureCode: "expired" })
            .where(
              and(
                eq(telegramLinkAttempt.id, attempt.id),
                eq(telegramLinkAttempt.status, "provisioning"),
              ),
            );
          return { kind: "result", result: { status: "expired" } };
        }

        return {
          kind: "proposal",
          proposal: {
            attemptId: attempt.id,
            botId: attempt.telegramBotId,
            botUsername: attempt.telegramBotUsername,
            botName: attempt.telegramBotName,
            telegramUserId: attempt.telegramUserId,
            nonceCiphertext: attempt.nonceCiphertext,
            nonceKeyId: attempt.nonceKeyId,
            expiresAt: attempt.expiresAt,
          },
        };
      },
    );
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (lookup.kind === "result") return lookup.result;

  const { proposal } = lookup;
  const nonce = attemptNonceOrNull(
    proposal.nonceCiphertext,
    proposal.nonceKeyId,
  );

  if (!nonce) return { status: "retryable", reason: "secret_unavailable" };

  const tokenResult = await deps.managerApi.getManagedBotToken(proposal.botId);

  if (!tokenResult.ok || typeof tokenResult.result !== "string") {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  const token = tokenResult.result.trim();

  if (token.length === 0) {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  let managedApi: TelegramBotApiClient;

  try {
    managedApi =
      deps.createBotApi?.(token) ?? createTelegramBotApiClient(token);
  } catch {
    return { status: "retryable", reason: "api_unavailable" };
  }

  const me = await managedApi.getMe();

  if (
    !me.ok ||
    me.result.id !== proposal.botId ||
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    me.result.username.length === 0
  ) {
    return { status: "retryable", reason: "verification_failed" };
  }

  const verifiedUsername = me.result.username;
  const verifiedName =
    typeof me.result.first_name === "string" ? me.result.first_name : null;

  const webhookInfo = await managedApi.getWebhookInfo();

  if (!webhookInfo.ok) {
    return { status: "retryable", reason: "webhook_inspection_failed" };
  }

  if (webhookInfo.result.url.length > 0) {
    return { status: "bot_review" };
  }

  const updates = await managedApi.getUpdates({
    limit: 100,
    timeout: 0,
    allowedUpdates: ["message"],
  });

  if (!updates.ok) {
    return { status: "retryable", reason: "update_fetch_failed" };
  }

  const expectedText = `/start ${nonce}`;
  let destination: {
    chatId: string;
    title: string | null;
    username: string | null;
  } | null = null;
  let sawPlainStart = false;
  let sawChallengeMismatch = false;

  for (const update of updates.result) {
    const message = update.message;

    if (
      !message ||
      message.from?.id !== proposal.telegramUserId ||
      message.chat.type !== "private" ||
      message.chat.id !== proposal.telegramUserId ||
      typeof message.text !== "string"
    ) {
      continue;
    }

    const text = message.text.trim();

    if (text !== expectedText) {
      if (text === "/start") {
        sawPlainStart = true;
      } else if (text.startsWith("/start ")) {
        sawChallengeMismatch = true;
      }

      continue;
    }

    const fromName = [message.from?.first_name, message.from?.last_name]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim();
    const title =
      message.chat.title ??
      (fromName.length > 0 ? fromName : null) ??
      message.chat.first_name ??
      null;

    destination = {
      chatId: String(message.chat.id),
      title,
      username: message.chat.username ?? message.from?.username ?? null,
    };
    break;
  }

  if (!destination) {
    if (sawPlainStart) return { status: "plain_start" };
    if (sawChallengeMismatch) return { status: "challenge_mismatch" };
    return { status: "pending" };
  }

  let encryptedToken: { ciphertext: string; keyId: string };

  try {
    encryptedToken = encryptConnectionSecret(token);
  } catch {
    return { status: "retryable", reason: "secret_storage_failed" };
  }

  type PersistResult =
    | {
        status: "verified" | "already_verified";
        attemptId: string;
        botUsername: string;
        botName: string | null;
      }
    | {
        status:
          | "expired"
          | "conflict"
          | "superseded"
          | "bot_bound_elsewhere"
          | "bot_review";
      };

  let persisted: PersistResult;

  try {
    persisted = await db.transaction(async (tx): Promise<PersistResult> => {
      const effectiveNow = deps.now ?? new Date();

      await lockNotificationBotOnboarding(
        tx as unknown as Database,
        input.storeId,
      );

      const eligibility = await resolveMerchantEligibility(
        tx as unknown as TransactionDatabase,
        {
          userId: input.merchantUserId,
          sessionVersion: input.sessionVersion,
        },
      );

      if (
        !eligibility ||
        eligibility.readOnly ||
        eligibility.store.id !== input.storeId
      ) {
        return { status: "conflict" };
      }

      const [current] = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          failureCode: telegramLinkAttempt.failureCode,
          connectionId: telegramLinkAttempt.connectionId,
          telegramUserId: telegramLinkAttempt.telegramUserId,
          telegramBotId: telegramLinkAttempt.telegramBotId,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.id, proposal.attemptId),
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
          ),
        )
        .limit(1);

      if (!current) return { status: "conflict" };

      if (
        current.status === "cancelled" ||
        current.failureCode === "superseded_by_manual"
      ) {
        return { status: "superseded" };
      }

      if (
        current.status !== "provisioning" ||
        current.failureCode !== MANAGED_BOT_START_FAILURE_CODE ||
        current.connectionId !== null ||
        current.telegramUserId !== proposal.telegramUserId ||
        current.telegramBotId !== proposal.botId
      ) {
        return { status: "conflict" };
      }

      if (current.expiresAt.getTime() <= effectiveNow.getTime()) {
        return { status: "expired" };
      }

      const [existingStoreBot] = await tx
        .select({ id: telegramConnection.id })
        .from(telegramConnection)
        .where(eq(telegramConnection.botId, proposal.botId))
        .limit(1);

      if (existingStoreBot) {
        await failActiveAttempt(
          tx,
          current.id,
          "bot_purpose_conflict",
          effectiveNow,
        );
        return { status: "bot_bound_elsewhere" };
      }

      const [existingNotificationBot] = await tx
        .select({
          id: merchantNotificationBot.id,
          storeId: merchantNotificationBot.storeId,
        })
        .from(merchantNotificationBot)
        .where(eq(merchantNotificationBot.botId, proposal.botId))
        .limit(1);

      if (
        existingNotificationBot &&
        existingNotificationBot.storeId !== input.storeId
      ) {
        await failActiveAttempt(
          tx,
          current.id,
          "bot_bound_elsewhere",
          effectiveNow,
        );
        return { status: "bot_bound_elsewhere" };
      }

      await saveManagedMerchantNotificationBot(
        tx as unknown as Database,
        {
          storeId: input.storeId,
          botId: proposal.botId,
          botUsername: verifiedUsername,
          botName: verifiedName,
          tokenCiphertext: encryptedToken.ciphertext,
          tokenKeyId: encryptedToken.keyId,
          destinationChatId: destination.chatId,
          destinationChatTitle: destination.title,
          destinationChatUsername: destination.username,
          now: effectiveNow,
        },
      );

      const [updatedAttempt] = await tx
        .update(telegramLinkAttempt)
        .set({
          status: "completed",
          telegramBotUsername: verifiedUsername,
          telegramBotName: verifiedName,
          failureCode: null,
          verifiedAt: effectiveNow,
          completedAt: effectiveNow,
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, current.id),
            eq(telegramLinkAttempt.status, "provisioning"),
            eq(
              telegramLinkAttempt.failureCode,
              MANAGED_BOT_START_FAILURE_CODE,
            ),
            isNull(telegramLinkAttempt.connectionId),
            gt(telegramLinkAttempt.expiresAt, effectiveNow),
          ),
        )
        .returning({ id: telegramLinkAttempt.id });

      if (!updatedAttempt) {
        throw new RabetDataError(
          "CONFLICT",
          "The notification bot attempt changed while verifying its Start.",
        );
      }

      return {
        status: "verified",
        attemptId: current.id,
        botUsername: verifiedUsername,
        botName: verifiedName,
      };
    });
  } catch (error) {
    if (error instanceof RabetDataError && error.code === "CONFLICT") {
      return { status: "conflict" };
    }

    if (isUniqueViolation(error)) {
      return { status: "bot_bound_elsewhere" };
    }

    return { status: "retryable", reason: "notification_bot_persist_failed" };
  }

  if (persisted.status === "verified") {
    await sendManagedNotificationBotConfirmation(deps.transport, {
      chatId: proposal.telegramUserId,
      botName: persisted.botName,
      botUsername: persisted.botUsername,
      origin: deps.webhookOrigin,
    });
  }

  return persisted;
}

export type ResumeManagedNotificationBotResult =
  | {
      status: "resumed";
      attemptId: string;
      nonce: string;
      expiresAt: Date;
      botUsername: string;
      botName: string | null;
    }
  | { status: "none" }
  | { status: "connected"; botUsername: string; botName: string | null }
  | {
      status: "conflict" | "bot_review" | "bot_bound_elsewhere" | "retryable";
      reason?: string;
    };

type ResumableNotificationProposal = {
  attemptId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  telegramUserId: number;
  expiresAt: Date;
};

/**
 * Resumes a previously correlated notification-bot proposal whose challenge
 * window ended.
 *
 * The proposal's stored numeric bot id, creator and notification purpose are
 * reused. The exact bot is re-read through the current manager API and
 * `getMe`, the webhook must still be empty, and the merchant session/store plus
 * manual-wins state are rechecked before a new short-lived private-chat Start
 * challenge is created. This never creates a bot and never trusts the old
 * challenge, a username, or a plain Start as proof.
 */
export async function resumeManagedNotificationBotProposal(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    sessionVersion: number;
    managerBotUsername: string;
  },
  deps: ManagedBotStartVerificationDependencies,
): Promise<ResumeManagedNotificationBotResult> {
  const lookupNow = deps.now ?? new Date();

  type Lookup =
    | { kind: "proposal"; proposal: ResumableNotificationProposal }
    | { kind: "result"; result: ResumeManagedNotificationBotResult };

  let lookup: Lookup;

  try {
    lookup = await db.transaction(async (tx): Promise<Lookup> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          `${input.storeId}:notification_bot`,
        )}))`,
      );

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "expired", failureCode: "expired", updatedAt: lookupNow })
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            lte(telegramLinkAttempt.expiresAt, lookupNow),
          ),
        );

      const [configured] = await tx
        .select({
          botUsername: merchantNotificationBot.botUsername,
          botName: merchantNotificationBot.botName,
          destinationChatId: merchantNotificationBot.destinationChatId,
        })
        .from(merchantNotificationBot)
        .where(eq(merchantNotificationBot.storeId, input.storeId))
        .limit(1);

      if (configured) {
        if (configured.destinationChatId !== null) {
          return {
            kind: "result",
            result: {
              status: "connected",
              botUsername: configured.botUsername,
              botName: configured.botName,
            },
          };
        }

        // A manual token/pairing configuration is the newer intention and
        // must win over a managed proposal.
        return {
          kind: "result",
          result: { status: "conflict", reason: "manual_configuration" },
        };
      }

      const [live] = await tx
        .select({ id: telegramLinkAttempt.id })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            gt(telegramLinkAttempt.expiresAt, lookupNow),
          ),
        )
        .limit(1);

      if (live) return { kind: "result", result: { status: "none" } };

      const [latest] = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          failureCode: telegramLinkAttempt.failureCode,
          telegramUserId: telegramLinkAttempt.telegramUserId,
          telegramBotId: telegramLinkAttempt.telegramBotId,
          telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          telegramBotName: telegramLinkAttempt.telegramBotName,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
            eq(telegramLinkAttempt.purpose, "notification_bot"),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt))
        .limit(1);

      if (
        !latest ||
        latest.status !== "expired" ||
        latest.failureCode === "superseded_by_manual" ||
        latest.telegramUserId === null ||
        latest.telegramBotId === null ||
        !latest.telegramBotUsername
      ) {
        return { kind: "result", result: { status: "none" } };
      }

      return {
        kind: "proposal",
        proposal: {
          attemptId: latest.id,
          botId: latest.telegramBotId,
          botUsername: latest.telegramBotUsername,
          botName: latest.telegramBotName,
          telegramUserId: latest.telegramUserId,
          expiresAt: latest.expiresAt,
        },
      };
    });
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (lookup.kind === "result") return lookup.result;

  const { proposal } = lookup;
  const tokenResult = await deps.managerApi.getManagedBotToken(proposal.botId);

  if (!tokenResult.ok || typeof tokenResult.result !== "string") {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  const token = tokenResult.result.trim();

  if (token.length === 0) {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  let managedApi: TelegramBotApiClient;

  try {
    managedApi =
      deps.createBotApi?.(token) ?? createTelegramBotApiClient(token);
  } catch {
    return { status: "retryable", reason: "api_unavailable" };
  }

  const me = await managedApi.getMe();

  if (
    !me.ok ||
    me.result.id !== proposal.botId ||
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    me.result.username.length === 0
  ) {
    return { status: "retryable", reason: "verification_failed" };
  }

  const verifiedUsername = me.result.username;
  const verifiedName =
    typeof me.result.first_name === "string" ? me.result.first_name : null;

  const webhookInfo = await managedApi.getWebhookInfo();

  if (!webhookInfo.ok) {
    return { status: "retryable", reason: "webhook_inspection_failed" };
  }

  if (webhookInfo.result.url.length > 0) {
    return { status: "bot_review" };
  }

  const challengeNow = deps.now ?? new Date();
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  const expiresAt = new Date(
    challengeNow.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS,
  );

  let encryptedNonce: { ciphertext: string; keyId: string };

  try {
    encryptedNonce = encryptConnectionSecret(nonce);
  } catch {
    return { status: "retryable", reason: "secret_storage_failed" };
  }

  try {
    return await db.transaction(
      async (tx): Promise<ResumeManagedNotificationBotResult> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
            "telegram-link-attempt",
            `${input.storeId}:notification_bot`,
          )}))`,
        );

        const eligibility = await resolveMerchantEligibility(
          tx as unknown as TransactionDatabase,
          {
            userId: input.merchantUserId,
            sessionVersion: input.sessionVersion,
          },
        );

        if (
          !eligibility ||
          eligibility.readOnly ||
          eligibility.store.id !== input.storeId
        ) {
          return { status: "conflict", reason: "session_changed" };
        }

        const [configured] = await tx
          .select({
            botUsername: merchantNotificationBot.botUsername,
            botName: merchantNotificationBot.botName,
            destinationChatId: merchantNotificationBot.destinationChatId,
          })
          .from(merchantNotificationBot)
          .where(eq(merchantNotificationBot.storeId, input.storeId))
          .limit(1);

        if (configured) {
          if (configured.destinationChatId !== null) {
            return {
              status: "connected",
              botUsername: configured.botUsername,
              botName: configured.botName,
            };
          }

          return { status: "conflict", reason: "manual_configuration" };
        }

        const [live] = await tx
          .select({ id: telegramLinkAttempt.id })
          .from(telegramLinkAttempt)
          .where(
            and(
              eq(telegramLinkAttempt.storeId, input.storeId),
              eq(telegramLinkAttempt.purpose, "notification_bot"),
              inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
              gt(telegramLinkAttempt.expiresAt, challengeNow),
            ),
          )
          .limit(1);

        if (live) return { status: "none" };

        const [latest] = await tx
          .select({
            id: telegramLinkAttempt.id,
            status: telegramLinkAttempt.status,
            failureCode: telegramLinkAttempt.failureCode,
            telegramUserId: telegramLinkAttempt.telegramUserId,
            telegramBotId: telegramLinkAttempt.telegramBotId,
            telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          })
          .from(telegramLinkAttempt)
          .where(
            and(
              eq(telegramLinkAttempt.storeId, input.storeId),
              eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
              eq(telegramLinkAttempt.purpose, "notification_bot"),
            ),
          )
          .orderBy(desc(telegramLinkAttempt.createdAt))
          .limit(1);

        if (
          !latest ||
          latest.id !== proposal.attemptId ||
          latest.status !== "expired" ||
          latest.failureCode === "superseded_by_manual" ||
          latest.telegramUserId !== proposal.telegramUserId ||
          latest.telegramBotId !== proposal.botId
        ) {
          return { status: "none" };
        }

        const [existingStoreBot] = await tx
          .select({ id: telegramConnection.id })
          .from(telegramConnection)
          .where(eq(telegramConnection.botId, proposal.botId))
          .limit(1);

        if (existingStoreBot) {
          return { status: "bot_bound_elsewhere", reason: "store_bot_conflict" };
        }

        const [existingNotificationBot] = await tx
          .select({
            id: merchantNotificationBot.id,
            storeId: merchantNotificationBot.storeId,
          })
          .from(merchantNotificationBot)
          .where(eq(merchantNotificationBot.botId, proposal.botId))
          .limit(1);

        if (
          existingNotificationBot &&
          existingNotificationBot.storeId !== input.storeId
        ) {
          return {
            status: "bot_bound_elsewhere",
            reason: "notification_bot_conflict",
          };
        }

        const [attempt] = await tx
          .insert(telegramLinkAttempt)
          .values({
            storeId: input.storeId,
            merchantUserId: input.merchantUserId,
            purpose: "notification_bot",
            managerBotUsername: input.managerBotUsername,
            nonceDigest,
            nonceCiphertext: encryptedNonce.ciphertext,
            nonceKeyId: encryptedNonce.keyId,
            status: "provisioning",
            telegramUserId: proposal.telegramUserId,
            telegramBotId: proposal.botId,
            telegramBotUsername: verifiedUsername,
            telegramBotName: verifiedName,
            failureCode: MANAGED_BOT_START_FAILURE_CODE,
            expiresAt,
            createdAt: challengeNow,
            updatedAt: challengeNow,
          })
          .returning({ id: telegramLinkAttempt.id });

        return {
          status: "resumed",
          attemptId: attempt.id,
          nonce,
          expiresAt,
          botUsername: verifiedUsername,
          botName: verifiedName,
        };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "conflict" };
    throw mapDatabaseError(error);
  }
}

export function managedNotificationBotConfirmationCopy(input: {
  botName: string | null;
  botUsername: string;
  origin: string;
}): { text: string; replyMarkup: { inline_keyboard: { text: string; url: string }[][] } } {
  const displayName = input.botName?.trim() || input.botUsername;

  return {
    text:
      `تم إنشاء بوت إشعارات متجرك بنجاح:\n` +
      `${displayName}\n` +
      `@${input.botUsername}\n\n` +
      "ارجع إلى نكمل لإرسال إشعار تجريبي.\n" +
      "Your notification bot is ready. Return to Nokmel to send a test.",
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: "العودة إلى نكمل / Return to Nokmel",
            url: `${input.origin.replace(/\/+$/, "")}/app/setup`,
          },
        ],
      ],
    },
  };
}

async function sendManagedNotificationBotConfirmation(
  transport: TelegramTransport | undefined,
  input: {
    chatId: number;
    botName: string | null;
    botUsername: string;
    origin: string;
  },
): Promise<void> {
  if (!transport) return;

  try {
    const copy = managedNotificationBotConfirmationCopy(input);
    const result = await transport.sendMessage({
      chatId: input.chatId,
      text: copy.text,
      replyMarkup: copy.replyMarkup,
    });

    if (!result.ok) {
      console.error("[manager-bot] notification confirmation failed", {
        category: result.errorKind ?? "unknown",
      });
    }
  } catch {
    console.error("[manager-bot] notification confirmation failed", {
      category: "exception",
    });
  }
}

export type RecoveryDependencies = {
  managerApi: TelegramBotApiClient;
  createBotApi?: (token: string) => TelegramBotApiClient;
  transport?: TelegramTransport;
  webhookOrigin: string;
  now?: Date;
};

export type RecoverCandidateResult =
  | {
      status: "recovered" | "already_candidate";
      attemptId: string;
      connectionId: string;
      botUsername: string;
      botName: string | null;
    }
  | { status: "not_found" | "conflict" | "bot_bound_elsewhere" }
  | { status: "retryable"; reason: string };

/**
 * Re-opens an already-created bot for merchant confirmation.
 *
 * The bot id and creator come only from a stored `managed_bot` correlation for
 * this exact store. Before anything is changed, the manager bot re-fetches the
 * bot token and the bot's own `getMe`; the old username or display name is
 * never used as the ownership proof. The connection is not activated here.
 */
export async function recoverManagedTelegramCandidate(
  db: TransactionDatabase,
  input: {
    storeId: string;
    merchantUserId: string;
    connectionId?: string | null;
    attemptId?: string | null;
  },
  deps: RecoveryDependencies,
): Promise<RecoverCandidateResult> {
  const now = deps.now ?? new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS);
  const nonce = generateLinkNonce();
  const nonceDigest = hashLinkNonce(nonce);
  let encryptedNonce: { ciphertext: string; keyId: string };

  try {
    encryptedNonce = encryptConnectionSecret(nonce);
  } catch {
    return { status: "retryable", reason: "secret_storage_failed" };
  }

  let evidence: RecoverableCandidateEvidence | null = null;
  let already: RecoverCandidateResult | null = null;

  try {
    const found = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
          "telegram-link-attempt",
          `${input.storeId}:store_bot`,
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

      const [ready] = await tx
        .select({ id: telegramConnection.id })
        .from(telegramConnection)
        .where(
          and(
            eq(telegramConnection.storeId, input.storeId),
            eq(telegramConnection.status, "ready"),
          ),
        )
        .limit(1);

      if (ready) return { status: "conflict" } as const;

      const active = await tx
        .select({
          id: telegramLinkAttempt.id,
          status: telegramLinkAttempt.status,
          connectionId: telegramLinkAttempt.connectionId,
          telegramBotUsername: telegramLinkAttempt.telegramBotUsername,
          telegramBotName: telegramLinkAttempt.telegramBotName,
          expiresAt: telegramLinkAttempt.expiresAt,
        })
        .from(telegramLinkAttempt)
        .where(
          and(
            eq(telegramLinkAttempt.storeId, input.storeId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
          ),
        )
        .orderBy(desc(telegramLinkAttempt.createdAt));

      if (active.length > 1) return { status: "conflict" } as const;

      const current = active[0];

      if (current) {
        if (
          current.status === "awaiting_confirmation" &&
          current.connectionId &&
          current.telegramBotUsername
        ) {
          if (
            (input.connectionId &&
              input.connectionId !== current.connectionId) ||
            (input.attemptId && input.attemptId !== current.id)
          ) {
            return { status: "not_found" } as const;
          }

          return {
            status: "already_candidate",
            attemptId: current.id,
            connectionId: current.connectionId,
            botUsername: current.telegramBotUsername,
            botName: current.telegramBotName,
          } as const;
        }

        if (current.status !== "pending") {
          return { status: "conflict" } as const;
        }
      }

      const candidate = await findRecoverableCandidateEvidence(tx, {
        ...input,
        now,
      });

      if (!candidate) return { status: "not_found" } as const;

      if (
        (input.connectionId &&
          candidate.connectionId !== input.connectionId) ||
        (input.attemptId && candidate.attemptId !== input.attemptId)
      ) {
        return { status: "not_found" } as const;
      }

      return candidate;
    });

    if ("status" in found) {
      if (found.status === "already_candidate") already = found;
      else return found;
    } else {
      evidence = found;
    }
  } catch (error) {
    throw mapDatabaseError(error);
  }

  if (already) return already;
  if (!evidence) return { status: "not_found" };

  const tokenResult = await deps.managerApi.getManagedBotToken(evidence.botId);

  if (!tokenResult.ok || typeof tokenResult.result !== "string") {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  const token = tokenResult.result.trim();

  if (token.length === 0) {
    return { status: "retryable", reason: "token_fetch_failed" };
  }

  let managedApi: TelegramBotApiClient;

  try {
    managedApi =
      deps.createBotApi?.(token) ?? createTelegramBotApiClient(token);
  } catch {
    return { status: "retryable", reason: "api_unavailable" };
  }

  const me = await managedApi.getMe();

  if (
    !me.ok ||
    me.result.id !== evidence.botId ||
    me.result.is_bot !== true ||
    typeof me.result.username !== "string" ||
    me.result.username.length === 0
  ) {
    return { status: "retryable", reason: "verification_failed" };
  }

  const verifiedUsername = me.result.username;
  const verifiedName =
    typeof me.result.first_name === "string" ? me.result.first_name : null;

  let encryptedToken: { ciphertext: string; keyId: string };

  try {
    encryptedToken = encryptConnectionSecret(token);
  } catch {
    return { status: "retryable", reason: "secret_storage_failed" };
  }

  let recovered: RecoverCandidateResult;

  try {
    recovered = await db.transaction(
      async (tx): Promise<RecoverCandidateResult> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${advisoryLockKey(
            "telegram-link-attempt",
            `${input.storeId}:store_bot`,
          )}))`,
        );

        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(
            and(
              eq(telegramLinkAttempt.storeId, input.storeId),
              eq(telegramLinkAttempt.purpose, "store_bot"),
              inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
              lte(telegramLinkAttempt.expiresAt, now),
            ),
          );

        const [ready] = await tx
          .select({ id: telegramConnection.id })
          .from(telegramConnection)
          .where(
            and(
              eq(telegramConnection.storeId, input.storeId),
              eq(telegramConnection.status, "ready"),
            ),
          )
          .limit(1);

        if (ready) return { status: "conflict" };

        const active = await tx
          .select({
            id: telegramLinkAttempt.id,
            status: telegramLinkAttempt.status,
          })
          .from(telegramLinkAttempt)
          .where(
            and(
              eq(telegramLinkAttempt.storeId, input.storeId),
              eq(telegramLinkAttempt.purpose, "store_bot"),
              inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            ),
          );

        if (active.some((attempt) => attempt.status !== "pending")) {
          return { status: "conflict" };
        }

        // A stale Create tap may have left a non-candidate pending attempt.
        // A verified bot is stronger evidence; retire the pending nonce so a
        // late creation from it cannot compete with the recovered bot.
        if (active.length > 0) {
          await tx
            .update(telegramLinkAttempt)
            .set({
              status: "cancelled",
              failureCode: "recovered_existing_bot",
              updatedAt: now,
            })
            .where(
              and(
                eq(telegramLinkAttempt.storeId, input.storeId),
                eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
                eq(telegramLinkAttempt.purpose, "store_bot"),
                eq(telegramLinkAttempt.status, "pending"),
              ),
            );
        }

        const current = await findRecoverableCandidateEvidence(tx, {
          ...input,
          now,
        });

        if (
          !current ||
          current.attemptId !== evidence.attemptId ||
          current.botId !== evidence.botId
        ) {
          return { status: "conflict" };
        }

        const [boundElsewhere] = await tx
          .select({
            id: telegramConnection.id,
            storeId: telegramConnection.storeId,
          })
          .from(telegramConnection)
          .where(eq(telegramConnection.botId, evidence.botId))
          .limit(1);

        if (boundElsewhere && boundElsewhere.storeId !== input.storeId) {
          return { status: "bot_bound_elsewhere" };
        }

        let connectionId = evidence.connectionId;

        if (connectionId) {
          const [updated] = await tx
            .update(telegramConnection)
            .set({
              botUsername: verifiedUsername,
              botName: verifiedName,
              tokenCiphertext: encryptedToken.ciphertext,
              tokenKeyId: encryptedToken.keyId,
              status: "awaiting_confirmation",
              activationAttemptId: null,
              webhookOperationId: null,
              webhookOperationAttemptId: null,
              webhookOperationExpiresAt: null,
              verifiedAt: now,
            })
            .where(
              and(
                eq(telegramConnection.id, connectionId),
                eq(telegramConnection.storeId, input.storeId),
                eq(telegramConnection.botId, evidence.botId),
                inArray(telegramConnection.status, [
                  "awaiting_confirmation",
                  "revoked",
                ]),
              ),
            )
            .returning({ id: telegramConnection.id });

          if (!updated) return { status: "conflict" };
        } else {
          connectionId = crypto.randomUUID();

          await tx.insert(telegramConnection).values({
            id: connectionId,
            storeId: input.storeId,
            botId: evidence.botId,
            botUsername: verifiedUsername,
            botName: verifiedName,
            tokenCiphertext: encryptedToken.ciphertext,
            tokenKeyId: encryptedToken.keyId,
            webhookSecretHash: hashWebhookSecret(generateWebhookSecret()),
            webhookUrl: buildManagedWebhookUrl(
              deps.webhookOrigin,
              connectionId,
            ),
            status: "awaiting_confirmation",
            verifiedAt: now,
          });
        }

        const [attempt] = await tx
          .insert(telegramLinkAttempt)
          .values({
            storeId: input.storeId,
            merchantUserId: input.merchantUserId,
            purpose: "store_bot",
            managerBotUsername: evidence.managerBotUsername,
            nonceDigest,
            nonceCiphertext: encryptedNonce.ciphertext,
            nonceKeyId: encryptedNonce.keyId,
            status: "awaiting_confirmation",
            telegramUserId: evidence.telegramUserId,
            telegramBotId: evidence.botId,
            telegramBotUsername: verifiedUsername,
            telegramBotName: verifiedName,
            connectionId,
            verifiedAt: now,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: telegramLinkAttempt.id });

        return {
          status: "recovered",
          attemptId: attempt.id,
          connectionId,
          botUsername: verifiedUsername,
          botName: verifiedName,
        };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "conflict" };
    }

    return {
      status: "retryable",
      reason: "connection_persist_failed",
    };
  }

  if (recovered.status === "recovered") {
    await sendManagedBotConfirmation(deps.transport, {
      chatId: evidence.telegramUserId,
      botName: recovered.botName,
      botUsername: recovered.botUsername,
      origin: deps.webhookOrigin,
    });
  }

  return recovered;
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
  | { status: "review" }
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
      operationId: string;
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

function activationUrl(baseWebhookUrl: string, activationAttemptId: string): string {
  const url = new URL(baseWebhookUrl);
  url.searchParams.set("v", activationAttemptId);
  return url.toString();
}

/**
 * A webhook URL belongs to this Nokmel connection when its origin and path
 * match the persisted per-connection endpoint. The `v` value is the durable
 * activation attempt id, used for diagnostics and exact-URL observation.
 * It is never the only guard: all state writes are fenced by activation and
 * operation identity, and no stale path deletes a webhook.
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

/**
 * Renews the per-bot operation lease and proves the activation still owns the
 * connection and the attempt is still awaiting confirmation. Called immediately
 * before every external webhook mutation.
 */
async function renewWebhookOperation(
  db: TransactionDatabase,
  input: {
    attemptId: string;
    connectionId: string;
    operationId: string;
    now: Date;
  },
): Promise<boolean> {
  const nextExpiry = new Date(input.now.getTime() + WEBHOOK_OPERATION_LEASE_MS);

  try {
    const [row] = await db
      .update(telegramConnection)
      .set({ webhookOperationExpiresAt: nextExpiry })
      .where(
        and(
          eq(telegramConnection.id, input.connectionId),
          eq(telegramConnection.status, "provisioning"),
          eq(telegramConnection.activationAttemptId, input.attemptId),
          eq(telegramConnection.webhookOperationId, input.operationId),
          eq(telegramConnection.webhookOperationAttemptId, input.attemptId),
          gt(telegramConnection.webhookOperationExpiresAt, input.now),
          sql`exists (
            select 1 from "telegram_link_attempt" a
            where a."id" = ${input.attemptId}::uuid
              and a."status" = 'awaiting_confirmation'
              and a."expires_at" > ${input.now.toISOString()}::timestamptz
          )`,
        ),
      )
      .returning({ id: telegramConnection.id });

    return Boolean(row);
  } catch {
    return false;
  }
}

async function releaseActivationClaim(
  db: TransactionDatabase,
  input: {
    attemptId: string;
    connectionId: string;
    operationId: string;
    reason: string;
    now: Date;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Clear exactly this operation lease. A newer operation has a different
      // id and is never touched.
      const [released] = await tx
        .update(telegramConnection)
        .set({
          webhookOperationId: null,
          webhookOperationAttemptId: null,
          webhookOperationExpiresAt: null,
        })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.webhookOperationId, input.operationId),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!released) return;

      const [downgraded] = await tx
        .update(telegramConnection)
        .set({
          status: "awaiting_confirmation",
          activationAttemptId: null,
        })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.status, "provisioning"),
            eq(telegramConnection.activationAttemptId, input.attemptId),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!downgraded) return;

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
    operationId: string;
    reason: string;
    connectionStatus: "needs_review" | "revoked";
    now: Date;
  },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [released] = await tx
        .update(telegramConnection)
        .set({
          webhookOperationId: null,
          webhookOperationAttemptId: null,
          webhookOperationExpiresAt: null,
        })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.webhookOperationId, input.operationId),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!released) return;

      const [terminal] = await tx
        .update(telegramConnection)
        .set({ status: input.connectionStatus })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.status, "provisioning"),
            eq(telegramConnection.activationAttemptId, input.attemptId),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!terminal) return;

      await tx
        .update(telegramLinkAttempt)
        .set({ status: "failed", failureCode: input.reason })
        .where(
          and(
            eq(telegramLinkAttempt.id, input.attemptId),
            inArray(telegramLinkAttempt.status, [...ACTIVE_ATTEMPT_STATUSES]),
            gt(telegramLinkAttempt.expiresAt, input.now),
          ),
        );
    });
  } catch {
    // Preserve the original terminal decision.
  }
}

async function markActivationUncertain(
  db: TransactionDatabase,
  input: {
    attemptId: string;
    connectionId: string;
    operationId: string;
    now: Date;
  },
): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      const [reviewed] = await tx
        .update(telegramConnection)
        .set({ status: "needs_review" })
        .where(
          and(
            eq(telegramConnection.id, input.connectionId),
            eq(telegramConnection.status, "provisioning"),
            eq(telegramConnection.activationAttemptId, input.attemptId),
            eq(telegramConnection.webhookOperationId, input.operationId),
            eq(
              telegramConnection.webhookOperationAttemptId,
              input.attemptId,
            ),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!reviewed) return false;

      await tx
        .update(telegramLinkAttempt)
        .set({
          status: "failed",
          failureCode: "webhook_outcome_unknown",
        })
        .where(
          and(
            eq(telegramLinkAttempt.id, input.attemptId),
            eq(telegramLinkAttempt.status, "awaiting_confirmation"),
            gt(telegramLinkAttempt.expiresAt, input.now),
          ),
        );

      return true;
    });
  } catch {
    return false;
  }
}

/**
 * A confirmed Telegram HTTP rejection means the request is known not to have
 * been applied. Timeouts, transport errors and 5xx responses are ambiguous and
 * must keep the same bot in review rather than retrying blindly.
 */
function isExplicitWebhookRejection(result: {
  errorKind?: string;
  httpStatus?: number;
}): boolean {
  if (result.errorKind === "rate_limited") return true;
  if (result.errorKind === "blocked") return true;

  return (
    result.errorKind === "api_error" &&
    typeof result.httpStatus === "number" &&
    result.httpStatus >= 400 &&
    result.httpStatus < 500
  );
}

/**
 * Starts external activation only after the signed-in merchant confirms the
 * verified bot.
 *
 * A durable operation lease serializes all webhook mutations per bot. The
 * claim, lease renewal, commit, release and terminal writes are all fenced by
 * the confirmed attempt id and operation id, so a stale same-bot activation
 * cannot alter a newer connection or regress a newer ready state.
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
          attemptVerifiedAt: telegramLinkAttempt.verifiedAt,
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

      if (row.attemptVerifiedAt === null) {
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
        (row.connectionStatus !== "awaiting_confirmation" &&
          row.connectionStatus !== "provisioning") ||
        row.attemptStatus !== "awaiting_confirmation"
      ) {
        return { status: "conflict" } as const;
      }

      if (row.expiresAt.getTime() <= now.getTime()) {
        await tx
          .update(telegramLinkAttempt)
          .set({ status: "expired", failureCode: "expired" })
          .where(
            and(
              eq(telegramLinkAttempt.id, row.attemptId),
              eq(telegramLinkAttempt.status, "awaiting_confirmation"),
            ),
          );
        return { status: "expired" } as const;
      }

      const operationId = crypto.randomUUID();
      const operationExpiresAt = new Date(
        now.getTime() + WEBHOOK_OPERATION_LEASE_MS,
      );

      const [claimedConnection] = await tx
        .update(telegramConnection)
        .set({
          status: "provisioning",
          activationAttemptId: row.attemptId,
          webhookOperationId: operationId,
          webhookOperationAttemptId: row.attemptId,
          webhookOperationExpiresAt: operationExpiresAt,
        })
        .where(
          and(
            eq(telegramConnection.id, row.connectionId),
            eq(telegramConnection.storeId, input.storeId),
            inArray(telegramConnection.status, [
              "awaiting_confirmation",
              "provisioning",
            ]),
            or(
              isNull(telegramConnection.webhookOperationId),
              lte(telegramConnection.webhookOperationExpiresAt, now),
            ),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!claimedConnection) {
        return { status: "conflict" } as const;
      }

      return {
        status: "claimed",
        attemptId: row.attemptId,
        operationId,
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
      operationId: claim.operationId,
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

  if (
    !(await renewWebhookOperation(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      now,
    }))
  ) {
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      reason: "activation_lease_lost",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "activation_lease_lost",
    };
  }

  const currentInfo = await api.getWebhookInfo();

  if (!currentInfo.ok) {
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
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
      operationId: claim.operationId,
      reason: "foreign_webhook",
      connectionStatus: "needs_review",
      now,
    });
    return { status: "foreign_webhook" };
  }

  // Revalidate the lease immediately before the external mutation. If a newer
  // activation has taken over, this stale operation makes no change.
  if (
    !(await renewWebhookOperation(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      now: new Date(),
    }))
  ) {
    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      reason: "activation_lease_lost",
      now,
    });
    return {
      status: "retryable",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
      reason: "activation_lease_lost",
    };
  }

  const expectedUrl = activationUrl(claim.baseWebhookUrl, claim.attemptId);
  const secret = generateWebhookSecret();

  const setWebhook = await api.setWebhook({
    url: expectedUrl,
    secretToken: secret,
    allowedUpdates: ["message", "callback_query"],
    dropPendingUpdates: false,
  });

  if (!setWebhook.ok) {
    if (isExplicitWebhookRejection(setWebhook)) {
      await releaseActivationClaim(db, {
        attemptId: claim.attemptId,
        connectionId: claim.connectionId,
        operationId: claim.operationId,
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

    const reviewed = await markActivationUncertain(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      now,
    });

    return reviewed ? { status: "review" } : { status: "superseded" };
  }

  const verifiedInfo = await api.getWebhookInfo();

  if (!verifiedInfo.ok || verifiedInfo.result.url !== expectedUrl) {
    // Telegram accepted the registration but verification did not confirm it.
    // This is ambiguous: never retry or delete speculatively.
    const reviewed = await markActivationUncertain(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
      now,
    });

    return reviewed ? { status: "review" } : { status: "superseded" };
  }

  const commitNow = new Date();

  try {
    const committed = await db.transaction(async (tx) => {
      await lockConnectionStore(tx, input.storeId);

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
          .where(
            and(
              eq(telegramLinkAttempt.id, claim.attemptId),
              eq(telegramLinkAttempt.status, "awaiting_confirmation"),
            ),
          );

        await tx
          .update(telegramConnection)
          .set({
            status: "revoked",
            activationAttemptId: null,
            webhookOperationId: null,
            webhookOperationAttemptId: null,
            webhookOperationExpiresAt: null,
          })
          .where(
            and(
              eq(telegramConnection.id, claim.connectionId),
              eq(telegramConnection.status, "provisioning"),
              eq(telegramConnection.activationAttemptId, claim.attemptId),
              eq(telegramConnection.webhookOperationId, claim.operationId),
            ),
          );

        return { status: "expired" } as const;
      }

      if (currentAttempt.status !== "awaiting_confirmation") {
        return { status: "superseded" } as const;
      }

      const [activated] = await tx
        .update(telegramConnection)
        .set({
          status: "ready",
          webhookUrl: expectedUrl,
          webhookSecretHash: hashWebhookSecret(secret),
          activationAttemptId: claim.attemptId,
          webhookOperationId: null,
          webhookOperationAttemptId: null,
          webhookOperationExpiresAt: null,
          verifiedAt: commitNow,
        })
        .where(
          and(
            eq(telegramConnection.id, claim.connectionId),
            eq(telegramConnection.storeId, input.storeId),
            eq(telegramConnection.status, "provisioning"),
            eq(telegramConnection.activationAttemptId, claim.attemptId),
            eq(telegramConnection.webhookOperationId, claim.operationId),
            eq(
              telegramConnection.webhookOperationAttemptId,
              claim.attemptId,
            ),
            gt(telegramConnection.webhookOperationExpiresAt, commitNow),
          ),
        )
        .returning({ id: telegramConnection.id });

      if (!activated) {
        throw new RabetDataError(
          "CONFLICT",
          "The connection changed during activation.",
        );
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

      return { status: "ready" } as const;
    });

    if (committed.status !== "ready") {
      await releaseActivationClaim(db, {
        attemptId: claim.attemptId,
        connectionId: claim.connectionId,
        operationId: claim.operationId,
        reason: "activation_superseded",
        now: commitNow,
      });
      return { status: committed.status };
    }

    return {
      status: "ready",
      connectionId: claim.connectionId,
      botUsername: claim.botUsername,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      await releaseActivationClaim(db, {
        attemptId: claim.attemptId,
        connectionId: claim.connectionId,
        operationId: claim.operationId,
        reason: "activation_conflict",
        now,
      });
      return { status: "conflict" };
    }

    await releaseActivationClaim(db, {
      attemptId: claim.attemptId,
      connectionId: claim.connectionId,
      operationId: claim.operationId,
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
      lastError: string | null;
    }
  | {
      state: "preparing";
      attemptId: string;
      botUsername: string | null;
      botName: string | null;
      expiresAt: string;
      verificationUrl?: string;
    }
  | {
      state: "recoverable";
      attemptId: string;
      connectionId: string | null;
      botUsername: string;
      botName: string | null;
    }
  | {
      state: "confirm";
      connectionId: string;
      botUsername: string;
      botName: string | null;
      expiresAt: string;
      lastError: string | null;
    }
  | {
      state: "connected";
      botUsername: string;
      botName: string | null;
      openUrl: string;
    }
  | { state: "failed"; reason: string; retryable: boolean };

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
    return { state: "failed", reason: "expired", retryable: true };
  }

  if (attempt.status === "failed") {
    return {
      state: "failed",
      reason: attempt.failureCode ?? "failed",
      retryable: attempt.failureCode !== "webhook_outcome_unknown",
    };
  }

  if (attempt.status === "cancelled") {
    return { state: "failed", reason: "superseded", retryable: true };
  }

  if (attempt.status === "expired") {
    return { state: "failed", reason: "expired", retryable: true };
  }

  let nonce: string;

  try {
    nonce = decryptConnectionSecret(
      attempt.nonceCiphertext,
      attempt.nonceKeyId,
    );
  } catch {
    return { state: "failed", reason: "unavailable", retryable: true };
  }

  return {
    state: "waiting",
    deepLink: merchantManagerDeepLink(attempt.managerBotUsername, nonce),
    expiresAt: attempt.expiresAt.toISOString(),
    telegramBound: attempt.telegramUserId !== null,
    lastError: attempt.failureCode,
  };
}

/**
 * Reads the merchant-visible state. Only a connection the merchant explicitly
 * confirmed is reported as connected. No token, key or webhook digest is
 * returned.
 *
 * The read deliberately prefers verified Telegram evidence over a newer
 * failure: if this store already has a recently created bot, the merchant is
 * offered recovery/confirmation instead of another creation attempt.
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

  const [review] = await db
    .select({
      botUsername: telegramConnection.botUsername,
    })
    .from(telegramConnection)
    .where(
      and(
        eq(telegramConnection.storeId, input.scope.storeId),
        eq(telegramConnection.status, "needs_review"),
      ),
    )
    .orderBy(desc(telegramConnection.updatedAt))
    .limit(1);

  if (review) {
    return {
      state: "failed",
      reason: "webhook_outcome_unknown",
      retryable: false,
    };
  }

  const [attempt] = await db
    .select({
      id: telegramLinkAttempt.id,
      status: telegramLinkAttempt.status,
      managerBotUsername: telegramLinkAttempt.managerBotUsername,
      nonceCiphertext: telegramLinkAttempt.nonceCiphertext,
      nonceKeyId: telegramLinkAttempt.nonceKeyId,
      telegramUserId: telegramLinkAttempt.telegramUserId,
      expiresAt: telegramLinkAttempt.expiresAt,
      failureCode: telegramLinkAttempt.failureCode,
      connectionId: telegramLinkAttempt.connectionId,
      verifiedAt: telegramLinkAttempt.verifiedAt,
      botUsername: telegramLinkAttempt.telegramBotUsername,
      botName: telegramLinkAttempt.telegramBotName,
    })
    .from(telegramLinkAttempt)
    .where(
      and(
        eq(telegramLinkAttempt.storeId, input.scope.storeId),
        eq(telegramLinkAttempt.merchantUserId, input.merchantUserId),
        eq(telegramLinkAttempt.purpose, "store_bot"),
      ),
    )
    .orderBy(desc(telegramLinkAttempt.createdAt))
    .limit(1);

  const recoverable = await findRecoverableCandidateEvidence(
    db as unknown as AttemptTransaction,
    {
      storeId: input.scope.storeId,
      merchantUserId: input.merchantUserId,
      now,
    },
  );

  const recoverableState: MerchantTelegramConnectionState | null = recoverable
    ? {
        state: "recoverable",
        attemptId: recoverable.attemptId,
        connectionId: recoverable.connectionId,
        botUsername: recoverable.botUsername,
        botName: recoverable.botName,
      }
    : null;

  if (!attempt) return recoverableState ?? { state: "not_connected" };

  if (attempt.status === "provisioning") {
    const nonce =
      attempt.failureCode === MANAGED_BOT_START_FAILURE_CODE &&
      attempt.botUsername
        ? attemptNonceOrNull(attempt.nonceCiphertext, attempt.nonceKeyId)
        : null;

    return {
      state: "preparing",
      attemptId: attempt.id,
      botUsername: attempt.botUsername,
      botName: attempt.botName,
      expiresAt: attempt.expiresAt.toISOString(),
      verificationUrl:
        nonce && attempt.botUsername
          ? managedBotStartDeepLink(attempt.botUsername, nonce)
          : undefined,
    };
  }

  if (attempt.status === "awaiting_confirmation" && attempt.connectionId) {
    if (attempt.expiresAt.getTime() <= now.getTime()) {
      return recoverableState ?? {
        state: "failed",
        reason: "expired",
        retryable: true,
      };
    }

    if (
      attempt.botUsername &&
      attempt.verifiedAt !== null &&
      attempt.failureCode !== MANAGED_BOT_START_FAILURE_CODE
    ) {
      return {
        state: "confirm",
        connectionId: attempt.connectionId,
        botUsername: attempt.botUsername,
        botName: attempt.botName,
        expiresAt: attempt.expiresAt.toISOString(),
        lastError: attempt.failureCode,
      };
    }
  }

  if (attempt.status === "pending") {
    if (recoverableState) return recoverableState;

    return stateFromAttempt(attempt, now);
  }

  if (attempt.status === "completed") {
    return { state: "not_connected" };
  }

  if (attempt.status === "cancelled") {
    return recoverableState ?? { state: "not_connected" };
  }

  return recoverableState ?? stateFromAttempt(attempt, now);
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
