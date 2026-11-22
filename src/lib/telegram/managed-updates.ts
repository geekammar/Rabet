import "server-only";

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import type { TransactionDatabase } from "@/db/transaction-client";
import { telegramManagedUpdate } from "@/db/schema";
import { mapDatabaseError, RabetDataError } from "@/lib/data/errors";

/**
 * Per-bot Telegram update claiming for managed Store Bots.
 *
 * Telegram update ids are only unique per bot. The lock is therefore
 * `(bot_id, update_id)`, never the legacy global `update_id`. A redelivery for
 * the same bot is a no-op once processed; a concurrent attempt gets a retryable
 * in-flight result; a failed or abandoned attempt can be reclaimed.
 */

export const MANAGED_UPDATE_IN_FLIGHT_LEASE_MS = 30_000;

export type ClaimManagedUpdateResult =
  | { status: "claimed"; attemptToken: string }
  | { status: "already_processed" }
  | { status: "in_flight" };

export type ManagedUpdateDatabase = Database | TransactionDatabase;

/**
 * Both drivers expose the same Drizzle query builder for the operations here;
 * they differ only in transport. The cast keeps the shared update-claim code
 * usable from the Neon HTTP webhook and the postgres-js manager path.
 */
function queryBuilder(db: ManagedUpdateDatabase): Database {
  return db as unknown as Database;
}

export async function claimManagedTelegramUpdate(
  db: ManagedUpdateDatabase,
  input: {
    botId: number;
    updateId: number;
    updateType: string;
    connectionId?: string | null;
    attemptId?: string | null;
    attemptToken?: string;
    leaseMs?: number;
  },
): Promise<ClaimManagedUpdateResult> {
  const queryDb = queryBuilder(db);
  const attemptToken = input.attemptToken ?? crypto.randomUUID();
  const now = new Date();
  const leaseCutoff = new Date(
    now.getTime() - (input.leaseMs ?? MANAGED_UPDATE_IN_FLIGHT_LEASE_MS),
  );

  try {
    const [inserted] = await queryDb
      .insert(telegramManagedUpdate)
      .values({
        botId: input.botId,
        updateId: input.updateId,
        updateType: input.updateType,
        connectionId: input.connectionId ?? null,
        attemptId: input.attemptId ?? null,
        status: "processing",
        attemptToken,
        claimedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: telegramManagedUpdate.id });

    if (inserted) {
      return { status: "claimed", attemptToken };
    }

    const [reclaimed] = await queryDb
      .update(telegramManagedUpdate)
      .set({
        status: "processing",
        attemptToken,
        claimedAt: now,
        processedAt: null,
        processingError: null,
      })
      .where(
        and(
          eq(telegramManagedUpdate.botId, input.botId),
          eq(telegramManagedUpdate.updateId, input.updateId),
          sql`(
            ${telegramManagedUpdate.status} = 'failed'
            OR (
              ${telegramManagedUpdate.status} = 'processing'
              AND ${telegramManagedUpdate.claimedAt} <= ${leaseCutoff.toISOString()}::timestamptz
            )
          )`,
        ),
      )
      .returning({ id: telegramManagedUpdate.id });

    if (reclaimed) {
      return { status: "claimed", attemptToken };
    }

    const [existing] = await queryDb
      .select({
        status: telegramManagedUpdate.status,
        processedAt: telegramManagedUpdate.processedAt,
      })
      .from(telegramManagedUpdate)
      .where(
        and(
          eq(telegramManagedUpdate.botId, input.botId),
          eq(telegramManagedUpdate.updateId, input.updateId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "The managed Telegram update could not be claimed.",
      );
    }

    if (existing.status === "processed" || existing.processedAt !== null) {
      return { status: "already_processed" };
    }

    return { status: "in_flight" };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export async function markManagedTelegramUpdateProcessed(
  db: ManagedUpdateDatabase,
  input: {
    botId: number;
    updateId: number;
    attemptToken: string;
  },
): Promise<boolean> {
  const queryDb = queryBuilder(db);

  try {
    const [row] = await queryDb
      .update(telegramManagedUpdate)
      .set({
        status: "processed",
        processedAt: new Date(),
        processingError: null,
      })
      .where(
        and(
          eq(telegramManagedUpdate.botId, input.botId),
          eq(telegramManagedUpdate.updateId, input.updateId),
          eq(telegramManagedUpdate.attemptToken, input.attemptToken),
          eq(telegramManagedUpdate.status, "processing"),
        ),
      )
      .returning({ id: telegramManagedUpdate.id });

    return Boolean(row);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function markManagedTelegramUpdateFailed(
  db: ManagedUpdateDatabase,
  input: {
    botId: number;
    updateId: number;
    attemptToken: string;
    errorMessage: string;
  },
): Promise<boolean> {
  const queryDb = queryBuilder(db);

  try {
    const [row] = await queryDb
      .update(telegramManagedUpdate)
      .set({
        status: "failed",
        processingError: input.errorMessage.slice(0, 500),
      })
      .where(
        and(
          eq(telegramManagedUpdate.botId, input.botId),
          eq(telegramManagedUpdate.updateId, input.updateId),
          eq(telegramManagedUpdate.attemptToken, input.attemptToken),
          eq(telegramManagedUpdate.status, "processing"),
        ),
      )
      .returning({ id: telegramManagedUpdate.id });

    return Boolean(row);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
