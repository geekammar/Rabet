import "server-only";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { store } from "@/db/schema";
import { isTelegramSupportUsername } from "@/lib/telegram/support-contact";

import { isUndefinedColumnError, mapDatabaseError } from "./errors";

/**
 * Reads the optional Telegram support username saved for one store.
 *
 * The value is nullable by design: a missing column value (including stores
 * created before this setting existed) means "no direct contact configured".
 * The read is also safe against a deployment whose database has not applied
 * the additive migration yet, so an older managed storefront keeps working.
 */
export async function readStoreTelegramSupportUsername(
  db: Database,
  storeId: string,
): Promise<string | null> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) {
    return null;
  }

  try {
    const rows = await db
      .select({ username: store.telegramSupportUsername })
      .from(store)
      .where(eq(store.id, storeId))
      .limit(1);

    const username = rows[0]?.username;
    return isTelegramSupportUsername(username) ? username : null;
  } catch (error) {
    if (isUndefinedColumnError(error)) {
      return null;
    }

    throw mapDatabaseError(error);
  }
}
