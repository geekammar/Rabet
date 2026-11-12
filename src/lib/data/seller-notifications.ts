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

export interface SaveSellerNotificationInput {
  destinationChatId?: string | null;
  language?: "ar" | "en";
}

/**
 * Saves destinationChatId and/or language.
 * Changing destinationChatId invalidates prior verification, disables notifications,
 * and increments revision.
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

  const destinationChanged = existing && existing.destinationChatId !== destination;

  const newRevision = destinationChanged ? (existing?.revision ?? 1) + 1 : existing?.revision ?? 1;
  const newEnabled = destinationChanged ? false : (existing?.enabled ?? false);
  const newVerifiedAt = destinationChanged ? null : existing?.verifiedAt ?? null;
  const newVerifiedBotId = destinationChanged ? null : existing?.verifiedBotId ?? null;
  const newVerifiedBotUsername = destinationChanged ? null : existing?.verifiedBotUsername ?? null;
  const newVerifiedChatId = destinationChanged ? null : existing?.verifiedChatId ?? null;

  try {
    const [saved] = await db
      .insert(sellerNotificationSetting)
      .values({
        id: 1,
        enabled: newEnabled,
        destinationChatId: destination,
        language,
        verifiedAt: newVerifiedAt,
        verifiedBotId: newVerifiedBotId,
        verifiedBotUsername: newVerifiedBotUsername,
        verifiedChatId: newVerifiedChatId,
        revision: newRevision,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sellerNotificationSetting.id,
        set: {
          enabled: newEnabled,
          destinationChatId: destination,
          language,
          verifiedAt: newVerifiedAt,
          verifiedBotId: newVerifiedBotId,
          verifiedBotUsername: newVerifiedBotUsername,
          verifiedChatId: newVerifiedChatId,
          revision: newRevision,
          updatedAt: new Date(),
        },
      })
      .returning();

    return saved;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Persists test success: marks the exact destination and bot identity as verified,
 * and increments revision so old pending attempts with different settings cannot be delivered.
 */
export async function recordVerificationSuccess(
  db: Database,
  input: {
    botId: number;
    botUsername?: string | null;
    destinationChatId: string;
  },
): Promise<SellerNotificationSettingRecord> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) {
    throw new RabetDataError("SCHEMA_UPGRADE_REQUIRED", cap.reason ?? "Schema upgrade required.");
  }

  const existing = await readSellerNotificationConfig(db);
  const nextRevision = (existing?.revision ?? 1) + 1;

  try {
    const [updated] = await db
      .insert(sellerNotificationSetting)
      .values({
        id: 1,
        enabled: false, // Remains disabled until seller explicitly enables
        destinationChatId: input.destinationChatId,
        language: existing?.language ?? "ar",
        verifiedAt: new Date(),
        verifiedBotId: input.botId,
        verifiedBotUsername: input.botUsername ?? null,
        verifiedChatId: input.destinationChatId,
        revision: nextRevision,
        lastTestAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sellerNotificationSetting.id,
        set: {
          destinationChatId: input.destinationChatId,
          verifiedAt: new Date(),
          verifiedBotId: input.botId,
          verifiedBotUsername: input.botUsername ?? null,
          verifiedChatId: input.destinationChatId,
          revision: nextRevision,
          lastTestAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    return updated;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Toggles the enabled state of seller notifications.
 * Refuses enabling unless the current bot identity matches the verified bot,
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

  const existing = await readSellerNotificationConfig(db);
  if (!existing) {
    throw new RabetDataError("NOT_FOUND", "Notification settings not found. Please configure settings first.");
  }

  if (enabled) {
    if (!existing.destinationChatId) {
      throw new RabetDataError("INVALID_INPUT", "Cannot enable notifications: destination chat ID is not configured.");
    }
    if (!existing.verifiedAt || !existing.verifiedBotId || existing.verifiedChatId !== existing.destinationChatId) {
      throw new RabetDataError(
        "INVALID_INPUT",
        "Cannot enable notifications: destination has not been verified. Send a successful test notification first.",
      );
    }
    if (currentBotId !== undefined && existing.verifiedBotId !== currentBotId) {
      throw new RabetDataError(
        "INVALID_INPUT",
        "Cannot enable notifications: configured bot token belongs to a different bot than was verified. Run a new test notification first.",
      );
    }
  }

  try {
    const [updated] = await db
      .update(sellerNotificationSetting)
      .set({
        enabled,
        updatedAt: new Date(),
      })
      .where(eq(sellerNotificationSetting.id, 1))
      .returning();

    return updated;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

/**
 * Server-side rate limiter / cooldown for test operations.
 * Returns true if test is allowed; returns false if still within cooldown period.
 */
export async function checkAndRecordTestCooldown(
  db: Database,
  cooldownSeconds = 5,
): Promise<{ allowed: boolean; remainingSeconds?: number }> {
  const setting = await readSellerNotificationConfig(db);
  if (!setting) return { allowed: true };

  if (setting.lastTestAt) {
    const elapsedMs = Date.now() - setting.lastTestAt.getTime();
    const cooldownMs = cooldownSeconds * 1000;
    if (elapsedMs < cooldownMs) {
      const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return { allowed: false, remainingSeconds };
    }
  }

  try {
    await db
      .update(sellerNotificationSetting)
      .set({ lastTestAt: new Date(), updatedAt: new Date() })
      .where(eq(sellerNotificationSetting.id, 1));
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

/**
 * Lists recent seller notification deliveries for the dashboard.
 */
export async function listSellerNotificationDeliveries(
  db: Database,
  limit = 20,
): Promise<SellerNotificationDeliveryRecord[]> {
  const cap = await checkSellerNotificationCapability(db);
  if (!cap.supported) return [];

  try {
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

/**
 * Atomically claims a delivery record for sending.
 * Only pending, failed, unknown (with ack), or stale sending records (lease expired) can be claimed.
 */
export async function claimDeliveryAttempt(
  db: Database,
  deliveryId: string,
  attemptIdOrOptions?:
    | string
    | {
        attemptId?: string;
        leaseMs?: number;
        acknowledgeUnknownRisk?: boolean;
      },
  leaseMsArg = 60_000,
  optionsArg?: {
    acknowledgeUnknownRisk?: boolean;
  },
): Promise<SellerNotificationDeliveryRecord | null> {
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
    const existing = await getSellerNotificationDelivery(db, deliveryId);
    if (!existing) return null;
    if (existing.status === "sent" || existing.status === "cancelled") return null;
    if (existing.status === "unknown" && !acknowledgeUnknownRisk) return null;
    if (existing.retryAfterUntil && existing.retryAfterUntil.getTime() > Date.now()) return null;

    const result = await db.execute<SellerNotificationDeliveryRecord>(sql`
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
          OR (status = 'sending' AND (claim_expires_at IS NULL OR claim_expires_at < now()))
        )
      RETURNING *
    `);

    const rawRows: unknown = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] })?.rows;
    const rows = (Array.isArray(rawRows) ? rawRows : []) as Record<string, unknown>[];
    return rows.length > 0 ? mapDeliveryRow(rows[0]) : null;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}

export async function markDeliverySent(
  db: Database,
  deliveryIdOrInput:
    | string
    | {
        deliveryId: string;
        claimAttemptId?: string;
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

  try {
    const attemptFilter = attemptId ? sql`AND claim_attempt_id = ${attemptId}::text` : sql``;
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
        ${attemptFilter}
    `);

    const count = (result as { rowCount?: number })?.rowCount ?? (Array.isArray(result) ? result.length : 0);
    return count > 0;
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
        claimAttemptId?: string;
        errorCategory: string;
        errorSummary?: string;
        retryAfterSeconds?: number;
        retryAfter?: Date;
      },
  attemptIdArg?: string,
  errorCategoryArg?: string,
  retryAfterSecondsArg?: number,
): Promise<{ status: "failed"; errorCategory: string }> {
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

  try {
    const retryAfterSql = retryAfterDate
      ? sql`${retryAfterDate.toISOString()}::timestamptz`
      : typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? sql`now() + (${retryAfterSeconds} || ' seconds')::interval`
      : sql`NULL`;

    const attemptFilter = attemptId ? sql`AND claim_attempt_id = ${attemptId}::text` : sql``;

    await db.execute(sql`
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
        ${attemptFilter}
    `);

    return { status: "failed", errorCategory };
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
        claimAttemptId?: string;
        errorCategory?: string;
        errorSummary?: string;
      },
  attemptIdArg?: string,
  errorCategoryArg = "timeout",
): Promise<{ status: "unknown"; errorCategory: string }> {
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

  try {
    const attemptFilter = attemptId ? sql`AND claim_attempt_id = ${attemptId}::text` : sql``;

    await db.execute(sql`
      UPDATE ${sellerNotificationDelivery}
      SET
        status = 'unknown',
        error_category = ${errorCategory}::text,
        failed_at = now(),
        claim_attempt_id = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = ${deliveryId}::uuid
        ${attemptFilter}
    `);

    return { status: "unknown", errorCategory };
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
    `);

    const count = (result as { rowCount?: number })?.rowCount ?? (Array.isArray(result) ? result.length : 0);
    return count > 0;
  } catch (err) {
    throw mapDatabaseError(err);
  }
}
