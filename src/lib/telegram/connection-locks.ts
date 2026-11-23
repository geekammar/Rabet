import "server-only";

import { sql } from "drizzle-orm";

import type { TransactionDatabase } from "@/db/transaction-client";

/**
 * Shared per-store advisory lock for connection replacement and COD writes.
 *
 * The activation commit that makes a managed connection `ready` and the
 * commerce transaction that writes an order/cart use the same lock key. A
 * request that passed webhook ingress earlier therefore cannot write after a
 * replacement has committed.
 */
export const CONNECTION_STORE_LOCK_PREFIX = "telegram-connection-store";

type AdvisoryLockDatabase = Pick<TransactionDatabase, "execute">;

export function connectionStoreLockKey(storeId: string): string {
  return `${CONNECTION_STORE_LOCK_PREFIX}:${storeId}`;
}

export async function lockConnectionStore(
  db: AdvisoryLockDatabase,
  storeId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${connectionStoreLockKey(storeId)}))`,
  );
}

/**
 * Shared variant for COD writes. Concurrent buyers may proceed together,
 * while a connection replacement (which takes the exclusive lock) waits until
 * every in-flight COD transaction reaches commit/rollback.
 */
export async function lockConnectionStoreShared(
  db: AdvisoryLockDatabase,
  storeId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock_shared(hashtext(${connectionStoreLockKey(storeId)}))`,
  );
}
