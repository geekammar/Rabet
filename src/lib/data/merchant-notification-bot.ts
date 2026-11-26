import "server-only";

import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { merchantNotificationBot, telegramLinkAttempt } from "@/db/schema";
import type { MerchantNotificationPairingCandidate } from "@/db/schema/merchant-notification-bot";
import { mapDatabaseError, RabetDataError } from "./errors";
import { validatePrivateChatId } from "./seller-notifications";

/**
 * Per-store merchant notification bot persistence.
 *
 * Every function takes an explicit `storeId` that the caller must have resolved
 * from the authenticated merchant session. No function accepts a store id from
 * a browser payload, URL, Telegram update or JWT.
 *
 * The raw bot token never appears in a returned public state: only the
 * encrypted ciphertext is stored, and only the internal `Secret` reader used by
 * the server-side delivery service can see it.
 */

export type MerchantNotificationBotCapability = {
  supported: boolean;
  reason?: string;
};

export type MerchantNotificationBotState = {
  configured: boolean;
  botUsername: string | null;
  botName: string | null;
  destinationChatId: string | null;
  destinationChatTitle: string | null;
  pairingActive: boolean;
  pairingExpiresAt: string | null;
  pairingFailureCode: string | null;
  verifiedAt: string | null;
  lastTestAt: string | null;
};

export type MerchantNotificationBotSecret = {
  storeId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  tokenCiphertext: string;
  tokenKeyId: string;
  destinationChatId: string | null;
  destinationChatTitle: string | null;
  destinationChatUsername: string | null;
  pairingCodeHash: string | null;
  pairingExpiresAt: Date | null;
  pairingUpdateOffset: number | null;
  pairingCandidates: MerchantNotificationPairingCandidate[] | null;
  pairingFailureCode: string | null;
  configEpoch: string;
  verifiedAt: Date | null;
  lastTestAt: Date | null;
};

function rowsFrom<T>(result: unknown): T[] {
  const raw = Array.isArray(result)
    ? result
    : (result as { rows?: unknown[] } | null)?.rows;

  return (Array.isArray(raw) ? raw : []) as T[];
}

/**
 * Checks whether the migration that adds the notification bot table has been
 * applied. A missing table is reported as unsupported rather than thrown, so
 * the setup page can explain the upgrade without breaking the rest of setup.
 */
export async function checkMerchantNotificationBotCapability(
  db: Database,
): Promise<MerchantNotificationBotCapability> {
  try {
    const result = await db.execute<{ supported: boolean }>(sql`
      SELECT to_regclass('public.merchant_notification_bot') IS NOT NULL AS supported
    `);
    const [row] = rowsFrom<{ supported?: boolean }>(result);

    if (row?.supported === true) return { supported: true };

    return {
      supported: false,
      reason:
        "The merchant notification bot table is missing. Apply migration " +
        "0019_merchant_notification_bot.",
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads the merchant-visible state for one store. The result intentionally has
 * no token, key id or ciphertext fields.
 */
export async function readMerchantNotificationBotState(
  db: Database,
  storeId: string,
  now = new Date(),
): Promise<MerchantNotificationBotState | null> {
  const capability = await checkMerchantNotificationBotCapability(db);

  if (!capability.supported) return null;

  try {
    const [row] = await db
      .select({
        botUsername: merchantNotificationBot.botUsername,
        botName: merchantNotificationBot.botName,
        destinationChatId: merchantNotificationBot.destinationChatId,
        destinationChatTitle: merchantNotificationBot.destinationChatTitle,
        pairingExpiresAt: merchantNotificationBot.pairingExpiresAt,
        pairingFailureCode: merchantNotificationBot.pairingFailureCode,
        verifiedAt: merchantNotificationBot.verifiedAt,
        lastTestAt: merchantNotificationBot.lastTestAt,
      })
      .from(merchantNotificationBot)
      .where(eq(merchantNotificationBot.storeId, storeId))
      .limit(1);

    if (!row) return null;

    return {
      configured: true,
      botUsername: row.botUsername,
      botName: row.botName,
      destinationChatId: row.destinationChatId,
      destinationChatTitle: row.destinationChatTitle,
      pairingActive:
        row.pairingExpiresAt !== null &&
        row.pairingExpiresAt.getTime() > now.getTime(),
      pairingExpiresAt: row.pairingExpiresAt?.toISOString() ?? null,
      pairingFailureCode: row.pairingFailureCode,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastTestAt: row.lastTestAt?.toISOString() ?? null,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/** Server-only reader that includes the encrypted token. Never send to a page. */
export async function readMerchantNotificationBotSecret(
  db: Database,
  storeId: string,
): Promise<MerchantNotificationBotSecret | null> {
  const capability = await checkMerchantNotificationBotCapability(db);

  if (!capability.supported) return null;

  try {
    const [row] = await db
      .select({
        storeId: merchantNotificationBot.storeId,
        botId: merchantNotificationBot.botId,
        botUsername: merchantNotificationBot.botUsername,
        botName: merchantNotificationBot.botName,
        tokenCiphertext: merchantNotificationBot.tokenCiphertext,
        tokenKeyId: merchantNotificationBot.tokenKeyId,
        destinationChatId: merchantNotificationBot.destinationChatId,
        destinationChatTitle: merchantNotificationBot.destinationChatTitle,
        destinationChatUsername:
          merchantNotificationBot.destinationChatUsername,
        pairingCodeHash: merchantNotificationBot.pairingCodeHash,
        pairingExpiresAt: merchantNotificationBot.pairingExpiresAt,
        pairingUpdateOffset: merchantNotificationBot.pairingUpdateOffset,
        pairingCandidates: merchantNotificationBot.pairingCandidates,
        pairingFailureCode: merchantNotificationBot.pairingFailureCode,
        configEpoch: merchantNotificationBot.configEpoch,
        verifiedAt: merchantNotificationBot.verifiedAt,
        lastTestAt: merchantNotificationBot.lastTestAt,
      })
      .from(merchantNotificationBot)
      .where(eq(merchantNotificationBot.storeId, storeId))
      .limit(1);

    return row ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type SaveMerchantNotificationBotTokenInput = {
  storeId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  tokenCiphertext: string;
  tokenKeyId: string;
  pairingCodeHash: string;
  pairingExpiresAt: Date;
  now?: Date;
};

/**
 * Creates or replaces the store's notification bot token and starts a fresh
 * pairing challenge. Any previously paired destination and verification is
 * cleared because the bot identity or the intended chat may be changing.
 */
export async function saveMerchantNotificationBotToken(
  db: Database,
  input: SaveMerchantNotificationBotTokenInput,
): Promise<void> {
  const now = input.now ?? new Date();

  try {
    await db
      .insert(merchantNotificationBot)
      .values({
        storeId: input.storeId,
        botId: input.botId,
        botUsername: input.botUsername,
        botName: input.botName,
        tokenCiphertext: input.tokenCiphertext,
        tokenKeyId: input.tokenKeyId,
        pairingCodeHash: input.pairingCodeHash,
        pairingExpiresAt: input.pairingExpiresAt,
        pairingUpdateOffset: null,
        pairingCandidates: null,
        pairingFailureCode: null,
        configEpoch: crypto.randomUUID(),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: merchantNotificationBot.storeId,
        set: {
          botId: input.botId,
          botUsername: input.botUsername,
          botName: input.botName,
          tokenCiphertext: input.tokenCiphertext,
          tokenKeyId: input.tokenKeyId,
          destinationChatId: null,
          destinationChatTitle: null,
          destinationChatUsername: null,
          pairingCodeHash: input.pairingCodeHash,
          pairingExpiresAt: input.pairingExpiresAt,
          pairingUpdateOffset: null,
          pairingCandidates: null,
          pairingFailureCode: null,
          configEpoch: crypto.randomUUID(),
          verifiedAt: null,
          lastTestAt: null,
          updatedAt: now,
        },
      });
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type StartMerchantNotificationBotPairingInput = {
  storeId: string;
  pairingCodeHash: string;
  pairingExpiresAt: Date;
  now?: Date;
};

/**
 * Replaces the current pairing challenge and clears the old destination. Used
 * when the merchant asks for a new short-lived link or wants a different chat.
 */
export async function startMerchantNotificationBotPairing(
  db: Database,
  input: StartMerchantNotificationBotPairingInput,
): Promise<void> {
  const now = input.now ?? new Date();

  try {
    const [updated] = await db
      .update(merchantNotificationBot)
      .set({
        pairingCodeHash: input.pairingCodeHash,
        pairingExpiresAt: input.pairingExpiresAt,
        pairingUpdateOffset: null,
        pairingCandidates: null,
        pairingFailureCode: null,
        configEpoch: crypto.randomUUID(),
        destinationChatId: null,
        destinationChatTitle: null,
        destinationChatUsername: null,
        verifiedAt: null,
        lastTestAt: null,
        updatedAt: now,
      })
      .where(eq(merchantNotificationBot.storeId, input.storeId))
      .returning({ id: merchantNotificationBot.id });

    if (!updated) {
      throw new RabetDataError(
        "NOT_FOUND",
        "No notification bot is connected for this store.",
      );
    }
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

function normalizePairingCandidate(
  value: unknown,
): MerchantNotificationPairingCandidate | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;
  const chatId =
    typeof candidate.chatId === "string" ? candidate.chatId : null;

  if (!chatId || !validatePrivateChatId(chatId)) return null;

  const date = Number(candidate.date);

  if (!Number.isSafeInteger(date) || date < 0) return null;

  return {
    chatId,
    title:
      typeof candidate.title === "string"
        ? candidate.title.slice(0, 200)
        : null,
    username:
      typeof candidate.username === "string"
        ? candidate.username.slice(0, 64)
        : null,
    date,
  };
}

function normalizePairingCandidates(
  values: unknown,
): MerchantNotificationPairingCandidate[] {
  if (!Array.isArray(values)) return [];

  const byChat = new Map<string, MerchantNotificationPairingCandidate>();

  for (const value of values) {
    const candidate = normalizePairingCandidate(value);

    if (!candidate) continue;

    const current = byChat.get(candidate.chatId);

    if (!current || candidate.date >= current.date) {
      byChat.set(candidate.chatId, candidate);
    }
  }

  return [...byChat.values()];
}

function parsePairingCandidates(
  value: unknown,
): MerchantNotificationPairingCandidate[] {
  if (typeof value === "string") {
    try {
      return normalizePairingCandidates(JSON.parse(value));
    } catch {
      return [];
    }
  }

  return normalizePairingCandidates(value);
}

export type ConfirmMerchantNotificationBotPairingInput = {
  storeId: string;
  pairingCodeHash: string;
  chatId: string;
  chatTitle: string | null;
  chatUsername: string | null;
  now?: Date;
};

/**
 * Confirms the chat that sent the current pairing payload only when the same
 * unexpired challenge still has exactly that one retained candidate.
 *
 * A concurrent check that merged a second chat makes the candidate-length
 * condition fail, so an ambiguous attempt can never be finalized as a pairing.
 */
export async function confirmMerchantNotificationBotPairing(
  db: Database,
  input: ConfirmMerchantNotificationBotPairingInput,
): Promise<boolean> {
  if (!validatePrivateChatId(input.chatId)) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "A numeric private Telegram chat id is required.",
    );
  }

  const now = input.now ?? new Date();

  try {
    const [updated] = await db
      .update(merchantNotificationBot)
      .set({
        destinationChatId: input.chatId,
        destinationChatTitle: input.chatTitle,
        destinationChatUsername: input.chatUsername,
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairingUpdateOffset: null,
        pairingCandidates: null,
        pairingFailureCode: null,
        configEpoch: crypto.randomUUID(),
        verifiedAt: null,
        lastTestAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(merchantNotificationBot.storeId, input.storeId),
          eq(merchantNotificationBot.pairingCodeHash, input.pairingCodeHash),
          gt(merchantNotificationBot.pairingExpiresAt, now),
          isNull(merchantNotificationBot.pairingFailureCode),
          sql`jsonb_array_length(coalesce(${merchantNotificationBot.pairingCandidates}, '[]'::jsonb)) = 1`,
          sql`${merchantNotificationBot.pairingCandidates}->0->>'chatId' = ${input.chatId}`,
        ),
      )
      .returning({ id: merchantNotificationBot.id });

    return Boolean(updated);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type MergeMerchantNotificationBotPairingCandidatesInput = {
  storeId: string;
  pairingCodeHash: string;
  candidates: MerchantNotificationPairingCandidate[];
  nextOffset: number;
  now?: Date;
};

export type MerchantNotificationBotPairingCandidates = {
  candidates: MerchantNotificationPairingCandidate[];
  nextOffset: number;
};

/**
 * Atomically merges one evaluated page's candidates into the retained set and
 * advances the cursor for the same unexpired challenge.
 *
 * The merge runs inside the UPDATE, so two concurrent checks cannot overwrite
 * each other's candidate. The caller persists this page before asking Telegram
 * for the next one, which is what confirms the page on Telegram's side.
 */
export async function mergeMerchantNotificationBotPairingCandidates(
  db: Database,
  input: MergeMerchantNotificationBotPairingCandidatesInput,
): Promise<MerchantNotificationBotPairingCandidates | null> {
  if (
    !Number.isSafeInteger(input.nextOffset) ||
    input.nextOffset < 1
  ) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "The pairing update offset is invalid.",
    );
  }

  const candidates = normalizePairingCandidates(input.candidates);
  const now = input.now ?? new Date();

  try {
    const result = await db.execute<Record<string, unknown>>(sql`
      UPDATE "merchant_notification_bot"
      SET
        "pairing_candidates" = COALESCE((
          SELECT jsonb_agg(candidate ORDER BY candidate->>'chatId')
          FROM (
            SELECT DISTINCT ON (candidate->>'chatId') candidate
            FROM (
              SELECT
                candidate,
                COALESCE((candidate->>'date')::bigint, 0) AS candidate_date,
                0 AS source_order
              FROM jsonb_array_elements(
                COALESCE("pairing_candidates", '[]'::jsonb)
              ) AS existing(candidate)
              UNION ALL
              SELECT
                candidate,
                COALESCE((candidate->>'date')::bigint, 0) AS candidate_date,
                1 AS source_order
              FROM jsonb_array_elements(
                ${JSON.stringify(candidates)}::jsonb
              ) AS incoming(candidate)
            ) AS all_candidates
            ORDER BY
              candidate->>'chatId',
              candidate_date DESC,
              source_order DESC
          ) AS deduped
        ), '[]'::jsonb),
        "pairing_update_offset" = GREATEST(
          COALESCE("pairing_update_offset", 0),
          ${input.nextOffset}
        ),
        "updated_at" = now()
      WHERE "store_id" = ${input.storeId}
        AND "pairing_code_hash" = ${input.pairingCodeHash}
        AND "pairing_expires_at" > ${now.toISOString()}::timestamptz
        AND "pairing_failure_code" IS NULL
      RETURNING "pairing_candidates", "pairing_update_offset"
    `);
    const [row] = rowsFrom<Record<string, unknown>>(result);

    if (!row) return null;

    const persistedCursor = Number(
      row.pairing_update_offset ?? row.pairingUpdateOffset,
    );

    if (!Number.isSafeInteger(persistedCursor) || persistedCursor < 1) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "The pairing cursor could not be read.",
      );
    }

    return {
      candidates: parsePairingCandidates(
        row.pairing_candidates ?? row.pairingCandidates,
      ),
      nextOffset: persistedCursor,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type MarkMerchantNotificationBotPairingAmbiguousInput = {
  storeId: string;
  pairingCodeHash: string;
  now?: Date;
};

/**
 * Terminally rejects the current challenge for ambiguity and clears every
 * pairing field. A later confirm can only match a new challenge.
 */
export async function markMerchantNotificationBotPairingAmbiguous(
  db: Database,
  input: MarkMerchantNotificationBotPairingAmbiguousInput,
): Promise<boolean> {
  const now = input.now ?? new Date();

  try {
    const [updated] = await db
      .update(merchantNotificationBot)
      .set({
        pairingFailureCode: "ambiguous",
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairingUpdateOffset: null,
        pairingCandidates: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(merchantNotificationBot.storeId, input.storeId),
          eq(merchantNotificationBot.pairingCodeHash, input.pairingCodeHash),
          gt(merchantNotificationBot.pairingExpiresAt, now),
          isNull(merchantNotificationBot.pairingFailureCode),
        ),
      )
      .returning({ id: merchantNotificationBot.id });

    return Boolean(updated);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type RecordMerchantNotificationBotTestSuccessInput = {
  storeId: string;
  expectedChatId: string;
  expectedBotId: number;
  expectedConfigEpoch: string;
  now?: Date;
};

/**
 * Records a successful Telegram test only if the destination and bot identity
 * are still the ones that were tested. A concurrent re-pair or token change
 * therefore cannot be marked verified by a stale result.
 */
export async function recordMerchantNotificationBotTestSuccess(
  db: Database,
  input: RecordMerchantNotificationBotTestSuccessInput,
): Promise<void> {
  const now = input.now ?? new Date();

  try {
    const [updated] = await db
      .update(merchantNotificationBot)
      .set({
        verifiedAt: now,
        lastTestAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(merchantNotificationBot.storeId, input.storeId),
          eq(
            merchantNotificationBot.destinationChatId,
            input.expectedChatId,
          ),
          eq(merchantNotificationBot.botId, input.expectedBotId),
          eq(
            merchantNotificationBot.configEpoch,
            input.expectedConfigEpoch,
          ),
        ),
      )
      .returning({ id: merchantNotificationBot.id });

    if (!updated) {
      throw new RabetDataError(
        "CONFIGURATION_CHANGED",
        "Notification settings changed while the test was running.",
      );
    }
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Removes the store's notification bot row. The encrypted token, destination
 * and pairing digest are deleted together; the customer-facing store bot and
 * the operator notification singleton are untouched.
 */
export async function disconnectMerchantNotificationBot(
  db: Database,
  storeId: string,
): Promise<boolean> {
  try {
    const [deleted] = await db
      .delete(merchantNotificationBot)
      .where(eq(merchantNotificationBot.storeId, storeId))
      .returning({ id: merchantNotificationBot.id });

    return Boolean(deleted);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type SaveManagedMerchantNotificationBotInput = {
  storeId: string;
  botId: number;
  botUsername: string;
  botName: string | null;
  tokenCiphertext: string;
  tokenKeyId: string;
  destinationChatId: string;
  destinationChatTitle: string | null;
  destinationChatUsername: string | null;
  now?: Date;
};

/**
 * Persists a notification bot whose token and private recipient were verified
 * through the manager-bot flow. The merchant pressed Start in the new bot from
 * the Telegram account bound to the attempt, so the destination is already
 * verified and no pairing challenge is created.
 */
export async function saveManagedMerchantNotificationBot(
  db: Database,
  input: SaveManagedMerchantNotificationBotInput,
): Promise<void> {
  if (!validatePrivateChatId(input.destinationChatId)) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "A numeric private Telegram chat id is required.",
    );
  }

  const now = input.now ?? new Date();

  try {
    await db
      .insert(merchantNotificationBot)
      .values({
        storeId: input.storeId,
        botId: input.botId,
        botUsername: input.botUsername,
        botName: input.botName,
        tokenCiphertext: input.tokenCiphertext,
        tokenKeyId: input.tokenKeyId,
        destinationChatId: input.destinationChatId,
        destinationChatTitle: input.destinationChatTitle,
        destinationChatUsername: input.destinationChatUsername,
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairingUpdateOffset: null,
        pairingCandidates: null,
        pairingFailureCode: null,
        configEpoch: crypto.randomUUID(),
        verifiedAt: now,
        lastTestAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: merchantNotificationBot.storeId,
        set: {
          botId: input.botId,
          botUsername: input.botUsername,
          botName: input.botName,
          tokenCiphertext: input.tokenCiphertext,
          tokenKeyId: input.tokenKeyId,
          destinationChatId: input.destinationChatId,
          destinationChatTitle: input.destinationChatTitle,
          destinationChatUsername: input.destinationChatUsername,
          pairingCodeHash: null,
          pairingExpiresAt: null,
          pairingUpdateOffset: null,
          pairingCandidates: null,
          pairingFailureCode: null,
          configEpoch: crypto.randomUUID(),
          verifiedAt: now,
          lastTestAt: null,
          updatedAt: now,
        },
      });
  } catch (error) {
    throw mapDatabaseError(error);
  }
}


const ACTIVE_NOTIFICATION_BOT_ATTEMPT_STATUSES = [
  "pending",
  "provisioning",
  "awaiting_confirmation",
] as const;

/**
 * Serializes the managed final write with manual connect/pair/disconnect.
 * The lock key is the same one used by the managed attempt and never includes
 * a browser-supplied value.
 */
export async function lockNotificationBotOnboarding(
  db: Database,
  storeId: string,
): Promise<void> {
  await db.execute(sql`
    select pg_advisory_xact_lock(
      hashtext(${`telegram-link-attempt:${storeId}:notification_bot`})
    )
  `);
}

/**
 * Cancels any in-flight managed notification-bot attempt because a manual
 * action has become the newer intention. The managed final transaction will
 * then fail closed instead of overwriting the manual configuration.
 */
export async function cancelActiveNotificationBotManagedAttempts(
  db: Database,
  input: {
    storeId: string;
    failureCode?: string;
    now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();

  try {
    const rows = await db
      .update(telegramLinkAttempt)
      .set({
        status: "cancelled",
        failureCode: input.failureCode ?? "superseded_by_manual",
        updatedAt: now,
      })
      .where(
        and(
          eq(telegramLinkAttempt.storeId, input.storeId),
          eq(telegramLinkAttempt.purpose, "notification_bot"),
          inArray(telegramLinkAttempt.status, [
            ...ACTIVE_NOTIFICATION_BOT_ATTEMPT_STATUSES,
          ]),
        ),
      )
      .returning({ id: telegramLinkAttempt.id });

    return rows.length;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
