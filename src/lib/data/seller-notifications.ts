import "server-only";

import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  sellerNotificationDelivery,
  sellerNotificationSetting,
} from "@/db/schema";
import { mapDatabaseError, RabetDataError } from "./errors";

export interface SellerNotificationCapability {
  supported: boolean;
  reason?: string;
}

export type SellerNotificationSettingRecord = typeof sellerNotificationSetting.$inferSelect;
export type SellerNotificationDeliveryRecord = typeof sellerNotificationDelivery.$inferSelect;

export const PRIVATE_CHAT_ID_REGEX = /^[1-9][0-9]{4,19}$/;

/**
 * Validates a Telegram private chat ID:
 * Must be a decimal string representing a positive 64-bit integer.
 * Rejects group/channel IDs (negative), usernames (@), URLs, and non-numeric input.
 */
export function validatePrivateChatId(chatId: string): boolean {
  if (typeof chatId !== "string") return false;
  const trimmed = chatId.trim();
  if (!PRIVATE_CHAT_ID_REGEX.test(trimmed)) return false;
  try {
    const val = BigInt(trimmed);
    return val > BigInt(0) && val <= BigInt("9223372036854775807");
  } catch {
    return false;
  }
}

/**
 * Generates a short, unambiguous reference for delivery records.
 * Format: SND- followed by 6 uppercase alphanumeric characters.
 */
export function generateDeliveryReference(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `SND-${code}`;
}

/**
 * Checks whether the database schema supports seller notifications.
 * Does NOT throw on missing tables; returns supported: false.
 */
export async function checkSellerNotificationCapability(
  db: Database,
): Promise<SellerNotificationCapability> {
  try {
    const result = await db.execute<{
      has_setting: boolean;
      has_delivery: boolean;
    }>(sql`
      SELECT
        to_regclass('public.seller_notification_setting') IS NOT NULL AS has_setting,
        to_regclass('public.seller_notification_delivery') IS NOT NULL AS has_delivery
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = Array.isArray(rawRows) ? rawRows : [];
    const row = rows[0] as { has_setting?: boolean; has_delivery?: boolean } | undefined;
    if (!row) {
      return { supported: false, reason: "Capability check returned no result." };
    }

    const hasSetting = Boolean(row.has_setting);
    const hasDelivery = Boolean(row.has_delivery);

    if (hasSetting && hasDelivery) {
      return { supported: true };
    }

    const missing: string[] = [];
    if (!hasSetting) missing.push("seller_notification_setting table");
    if (!hasDelivery) missing.push("seller_notification_delivery table");

    return {
      supported: false,
      reason: `Database is missing required objects: ${missing.join(", ")}. Pending migration 0003_seller_notifications must be applied.`,
    };
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Reads the singleton seller notification setting.
 * Returns null if the table does not exist or has no row.
 */
export async function readSellerNotificationConfig(
  db: Database,
): Promise<SellerNotificationSettingRecord | null> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return null;

  try {
    const [row] = await db
      .select()
      .from(sellerNotificationSetting)
      .where(eq(sellerNotificationSetting.id, 1))
      .limit(1);

    return row ?? null;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export interface VerifiedSellerNotificationConfig {
  revision: number;
  destinationChatId: string;
  language: "ar" | "en";
  verifiedBotId: number;
  verifiedBotUsername: string | null;
}

/**
 * Returns verified notification config if enabled and fully verified; null otherwise.
 * Safe to call in customer webhook path (will not crash if migration pending).
 */
export async function getVerifiedNotificationConfig(
  db: Database,
): Promise<VerifiedSellerNotificationConfig | null> {
  const setting = await readSellerNotificationConfig(db);
  if (!setting) return null;

  if (
    !setting.enabled ||
    !setting.destinationChatId ||
    !setting.verifiedAt ||
    !setting.verifiedBotId ||
    setting.verifiedChatId !== setting.destinationChatId
  ) {
    return null;
  }

  return {
    revision: setting.revision,
    destinationChatId: setting.destinationChatId,
    language: setting.language === "en" ? "en" : "ar",
    verifiedBotId: setting.verifiedBotId,
    verifiedBotUsername: setting.verifiedBotUsername,
  };
}

function mapSettingRow(row: Record<string, unknown>): SellerNotificationSettingRecord {
  return {
    id: Number(row.id ?? 1),
    enabled: Boolean(row.enabled),
    destinationChatId:
      (row.destination_chat_id as string | null) ??
      (row.destinationChatId as string | null) ??
      null,
    language: (row.language === "en" ? "en" : "ar") as "ar" | "en",
    verifiedAt: row.verified_at
      ? new Date(row.verified_at as string | number | Date)
      : row.verifiedAt
      ? new Date(row.verifiedAt as string | number | Date)
      : null,
    verifiedBotId:
      row.verified_bot_id !== null && row.verified_bot_id !== undefined
        ? Number(row.verified_bot_id)
        : row.verifiedBotId !== null && row.verifiedBotId !== undefined
        ? Number(row.verifiedBotId)
        : null,
    verifiedBotUsername:
      (row.verified_bot_username as string | null) ??
      (row.verifiedBotUsername as string | null) ??
      null,
    verifiedChatId:
      (row.verified_chat_id as string | null) ??
      (row.verifiedChatId as string | null) ??
      null,
    revision: Number(row.revision ?? 1),
    lastTestAt: row.last_test_at
      ? new Date(row.last_test_at as string | number | Date)
      : row.lastTestAt
      ? new Date(row.lastTestAt as string | number | Date)
      : null,
    createdAt: row.created_at
      ? new Date(row.created_at as string | number | Date)
      : row.createdAt
      ? new Date(row.createdAt as string | number | Date)
      : new Date(),
    updatedAt: row.updated_at
      ? new Date(row.updated_at as string | number | Date)
      : row.updatedAt
      ? new Date(row.updatedAt as string | number | Date)
      : new Date(),
  };
}

export interface SaveSellerNotificationInput {
  destinationChatId?: string | null;
  language?: "ar" | "en";
}

/**
 * Saves destinationChatId and/or language.
 * Changing destinationChatId invalidates prior verification, disables notifications,
 * increments revision, and cancels obsolete pending deliveries bound to older revisions.
 */
export async function saveSellerNotificationConfig(
  db: Database,
  input: SaveSellerNotificationInput,
): Promise<SellerNotificationSettingRecord> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) {
    throw new RabetDataError(
      "SCHEMA_UPGRADE_REQUIRED",
      cap.reason ?? "Database schema does not support seller notifications.",
    );
  }

  const existing = await readSellerNotificationConfig(db);

  let destination = input.destinationChatId !== undefined ? input.destinationChatId : existing?.destinationChatId ?? null;
  if (destination) {
    destination = destination.trim();
    if (!validatePrivateChatId(destination)) {
      throw new RabetDataError(
        "INVALID_INPUT",
        "Destination chat ID must be a numeric private Telegram chat ID (decimal digits only, no '@' or channel IDs).",
      );
    }
  } else {
    destination = null;
  }

  const language = input.language !== undefined ? input.language : existing?.language ?? "ar";
  if (language !== "ar" && language !== "en") {
    throw new RabetDataError("INVALID_INPUT", "Notification language must be 'ar' or 'en'.");
  }

  try {
    const result = await db.execute(sql`
      INSERT INTO ${sellerNotificationSetting} (
        id, enabled, destination_chat_id, language, verified_at, verified_bot_id, verified_bot_username, verified_chat_id, revision, created_at, updated_at
      )
      VALUES (
        1, false, ${destination}, ${language}, NULL, NULL, NULL, NULL, 1, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        destination_chat_id = ${destination},
        language = ${language},
        enabled = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN false
          ELSE seller_notification_setting.enabled
        END,
        verified_at = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN NULL
          ELSE seller_notification_setting.verified_at
        END,
        verified_bot_id = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN NULL
          ELSE seller_notification_setting.verified_bot_id
        END,
        verified_bot_username = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN NULL
          ELSE seller_notification_setting.verified_bot_username
        END,
        verified_chat_id = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN NULL
          ELSE seller_notification_setting.verified_chat_id
        END,
        revision = CASE
          WHEN seller_notification_setting.destination_chat_id IS DISTINCT FROM ${destination} THEN seller_notification_setting.revision + 1
          ELSE seller_notification_setting.revision
        END,
        updated_at = now()
      RETURNING *
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    const saved = mapSettingRow(rows[0]);

    if (saved.revision > 1 && existing && existing.destinationChatId !== destination) {
      await cancelObsoleteDeliveriesForRevision(db, saved.revision);
    }

    return saved;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Persists test success with configuration compare-and-set semantics:
 * Only marks verified if the destination and revision currently in the database match
 * the expected snapshot tested. Never overwrites a newer destination saved concurrently.
 * A harmless repeat test of the SAME bot and destination does not increment revision.
 */
export async function recordVerificationSuccess(
  db: Database,
  input: {
    botId: number;
    botUsername?: string | null;
    destinationChatId?: string;
    expectedRevision?: number;
    expectedDestination?: string;
  },
): Promise<SellerNotificationSettingRecord> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) {
    throw new RabetDataError("SCHEMA_UPGRADE_REQUIRED", cap.reason ?? "Schema upgrade required.");
  }

  const destination = input.expectedDestination ?? input.destinationChatId;
  const revisionFilter = input.expectedRevision !== undefined
    ? sql`AND revision = ${input.expectedRevision}::int`
    : sql``;
  const destinationFilter = destination !== undefined
    ? sql`AND destination_chat_id = ${destination}::text`
    : sql``;

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationSetting}
      SET
        verified_at = now(),
        verified_bot_id = ${input.botId}::bigint,
        verified_bot_username = ${input.botUsername ?? null}::text,
        verified_chat_id = destination_chat_id,
        last_test_at = now(),
        updated_at = now()
      WHERE id = 1
        ${revisionFilter}
        ${destinationFilter}
      RETURNING *
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];

    if (rows.length === 0) {
      throw new RabetDataError(
        "CONFIGURATION_CHANGED",
        "Notification settings were updated or destination changed while verification was in flight.",
      );
    }

    return mapSettingRow(rows[0]);
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Toggles the enabled state of seller notifications.
 * Atomically verifies that the current bot identity matches the verified bot,
 * destination matches the verified destination, and verifiedAt is present.
 */
export async function setSellerNotificationEnabled(
  db: Database,
  enabled: boolean,
  currentBotId?: number,
): Promise<SellerNotificationSettingRecord> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) {
    throw new RabetDataError("SCHEMA_UPGRADE_REQUIRED", cap.reason ?? "Schema upgrade required.");
  }

  try {
    if (enabled) {
      const result = await db.execute(sql`
        UPDATE ${sellerNotificationSetting}
        SET
          enabled = true,
          updated_at = now()
        WHERE id = 1
          AND destination_chat_id IS NOT NULL
          AND verified_at IS NOT NULL
          AND verified_bot_id IS NOT NULL
          AND verified_chat_id = destination_chat_id
          AND (
            ${currentBotId ?? null}::bigint IS NULL
            OR verified_bot_id = ${currentBotId ?? null}::bigint
          )
        RETURNING *
      `);

      const rawRows: unknown = Array.isArray(result)
        ? result
        : (result as { rows?: unknown[] })?.rows;
      const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];

      if (rows.length === 0) {
        const current = await readSellerNotificationConfig(db);
        if (!current?.destinationChatId) {
          throw new RabetDataError("INVALID_INPUT", "Cannot enable notifications: destination chat ID is not configured.");
        }
        if (!current.verifiedAt || !current.verifiedBotId || current.verifiedChatId !== current.destinationChatId) {
          throw new RabetDataError(
            "INVALID_INPUT",
            "Cannot enable notifications: destination has not been verified. Send a successful test notification first.",
          );
        }
        if (currentBotId !== undefined && current.verifiedBotId !== currentBotId) {
          throw new RabetDataError(
            "INVALID_INPUT",
            "Cannot enable notifications: configured bot token belongs to a different bot than was verified. Run a new test notification first.",
          );
        }
        throw new RabetDataError("INVALID_INPUT", "Cannot enable notifications: settings are not verified.");
      }

      return mapSettingRow(rows[0]);
    } else {
      const result = await db.execute(sql`
        UPDATE ${sellerNotificationSetting}
        SET
          enabled = false,
          updated_at = now()
        WHERE id = 1
        RETURNING *
      `);

      const rawRows: unknown = Array.isArray(result)
        ? result
        : (result as { rows?: unknown[] })?.rows;
      const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
      if (rows.length === 0) {
        throw new RabetDataError("NOT_FOUND", "Notification settings not found.");
      }
      return mapSettingRow(rows[0]);
    }
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Server-side atomic rate limiter / cooldown for test operations.
 * Atomically updates last_test_at only if current time is outside cooldown.
 * Only one concurrent call can succeed; persistence failure blocks test send.
 */
export async function claimTestCooldown(
  db: Database,
  cooldownSeconds = 5,
): Promise<{ allowed: boolean; remainingSeconds?: number; reason?: string }> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) {
    throw new RabetDataError("SCHEMA_UPGRADE_REQUIRED", cap.reason ?? "Schema upgrade required.");
  }

  try {
    const result = await db.execute(sql`
      INSERT INTO ${sellerNotificationSetting} (
        id,
        enabled,
        language,
        revision,
        last_test_at,
        created_at,
        updated_at
      )
      VALUES (
        1,
        false,
        'ar',
        1,
        now(),
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE
      SET
        last_test_at = now(),
        updated_at = now()
      WHERE seller_notification_setting.last_test_at IS NULL
         OR seller_notification_setting.last_test_at <= now() - (${cooldownSeconds} || ' seconds')::interval
      RETURNING last_test_at
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];

    if (rows.length > 0) {
      return { allowed: true };
    }

    // Determine why claim failed: missing configuration or active cooldown/rate-limit
    const check = await db.execute(sql`
      SELECT
        id,
        last_test_at,
        extract(epoch from (
          greatest(last_test_at, now()) + (${cooldownSeconds} * interval '1 second') - now()
        ))::int AS remaining_seconds,
        extract(epoch from (last_test_at - now()))::int AS future_seconds
      FROM ${sellerNotificationSetting}
      WHERE id = 1
      LIMIT 1
    `);

    const checkRows = (Array.isArray(check) ? check : (check as { rows?: unknown[] })?.rows || []) as Record<string, unknown>[];
    if (checkRows.length === 0) {
      return { allowed: false, reason: "missing_configuration" };
    }

    const row = checkRows[0];
    const futureSec = Math.max(0, Number(row.future_seconds ?? 0));
    const remainingSec = Math.max(1, futureSec > 0 ? futureSec : Number(row.remaining_seconds ?? cooldownSeconds));

    return {
      allowed: false,
      remainingSeconds: remainingSec,
      reason: futureSec > 0 ? "rate_limited" : "cooldown_active",
    };
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function recordTestRateLimited(
  db: Database,
  retryAfterSeconds: number,
): Promise<void> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return;

  try {
    await db.execute(sql`
      UPDATE ${sellerNotificationSetting}
      SET
        last_test_at = now() + (${retryAfterSeconds} || ' seconds')::interval,
        updated_at = now()
      WHERE id = 1
    `);
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function checkAndRecordTestCooldown(
  db: Database,
  cooldownSeconds = 5,
): Promise<{ allowed: boolean; remainingSeconds?: number; reason?: string }> {
  return claimTestCooldown(db, cooldownSeconds);
}

/**
 * Lists recent seller notification deliveries for the dashboard.
 * Recovers any expired sending records to 'unknown' before listing.
 */
export async function listSellerNotificationDeliveries(
  db: Database,
  limit = 20,
): Promise<SellerNotificationDeliveryRecord[]> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return [];

  try {
    // Atomically recover any expired sending leases to 'unknown'
    await recoverExpiredSendingDeliveries(db);

    const rows = await db
      .select()
      .from(sellerNotificationDelivery)
      .orderBy(sql`${sellerNotificationDelivery.createdAt} DESC`)
      .limit(Math.min(limit, 100));

    return rows;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function getSellerNotificationDelivery(
  db: Database,
  id: string,
): Promise<SellerNotificationDeliveryRecord | null> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return null;

  try {
    const [row] = await db
      .select()
      .from(sellerNotificationDelivery)
      .where(eq(sellerNotificationDelivery.id, id))
      .limit(1);

    return row ?? null;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

function mapDeliveryRow(row: Record<string, unknown>): SellerNotificationDeliveryRecord {
  return {
    id: String(row.id),
    eventType: String(row.event_type ?? row.eventType ?? "new_inquiry"),
    inquiryId: String(row.inquiry_id ?? row.inquiryId),
    reference: String(row.reference),
    revision: Number(row.revision),
    destinationChatId: String(row.destination_chat_id ?? row.destinationChatId),
    status: (row.status as SellerNotificationDeliveryRecord["status"]) ?? "pending",
    claimAttemptId: (row.claim_attempt_id ?? row.claimAttemptId ?? null) as string | null,
    claimExpiresAt: row.claim_expires_at
      ? new Date(row.claim_expires_at as string | Date)
      : ((row.claimExpiresAt as Date | null) ?? null),
    attemptCount: Number(row.attempt_count ?? row.attemptCount ?? 0),
    telegramMessageId: row.telegram_message_id
      ? Number(row.telegram_message_id)
      : ((row.telegramMessageId as number | null) ?? null),
    errorCategory: (row.error_category ?? row.errorCategory ?? null) as string | null,
    retryAfterUntil: row.retry_after_until
      ? new Date(row.retry_after_until as string | Date)
      : ((row.retryAfterUntil as Date | null) ?? null),
    sentAt: row.sent_at
      ? new Date(row.sent_at as string | Date)
      : ((row.sentAt as Date | null) ?? null),
    failedAt: row.failed_at
      ? new Date(row.failed_at as string | Date)
      : ((row.failedAt as Date | null) ?? null),
    createdAt: row.created_at
      ? new Date(row.created_at as string | Date)
      : ((row.createdAt as Date) ?? new Date()),
    updatedAt: row.updated_at
      ? new Date(row.updated_at as string | Date)
      : ((row.updatedAt as Date) ?? new Date()),
  };
}

export interface ClaimDeliveryAttemptOptions {
  attemptId?: string;
  leaseMs?: number;
  acknowledgeUnknownRisk?: boolean;
}

export type ClaimDeliveryResult =
  | { claimed: true; record: SellerNotificationDeliveryRecord }
  | {
      claimed: false;
      reason:
        | "not_found"
        | "already_sent"
        | "cancelled"
        | "in_flight"
        | "requires_duplicate_acknowledgment"
        | "rate_limited";
      retryAfterSeconds?: number;
      retryAfterUntil?: Date;
      messageId?: number;
      errorCategory?: string;
    };

/**
 * Atomically claims a delivery record for sending.
 * Follows strict safety rules:
 * - Expired sending leases are recovered to 'unknown' with category 'lease_expired'.
 * - Records in 'unknown' require explicit acknowledgeUnknownRisk: true to be claimed.
 * - Records in 'sending' with active lease return 'in_flight'.
 * - Records in 'sent' or 'cancelled' cannot be claimed.
 */
export async function claimDeliveryAttemptDetailed(
  db: Database,
  deliveryId: string,
  attemptIdOrOptions?: string | ClaimDeliveryAttemptOptions,
  leaseMsArg = 60_000,
  optionsArg?: { acknowledgeUnknownRisk?: boolean },
): Promise<ClaimDeliveryResult> {
  let effectiveAttemptId: string;
  let effectiveLeaseMs: number;
  let acknowledgeUnknownRisk: boolean;

  if (typeof attemptIdOrOptions === "string") {
    effectiveAttemptId = attemptIdOrOptions;
    effectiveLeaseMs = leaseMsArg;
    acknowledgeUnknownRisk = Boolean(optionsArg?.acknowledgeUnknownRisk);
  } else {
    effectiveAttemptId = attemptIdOrOptions?.attemptId ?? crypto.randomUUID();
    effectiveLeaseMs = attemptIdOrOptions?.leaseMs ?? leaseMsArg;
    acknowledgeUnknownRisk = Boolean(attemptIdOrOptions?.acknowledgeUnknownRisk);
  }

  try {
    // 1. Recover expired sending for this delivery if any
    await recoverExpiredSendingDeliveries(db, deliveryId);

    // 2. Attempt atomic claim
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'sending',
        claim_attempt_id = ${effectiveAttemptId}::text,
        claim_expires_at = now() + (${effectiveLeaseMs} || ' milliseconds')::interval,
        attempt_count = attempt_count + 1,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND (
          status = 'pending'
          OR status = 'failed'
          OR (status = 'unknown' AND ${acknowledgeUnknownRisk}::boolean = true)
        )
        AND (retry_after_until IS NULL OR retry_after_until <= now())
      RETURNING *
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];

    if (rows.length > 0) {
      return { claimed: true, record: mapDeliveryRow(rows[0]) };
    }

    // 3. Inspect why claim failed
    const existing = await getSellerNotificationDelivery(db, deliveryId);
    if (!existing) {
      return { claimed: false, reason: "not_found" };
    }
    if (existing.status === "sent") {
      return { claimed: false, reason: "already_sent" };
    }
    if (existing.status === "cancelled") {
      return { claimed: false, reason: "cancelled" };
    }
    if (existing.status === "unknown") {
      return { claimed: false, reason: "requires_duplicate_acknowledgment" };
    }
    if (existing.status === "sending") {
      return { claimed: false, reason: "in_flight" };
    }
    if (existing.retryAfterUntil && existing.retryAfterUntil.getTime() > Date.now()) {
      const remaining = Math.ceil((existing.retryAfterUntil.getTime() - Date.now()) / 1000);
      return { claimed: false, reason: "rate_limited", retryAfterSeconds: remaining };
    }

    return { claimed: false, reason: "in_flight" };
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function claimDeliveryAttempt(
  db: Database,
  deliveryId: string,
  attemptIdOrOptions?: string | ClaimDeliveryAttemptOptions,
  leaseMsArg = 60_000,
  optionsArg?: { acknowledgeUnknownRisk?: boolean },
): Promise<SellerNotificationDeliveryRecord | null> {
  const outcome = await claimDeliveryAttemptDetailed(
    db,
    deliveryId,
    attemptIdOrOptions,
    leaseMsArg,
    optionsArg,
  );
  return outcome.claimed ? outcome.record : null;
}

export async function markDeliverySent(
  db: Database,
  deliveryIdOrInput:
    | string
    | {
        deliveryId: string;
        claimAttemptId: string;
        telegramMessageId: number;
      },
  attemptIdArg?: string,
  telegramMessageIdArg?: number,
): Promise<boolean> {
  let deliveryId: string;
  let attemptId: string | undefined;
  let messageId: number;

  if (typeof deliveryIdOrInput === "object") {
    deliveryId = deliveryIdOrInput.deliveryId;
    attemptId = deliveryIdOrInput.claimAttemptId;
    messageId = deliveryIdOrInput.telegramMessageId;
  } else {
    deliveryId = deliveryIdOrInput;
    attemptId = attemptIdArg;
    messageId = telegramMessageIdArg!;
  }

  if (!attemptId) {
    throw new RabetDataError("INVALID_INPUT", "markDeliverySent requires an active claimAttemptId.");
  }

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'sent',
        telegram_message_id = ${messageId}::bigint,
        sent_at = now(),
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        error_category = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status = 'sending'
        AND claim_attempt_id = ${attemptId}::text
      RETURNING id
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length > 0;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function markDeliveryFailed(
  db: Database,
  deliveryIdOrInput:
    | string
    | {
        deliveryId: string;
        claimAttemptId: string;
        errorCategory: string;
        errorSummary?: string;
        retryAfterSeconds?: number;
        retryAfter?: Date;
      },
  attemptIdArg?: string,
  errorCategoryArg?: string,
  retryAfterSecondsArg?: number,
): Promise<{ status: "failed"; errorCategory: string; applied: boolean }> {
  let deliveryId: string;
  let attemptId: string | undefined;
  let errorCategory: string;
  let retryAfterSeconds: number | undefined;
  let retryAfterDate: Date | undefined;

  if (typeof deliveryIdOrInput === "object") {
    deliveryId = deliveryIdOrInput.deliveryId;
    attemptId = deliveryIdOrInput.claimAttemptId;
    errorCategory = deliveryIdOrInput.errorCategory;
    retryAfterSeconds = deliveryIdOrInput.retryAfterSeconds;
    retryAfterDate = deliveryIdOrInput.retryAfter;
  } else {
    deliveryId = deliveryIdOrInput;
    attemptId = attemptIdArg;
    errorCategory = errorCategoryArg!;
    retryAfterSeconds = retryAfterSecondsArg;
  }

  if (!attemptId) {
    throw new RabetDataError("INVALID_INPUT", "markDeliveryFailed requires an active claimAttemptId.");
  }

  try {
    const retryAfterSql = retryAfterDate
      ? sql`${retryAfterDate.toISOString()}::timestamptz`
      : typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? sql`now() + (${retryAfterSeconds} || ' seconds')::interval`
      : sql`NULL`;

    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'failed',
        error_category = ${errorCategory}::text,
        retry_after_until = ${retryAfterSql},
        failed_at = now(),
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status = 'sending'
        AND claim_attempt_id = ${attemptId}::text
      RETURNING id
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return { status: "failed", errorCategory, applied: rows.length > 0 };
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function markDeliveryUnknown(
  db: Database,
  deliveryIdOrInput:
    | string
    | {
        deliveryId: string;
        claimAttemptId: string;
        errorCategory?: string;
        errorSummary?: string;
      },
  attemptIdArg?: string,
  errorCategoryArg = "timeout",
): Promise<{ status: "unknown"; errorCategory: string; applied: boolean }> {
  let deliveryId: string;
  let attemptId: string | undefined;
  let errorCategory: string;

  if (typeof deliveryIdOrInput === "object") {
    deliveryId = deliveryIdOrInput.deliveryId;
    attemptId = deliveryIdOrInput.claimAttemptId;
    errorCategory = deliveryIdOrInput.errorCategory ?? "timeout";
  } else {
    deliveryId = deliveryIdOrInput;
    attemptId = attemptIdArg;
    errorCategory = errorCategoryArg;
  }

  if (!attemptId) {
    throw new RabetDataError("INVALID_INPUT", "markDeliveryUnknown requires an active claimAttemptId.");
  }

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'unknown',
        error_category = ${errorCategory}::text,
        failed_at = now(),
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status = 'sending'
        AND claim_attempt_id = ${attemptId}::text
      RETURNING id
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return { status: "unknown", errorCategory, applied: rows.length > 0 };
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function markDeliveryCancelledByWorker(
  db: Database,
  paramsOrId:
    | {
        deliveryId: string;
        claimAttemptId: string;
        reason: string;
      }
    | string,
  attemptIdArg?: string,
  reasonArg?: string,
): Promise<boolean> {
  const deliveryId = typeof paramsOrId === "string" ? paramsOrId : paramsOrId.deliveryId;
  const claimAttemptId =
    typeof paramsOrId === "string" ? attemptIdArg ?? "" : paramsOrId.claimAttemptId;
  const reason = typeof paramsOrId === "string" ? reasonArg ?? "cancelled" : paramsOrId.reason;

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'cancelled',
        error_category = ${reason}::text,
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status = 'sending'
        AND claim_attempt_id = ${claimAttemptId}::text
      RETURNING id
    `);
    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length > 0;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function releaseDeliveryClaim(
  db: Database,
  paramsOrDeliveryId:
    | string
    | {
        deliveryId: string;
        claimAttemptId: string;
        targetStatus?: "pending" | "failed";
      },
  claimAttemptIdArg?: string,
  targetStatusArg?: "pending" | "failed",
): Promise<boolean> {
  const deliveryId =
    typeof paramsOrDeliveryId === "string"
      ? paramsOrDeliveryId
      : paramsOrDeliveryId.deliveryId;
  const claimAttemptId =
    typeof paramsOrDeliveryId === "string"
      ? (claimAttemptIdArg ?? "")
      : paramsOrDeliveryId.claimAttemptId;
  const target =
    typeof paramsOrDeliveryId === "string"
      ? (targetStatusArg ?? "pending")
      : (paramsOrDeliveryId.targetStatus ?? "pending");

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = ${target}::text,
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status = 'sending'
        AND claim_attempt_id = ${claimAttemptId}::text
      RETURNING id
    `);
    const count = (result as { rowCount?: number })?.rowCount ?? (Array.isArray(result) ? result.length : 0);
    return count > 0;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function cancelObsoleteDeliveriesForRevision(
  db: Database,
  currentRevision: number,
): Promise<number> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return 0;

  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'cancelled',
        error_category = 'incompatible_configuration',
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE revision < ${currentRevision}
        AND status != 'sent'
        AND status != 'cancelled'
      RETURNING id
    `);
    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function recoverExpiredSendingDeliveries(
  db: Database,
  deliveryId?: string,
): Promise<number> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return 0;

  try {
    const idFilter = deliveryId ? sql`AND id = ${deliveryId}::uuid` : sql``;
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'unknown',
        error_category = 'lease_expired',
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        failed_at = coalesce(failed_at, now()),
        updated_at = now()
      WHERE status = 'sending'
        AND (claim_expires_at IS NULL OR claim_expires_at < now())
        ${idFilter}
      RETURNING id
    `);
    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function markDeliveryCancelled(
  db: Database,
  deliveryId: string,
  reason = "incompatible_configuration",
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'cancelled',
        error_category = ${reason}::text,
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        AND status != 'sent'
      RETURNING id
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length > 0;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}
