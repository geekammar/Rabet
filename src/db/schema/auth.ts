import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  smallint,
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
