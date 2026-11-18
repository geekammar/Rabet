import "server-only";

import { sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { adminLoginThrottle } from "@/db/schema";

/**
 * Durable, database-backed throttling for the single administrator's login.
 *
 * The decision and the count live in one PostgreSQL row, so every application
 * instance and both credential entry paths — the login Server Action and the
 * Auth.js credentials callback — share the same budget. The check runs before
 * Argon2 verification; a missing or unreachable limiter is a closed door, not
 * an open one.
 *
 * Algorithm: a fixed window anchored at the first attempt.
 *
 *   - At most {@link LOGIN_MAX_ATTEMPTS} attempts are allowed per window.
 *   - Attempts beyond the budget keep the row at `max + 1`, so the table stays
 *     a single bounded row and does not need a cleanup job.
 *   - Once the window elapses, the next attempt resets the counter to one and
 *     starts a new window; that is how a legitimate administrator retries.
 *   - A successful verification resets the row (see `resetLoginThrottle`), so
 *     normal sign-ins do not consume the failure budget.
 *
 * Why five attempts in fifteen minutes for one account: the credential is a
 * long, memory-hard Argon2id password on exactly one env-configured identity,
 * so five covers ordinary typo/caps-lock retries, while the window cuts a
 * remote guesser to at most twenty attempts per hour even if they spread
 * requests across hosts. The window is deliberately short enough that a locked
 * administrator can try again without operator intervention.
 */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

export type LoginAttemptDecision = {
  /** True when this attempt is within the current window's budget. */
  allowed: boolean;
  /** Seconds until the current window expires; meaningful when denied. */
  retryAfterSeconds: number;
};

type ThrottleResultRow = {
  allowed?: unknown;
  retry_after_seconds?: unknown;
};

function resultRows(result: unknown): ThrottleResultRow[] {
  if (Array.isArray(result)) return result as ThrottleResultRow[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as ThrottleResultRow[];
  }
  return [];
}

/**
 * Atomically consumes one attempt from the shared admin budget.
 *
 * The whole decision is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement. PostgreSQL serializes concurrent writers on the singleton row, so
 * concurrent requests cannot all read the same count and exceed the budget.
 *
 * Throws when the result cannot be read (missing table, unreachable database,
 * unexpected driver shape). Callers must treat any throw as "deny".
 */
export async function consumeLoginAttempt(
  db: Database = getDb(),
): Promise<LoginAttemptDecision> {
  const result = await db.execute<ThrottleResultRow>(sql`
    INSERT INTO ${adminLoginThrottle} AS throttle (
      id,
      attempt_count,
      window_started_at
    )
    VALUES (1, 1, now())
    ON CONFLICT (id) DO UPDATE SET
      attempt_count = CASE
        WHEN throttle.window_started_at
          <= now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS})
          THEN 1
        ELSE LEAST(throttle.attempt_count + 1, ${LOGIN_MAX_ATTEMPTS + 1})
      END,
      window_started_at = CASE
        WHEN throttle.window_started_at
          <= now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS})
          THEN now()
        ELSE throttle.window_started_at
      END
    RETURNING
      attempt_count <= ${LOGIN_MAX_ATTEMPTS} AS allowed,
      GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (
          window_started_at
            + make_interval(secs => ${LOGIN_WINDOW_SECONDS})
            - now()
        )))
      )::int AS retry_after_seconds
  `);

  const row = resultRows(result)[0];

  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("Login throttle returned an unexpected result shape.");
  }

  const retryAfter = Number(row.retry_after_seconds);

  return {
    allowed: row.allowed,
    retryAfterSeconds: Number.isFinite(retryAfter)
      ? Math.max(0, retryAfter)
      : row.allowed
        ? 0
        : LOGIN_WINDOW_SECONDS,
  };
}

/**
 * Clears the budget after a credential pair has actually verified.
 *
 * This is best-effort from the caller's perspective: if the reset fails, the
 * login still succeeded and the old count remains in place, which is safe. The
 * next window expiry clears it regardless.
 */
export async function resetLoginThrottle(
  db: Database = getDb(),
): Promise<void> {
  await db.execute(sql`
    UPDATE ${adminLoginThrottle}
    SET attempt_count = 0, window_started_at = now()
    WHERE id = 1
  `);
}
