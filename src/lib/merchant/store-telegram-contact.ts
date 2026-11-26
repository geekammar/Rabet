import "server-only";

import { eq } from "drizzle-orm";

import { store } from "@/db/schema";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import type { TransactionDatabase } from "@/db/transaction-client";
import { resolveMerchantEligibility } from "@/lib/merchant/eligibility";
import { parseTelegramSupportUsername } from "@/lib/telegram/support-contact";

export type MerchantTelegramSupportResult =
  | { ok: true; username: string | null }
  | { ok: false; error: "UNAVAILABLE" | "DENIED" | "INVALID_USERNAME" };

/**
 * Saves or clears the authenticated merchant's Telegram support contact.
 *
 * The submitted value is normalized before any write: `@username` and
 * `https://t.me/username` both become the bare username, while an empty value
 * clears the column. The write re-checks the same database-backed eligibility
 * rule as the request that rendered the form, so a suspended store, revoked
 * membership, stale session version or disabled user cannot save through an
 * already-open page.
 *
 * Only the server-minted store scope is used as the update target; no store id
 * from the browser participates. A store B scope paired with a store A user is
 * rejected rather than writing across tenants.
 */
export async function saveMerchantTelegramSupport(
  db: TransactionDatabase,
  access: MerchantAccess,
  input: { username: unknown },
): Promise<MerchantTelegramSupportResult> {
  if (access.readOnly) {
    return { ok: false, error: "DENIED" };
  }

  const parsed = parseTelegramSupportUsername(input.username);

  if (!parsed.ok) {
    return { ok: false, error: "INVALID_USERNAME" };
  }

  try {
    return await db.transaction(async (tx) => {
      const eligibility = await resolveMerchantEligibility(
        tx as unknown as TransactionDatabase,
        {
          userId: access.userId,
          sessionVersion: access.sessionVersion,
        },
      );

      if (
        !eligibility ||
        eligibility.readOnly ||
        eligibility.store.id !== access.scope.storeId
      ) {
        return { ok: false, error: "DENIED" } as const;
      }

      await tx
        .update(store)
        .set({
          telegramSupportUsername: parsed.username,
          updatedAt: new Date(),
        })
        .where(eq(store.id, access.scope.storeId));

      return { ok: true, username: parsed.username } as const;
    });
  } catch {
    console.error("Merchant Telegram support contact update failed.");
    return { ok: false, error: "UNAVAILABLE" };
  }
}
