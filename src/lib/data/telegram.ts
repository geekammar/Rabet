import "server-only";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { telegramUpdate } from "@/db/schema";
import { mapDatabaseError } from "./errors";

export type TelegramUpdateRecord = typeof telegramUpdate.$inferSelect;

export interface RecordTelegramUpdateResult {
  inserted: boolean;
  row: TelegramUpdateRecord;
}

/**
 * Attempts to insert an update record into `telegram_update` for deduplication.
 *
 * If this `updateId` was already recorded, returns `{ inserted: false, row: existingRow }`.
 */
export async function recordTelegramUpdate(
  db: Database,
  input: {
    updateId: number;
    updateType: string;
    payload?: unknown;
  },
): Promise<RecordTelegramUpdateResult> {
  try {
    const [insertedRow] = await db
      .insert(telegramUpdate)
      .values({
        updateId: input.updateId,
        updateType: input.updateType,
        payload: input.payload ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedRow) {
      return { inserted: true, row: insertedRow };
    }

    const [existingRow] = await db
      .select()
      .from(telegramUpdate)
      .where(eq(telegramUpdate.updateId, input.updateId))
      .limit(1);

    if (!existingRow) {
      throw new Error(`Failed to record or fetch telegram_update for updateId ${input.updateId}`);
    }

    return { inserted: false, row: existingRow };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Marks a Telegram update as successfully processed.
 */
export async function markTelegramUpdateProcessed(
  db: Database,
  updateId: number,
): Promise<void> {
  try {
    await db
      .update(telegramUpdate)
      .set({
        processedAt: new Date(),
        processingError: null,
      })
      .where(eq(telegramUpdate.updateId, updateId));
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Records a sanitized processing error against the update record, leaving `processedAt` null
 * so that Telegram's retry mechanism can redeliver and retry the operation.
 */
export async function markTelegramUpdateFailed(
  db: Database,
  updateId: number,
  errorMessage: string,
): Promise<void> {
  try {
    await db
      .update(telegramUpdate)
      .set({
        processingError: errorMessage.slice(0, 500),
      })
      .where(eq(telegramUpdate.updateId, updateId));
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
