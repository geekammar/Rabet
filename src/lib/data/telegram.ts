import "server-only";

import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { telegramUpdate } from "@/db/schema";
import { mapDatabaseError } from "./errors";

export type TelegramUpdateRecord = typeof telegramUpdate.$inferSelect;

/** Lease window (milliseconds) before an uncompleted in-flight update is deemed abandoned. */
export const IN_FLIGHT_LEASE_MS = 30_000;

export interface ClaimTelegramUpdateInput {
  updateId: number;
  updateType: string;
  payload?: unknown;
  attemptId?: string;
  leaseMs?: number;
}

export type ClaimTelegramUpdateResult =
  | { status: "claimed"; attemptId: string; row: TelegramUpdateRecord }
  | { status: "already_processed"; row: TelegramUpdateRecord }
  | { status: "in_flight"; row: TelegramUpdateRecord };

/**
 * Atomically claims ownership of a Telegram update attempt.
 *
 * Guarantees:
 * 1. Initial attempt is claimed via INSERT ON CONFLICT DO NOTHING.
 * 2. Retry of a failed update or an abandoned in-flight update (> leaseMs) is claimed atomically
 *    via a single conditional UPDATE statement. Two concurrent retries will race on PostgreSQL
 *    row-level serialization: exactly one acquires ownership, the other gets `status: "in_flight"`.
 * 3. Already-processed updates return `status: "already_processed"`.
 */
export async function claimTelegramUpdate(
  db: Database,
  input: ClaimTelegramUpdateInput,
): Promise<ClaimTelegramUpdateResult> {
  try {
    const attemptId = input.attemptId ?? crypto.randomUUID();
    const now = new Date();
    const leaseMs = input.leaseMs ?? IN_FLIGHT_LEASE_MS;
    const leaseCutoff = new Date(now.getTime() - leaseMs);

    const envelope = {
      update: input.payload ?? null,
      attemptId,
      claimedAt: now.toISOString(),
    };

    // 1. Initial attempt: insert with conflict avoidance
    const [insertedRow] = await db
      .insert(telegramUpdate)
      .values({
        updateId: input.updateId,
        updateType: input.updateType,
        payload: envelope,
        processedAt: null,
        processingError: null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRow) {
      return { status: "claimed", attemptId, row: insertedRow };
    }

    // 2. Retry / Recovery: atomically claim if unprocessed AND (has error OR lease expired)
    const [claimedRow] = await db
      .update(telegramUpdate)
      .set({
        payload: envelope,
        processingError: null,
      })
      .where(
        and(
          eq(telegramUpdate.updateId, input.updateId),
          isNull(telegramUpdate.processedAt),
          sql`(
            ${telegramUpdate.processingError} IS NOT NULL
            OR (${telegramUpdate.payload}->>'claimedAt') IS NULL
            OR (${telegramUpdate.payload}->>'claimedAt')::timestamptz <= ${leaseCutoff.toISOString()}::timestamptz
          )`,
        ),
      )
      .returning();

    if (claimedRow) {
      return { status: "claimed", attemptId, row: claimedRow };
    }

    // 3. Not claimed: either already succeeded or another active attempt currently holds the lease
    const [existing] = await db
      .select()
      .from(telegramUpdate)
      .where(eq(telegramUpdate.updateId, input.updateId))
      .limit(1);

    if (!existing || existing.processedAt !== null) {
      return { status: "already_processed", row: existing! };
    }

    return { status: "in_flight", row: existing };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Marks a Telegram update as successfully processed.
 *
 * Conditional on attempt identity: a stale attempt that was superseded by a newer attempt
 * cannot mark the update as processed.
 */
export async function markTelegramUpdateProcessed(
  db: Database,
  params: {
    updateId: number;
    attemptId: string;
  },
): Promise<boolean> {
  try {
    const [row] = await db
      .update(telegramUpdate)
      .set({
        processedAt: new Date(),
        processingError: null,
      })
      .where(
        and(
          eq(telegramUpdate.updateId, params.updateId),
          isNull(telegramUpdate.processedAt),
          sql`${telegramUpdate.payload}->>'attemptId' = ${params.attemptId}`,
        ),
      )
      .returning();

    return Boolean(row);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Records a sanitized processing error against the update record, leaving `processedAt` null.
 *
 * Conditional on attempt identity: a stale attempt cannot overwrite a newer attempt with a failure.
 */
export async function markTelegramUpdateFailed(
  db: Database,
  params: {
    updateId: number;
    attemptId: string;
    errorMessage: string;
  },
): Promise<boolean> {
  try {
    const [row] = await db
      .update(telegramUpdate)
      .set({
        processingError: params.errorMessage.slice(0, 500),
      })
      .where(
        and(
          eq(telegramUpdate.updateId, params.updateId),
          isNull(telegramUpdate.processedAt),
          sql`${telegramUpdate.payload}->>'attemptId' = ${params.attemptId}`,
        ),
      )
      .returning();

    return Boolean(row);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
