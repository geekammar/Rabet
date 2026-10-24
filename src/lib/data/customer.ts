import "server-only";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { customer } from "@/db/schema";
import { mapDatabaseError } from "./errors";

export interface UpsertCustomerInput {
  telegramId: number;
  telegramUsername?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  selectedLanguageId?: string | null;
}

export type CustomerRecord = typeof customer.$inferSelect;

/**
 * Upserts a Telegram customer by their unique `telegramId`.
 *
 * Minimal data retention:
 * - Updates username, first/last names, languageCode, and updatedAt.
 * - Does NOT overwrite an existing selectedLanguageId unless explicitly provided.
 */
export async function upsertCustomer(
  db: Database,
  input: UpsertCustomerInput,
): Promise<CustomerRecord> {
  try {
    const updateSet: Record<string, unknown> = {
      telegramUsername: input.telegramUsername ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      languageCode: input.languageCode ?? null,
      updatedAt: new Date(),
    };

    if (input.selectedLanguageId !== undefined) {
      updateSet.selectedLanguageId = input.selectedLanguageId;
    }

    const [row] = await db
      .insert(customer)
      .values({
        telegramId: input.telegramId,
        telegramUsername: input.telegramUsername ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        languageCode: input.languageCode ?? null,
        selectedLanguageId: input.selectedLanguageId ?? null,
      })
      .onConflictDoUpdate({
        target: customer.telegramId,
        set: updateSet,
      })
      .returning();

    return row;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Reads a customer by their 64-bit Telegram user ID.
 */
export async function getCustomerByTelegramId(
  db: Database,
  telegramId: number,
): Promise<CustomerRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(customer)
      .where(eq(customer.telegramId, telegramId))
      .limit(1);

    return row ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Explicitly updates the customer's chosen language.
 */
export async function setCustomerSelectedLanguage(
  db: Database,
  telegramId: number,
  languageId: string,
): Promise<CustomerRecord> {
  try {
    const [row] = await db
      .update(customer)
      .set({
        selectedLanguageId: languageId,
        updatedAt: new Date(),
      })
      .where(eq(customer.telegramId, telegramId))
      .returning();

    if (!row) {
      throw new Error(`Customer with telegramId ${telegramId} not found.`);
    }

    return row;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
