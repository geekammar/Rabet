import "server-only";

import crypto from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { merchantAuthThrottle } from "@/db/schema";

/**
 * Durable, database-backed throttling for merchant authentication.
 *
 * The operator's `admin_login_throttle` is deliberately not reused: merchant
 * traffic must never spend, reset or observe the operator's singleton budget.
 * This limiter stores one row per `(scope, key)` pair, where `key` is always a
 * SHA-256 digest. Raw emails, raw invitation tokens and client addresses are
 * never persisted.
 *
 * Algorithm: the same fixed window anchored at the first attempt as the
 * operator limiter, so the decision and the count are one atomic
 * `INSERT … ON CONFLICT … RETURNING` statement and concurrent requests cannot
 * overshoot the budget. The table is bounded in two ways:
 *
 * - The number of live keys is capped by the fixed window and by pruning rows
 *   older than {@link THROTTLE_RETENTION_SECONDS} on every attempt.
 * - `attempt_count` stops at `max + 1`, so an individual row stays tiny.
 *
 * Policies are intentionally separate per operation:
 *
 * | Scope | Key | Budget |
 * | --- | --- | --- |
 * | `invitation_preview` | invitation token digest | 10 / 15 min |
 * | `invitation_accept` | invitation token digest | 5 / 15 min |
 * | `sign_in` | merchant email digest | 5 / 15 min |
 * | `sign_in_global` | fixed digest | 30 / 15 min |
 *
 * The invitation limits run before the Argon2 password hash and before the
 * transactional acceptance service. The sign-in limits run before any Argon2
 * verification. A missing or unreachable limiter is a closed door: callers
 * deny the attempt.
 */

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
export const THROTTLE_RETENTION_SECONDS = 24 * 60 * 60;

export const INVITATION_PREVIEW_MAX_ATTEMPTS = 10;
export const INVITATION_ACCEPT_MAX_ATTEMPTS = 5;
export const MERCHANT_SIGN_IN_MAX_ATTEMPTS = 5;
export const MERCHANT_SIGN_IN_GLOBAL_MAX_ATTEMPTS = 30;

export type MerchantThrottleScope =
  | "invitation_preview"
  | "invitation_accept"
  | "sign_in"
  | "sign_in_global";

type MerchantThrottlePolicy = {
  maxAttempts: number;
  windowSeconds: number;
};

const POLICIES: Record<MerchantThrottleScope, MerchantThrottlePolicy> = {
  invitation_preview: {
    maxAttempts: INVITATION_PREVIEW_MAX_ATTEMPTS,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  },
  invitation_accept: {
    maxAttempts: INVITATION_ACCEPT_MAX_ATTEMPTS,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  },
  sign_in: {
    maxAttempts: MERCHANT_SIGN_IN_MAX_ATTEMPTS,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  },
  sign_in_global: {
    maxAttempts: MERCHANT_SIGN_IN_GLOBAL_MAX_ATTEMPTS,
    windowSeconds: THROTTLE_WINDOW_SECONDS,
  },
};

export type MerchantThrottleDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type ThrottleResultRow = {
  allowed?: unknown;
  retry_after_seconds?: unknown;
};

/** Minimal database write surface shared by the Neon and postgres-js clients. */
export type MerchantThrottleExecutor = (
  statement: SQL,
) => Promise<unknown>;

/**
 * Hashes any caller-controlled material into the only key shape the table
 * accepts. `material` must already be length-bounded by the caller.
 */
export function merchantThrottleKey(material: string): string {
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

/** The fixed digest used by the coarse global sign-in budget. */
export function merchantGlobalSignInKey(): string {
  return merchantThrottleKey("merchant-sign-in-global");
}

function resultRows(result: unknown): ThrottleResultRow[] {
  if (Array.isArray(result)) return result as ThrottleResultRow[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as ThrottleResultRow[];
  }
  return [];
}

async function pruneExpiredRows(execute: MerchantThrottleExecutor) {
  try {
    await execute(sql`
      DELETE FROM ${merchantAuthThrottle}
      WHERE window_started_at
        <= now() - make_interval(secs => ${THROTTLE_RETENTION_SECONDS})
    `);
  } catch {
    // Pruning is maintenance, not part of the authorization decision. A
    // failed prune must not reject an otherwise valid attempt.
  }
}

/**
 * Atomically consumes one attempt from `(scope, key)`.
 *
 * Throws when the decision cannot be read (missing table, unreachable
 * database, unexpected driver shape). Callers must treat any throw as "deny".
 */
export async function consumeMerchantThrottle(
  execute: MerchantThrottleExecutor,
  input: { scope: MerchantThrottleScope; key: string },
): Promise<MerchantThrottleDecision> {
  const policy = POLICIES[input.scope];

  await pruneExpiredRows(execute);

  const result = await execute(sql`
    INSERT INTO ${merchantAuthThrottle} AS throttle (
      scope,
      key,
      attempt_count,
      window_started_at
    )
    VALUES (${input.scope}, ${input.key}, 1, now())
    ON CONFLICT (scope, key) DO UPDATE SET
      attempt_count = CASE
        WHEN throttle.window_started_at
          <= now() - make_interval(secs => ${policy.windowSeconds})
          THEN 1
        ELSE LEAST(throttle.attempt_count + 1, ${policy.maxAttempts + 1})
      END,
      window_started_at = CASE
        WHEN throttle.window_started_at
          <= now() - make_interval(secs => ${policy.windowSeconds})
          THEN now()
        ELSE throttle.window_started_at
      END
    RETURNING
      attempt_count <= ${policy.maxAttempts} AS allowed,
      GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (
          window_started_at
            + make_interval(secs => ${policy.windowSeconds})
            - now()
        )))
      )::int AS retry_after_seconds
  `);

  const row = resultRows(result)[0];

  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("Merchant throttle returned an unexpected result shape.");
  }

  const retryAfter = Number(row.retry_after_seconds);

  return {
    allowed: row.allowed,
    retryAfterSeconds: Number.isFinite(retryAfter)
      ? Math.max(0, retryAfter)
      : row.allowed
        ? 0
        : policy.windowSeconds,
  };
}

/**
 * Clears one identity's sign-in budget after the password actually verified.
 * The coarse global budget is intentionally not reset.
 */
export async function resetMerchantThrottle(
  execute: MerchantThrottleExecutor,
  input: { scope: MerchantThrottleScope; key: string },
): Promise<void> {
  await execute(sql`
    UPDATE ${merchantAuthThrottle}
    SET attempt_count = 0, window_started_at = now()
    WHERE scope = ${input.scope} AND key = ${input.key}
  `);
}
