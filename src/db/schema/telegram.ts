import { jsonb, pgTable, text, timestamp, uuid, bigint } from "drizzle-orm/pg-core";

/**
 * `telegram_update` — the deduplication / idempotency log.
 *
 * Every Telegram-derived write starts by inserting here on `update_id` as the
 * **first statement of a `db.batch([...])`**. The insert is the lock: if
 * nothing was inserted, the update was already handled, and because every
 * other write in that batch is idempotent at its own site, a redelivery
 * commits having changed nothing while the webhook answers `200 OK`
 * (DATA_MODEL.md §11.6, §14.6).
 *
 * A transient failure rolls the whole batch back — **including this row** — so
 * the next delivery is a genuine first attempt. `processing_error` records the
 * cause of a failure that was retried rather than rolled back.
 *
 * `payload` holds the raw webhook envelope and is the only customer-prose
 * store outside `inquiry_message`; it is diagnostic bulk that loses value
 * fast, so it is pruned on a schedule after a retention window, keeping
 * `update_id` / `update_type` / `processed_at` as the audit trail. The window
 * is a code constant, configurable outside the database — it is deliberately
 * not a `bot_setting` value, so the seller cannot disable the housekeeping
 * that keeps the table bounded (DATA_MODEL.md §11.3, §12.3, §19.5).
 */
export const telegramUpdate = pgTable("telegram_update", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Telegram update ids are 64-bit; stored as `bigint`, read as a JS number.
  updateId: bigint("update_id", { mode: "number" }).notNull().unique(),
  // e.g. `message`, `callback_query` — the retained audit-trail type.
  updateType: text("update_type").notNull(),
  // Pruned on a schedule (see module doc).
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
  processingError: text("processing_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
