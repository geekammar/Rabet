import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * `admin_login_throttle` — durable retry state for the one administrator.
 *
 * The limiter is deliberately one row, not one row per submitted email or
 * client address. The administrator is a single environment-configured
 * identity, so a singleton row is the whole state: arbitrary emails cannot
 * grow the table, and no client-controlled header (including
 * `X-Forwarded-For`) participates in the decision.
 *
 * `window_started_at` anchors a fixed retry window. The first attempt creates
 * the row; subsequent attempts increment `attempt_count` under a row lock, and
 * the first attempt after the window expires starts a fresh window. No cleanup
 * job is needed because the row is reused forever.
 *
 * `id` is constrained to `1` exactly like `bot_setting`, so a second throttle
 * row cannot be written by anything.
 */
export const adminLoginThrottle = pgTable(
  "admin_login_throttle",
  {
    id: smallint("id").primaryKey().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("admin_login_throttle_singleton_check", sql`${table.id} = 1`),
    check(
      "admin_login_throttle_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

/**
 * `merchant_auth_throttle` — durable, merchant-scoped retry state.
 *
 * This is deliberately separate from `admin_login_throttle`: the operator's
 * singleton budget must never be spent by, or become shared with, merchant
 * traffic. Rows are keyed by a scope plus a SHA-256 key digest so the table
 * never stores a raw email address, invitation token or client address.
 *
 * Scopes:
 * - `invitation_preview` — one pending invitation lookup
 * - `invitation_accept`  — one invitation acceptance attempt (before Argon2)
 * - `sign_in`            — one merchant identity's password attempts
 * - `sign_in_global`     — a coarse cap on all merchant password attempts
 *
 * The fixed window is anchored at the first attempt in the same way as the
 * operator limiter. Rows older than the retention horizon are pruned by the
 * limiter itself, so arbitrary keys cannot grow the table forever.
 */
export const merchantAuthThrottle = pgTable(
  "merchant_auth_throttle",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index("merchant_auth_throttle_window_idx").on(table.windowStartedAt),
    check(
      "merchant_auth_throttle_scope_check",
      sql`${table.scope} IN ('invitation_preview', 'invitation_accept', 'sign_in', 'sign_in_global')`,
    ),
    check(
      "merchant_auth_throttle_key_format_check",
      sql`${table.key} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "merchant_auth_throttle_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);
