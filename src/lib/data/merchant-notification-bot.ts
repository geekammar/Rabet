import "server-only";

import crypto from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { merchantNotificationBot } from "@/db/schema";
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

export type ConfirmMerchantNotificationBotPairingInput = {
  storeId: string;
  pairingCodeHash: string;
  chatId: string;
  chatTitle: string | null;
  chatUsername: string | null;
  now?: Date;
};

/**
 * Confirms the chat that sent the current pairing payload. The conditional
 * update matches both the store and the unexpired digest, so a stale or
 * cross-store pairing request can never write a destination.
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
        ),
      )
      .returning({ id: merchantNotificationBot.id });

    return Boolean(updated);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export type RecordMerchantNotificationBotPairingProgressInput = {
  storeId: string;
  pairingCodeHash: string;
  nextOffset: number;
  now?: Date;
};

/**
 * Advances the pairing queue cursor only while the same unexpired challenge is
 * still current. Telegram confirms the previous batch on the next request, so
 * progress never drops an update before this check has evaluated it.
 */
export async function recordMerchantNotificationBotPairingProgress(
  db: Database,
  input: RecordMerchantNotificationBotPairingProgressInput,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.nextOffset) ||
    input.nextOffset < 1
  ) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "The pairing update offset is invalid.",
    );
  }

  const now = input.now ?? new Date();

  try {
    const [updated] = await db
      .update(merchantNotificationBot)
      .set({
        pairingUpdateOffset: input.nextOffset,
        updatedAt: now,
      })
      .where(
        and(
          eq(merchantNotificationBot.storeId, input.storeId),
          eq(merchantNotificationBot.pairingCodeHash, input.pairingCodeHash),
          gt(merchantNotificationBot.pairingExpiresAt, now),
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
