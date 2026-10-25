import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  customer,
  inquiry,
  inquiryMessage,
  telegramUpdate,
} from "@/db/schema";
import { mapDatabaseError } from "./errors";

export type InquiryRecord = typeof inquiry.$inferSelect;
export type InquiryMessageRecord = typeof inquiryMessage.$inferSelect;

/** Active inquiry statuses participating in customer routing. */
export const ACTIVE_INQUIRY_STATUSES = ["open", "waiting_on_customer"] as const;

/**
 * Generates a short, unambiguous, server-generated reference for inquiries.
 * Format: INQ- followed by 6 uppercase alphanumeric characters.
 */
export function generateInquiryReference(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // Base32 avoiding ambiguous 0/O, 1/I
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `INQ-${code}`;
}

export interface CreateOrResumeProductInquiryInput {
  customerId: string;
  productId: string;
  productSnapshot: Record<string, unknown>;
  selectedOptions?: string[] | null;
  updateId: number;
  attemptId: string;
}

export interface CreateOrResumeProductInquiryResult {
  inquiry: InquiryRecord;
  isResume: boolean;
}

/**
 * Atomically creates or resumes an active product inquiry for the given customer and product.
 *
 * Guarantees:
 * 1. Customer row is locked via `FOR UPDATE` to serialize concurrent taps for the same customer.
 * 2. If an active inquiry exists (`status IN ('open', 'waiting_on_customer')`), it is resumed directly.
 * 3. Otherwise, inserts a new inquiry with frozen snapshot and ordered option path.
 * 4. The partial unique index `inquiry_active_per_customer_product_idx` prevents race conditions.
 * 5. Atomically binds the business receipt to `telegram_update.payload.receipt` under current `attemptId`.
 */
export async function createOrResumeProductInquiry(
  db: Database,
  input: CreateOrResumeProductInquiryInput,
): Promise<CreateOrResumeProductInquiryResult> {
  try {
    const newId = crypto.randomUUID();
    const newRef = generateInquiryReference();

    const result = await db.execute<{
      id: string;
      customer_id: string;
      product_id: string | null;
      reference: string;
      status: "open" | "waiting_on_customer" | "resolved" | "closed";
      category: string | null;
      product_snapshot: unknown;
      selected_options: unknown;
      opened_at: string | Date;
      last_reply_at: string | Date | null;
      closed_at: string | Date | null;
      created_at: string | Date;
      updated_at: string | Date;
      is_resumed: boolean;
    }>(sql`
      WITH locked_customer AS (
        SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE
      ),
      existing_inquiry AS (
        SELECT
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
        FROM ${inquiry}
        WHERE customer_id = ${input.customerId}::uuid
          AND product_id = ${input.productId}::uuid
          AND status IN ('open', 'waiting_on_customer')
        LIMIT 1
      ),
      inserted_inquiry AS (
        INSERT INTO ${inquiry} (
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, created_at, updated_at
        )
        SELECT
          ${newId}::uuid,
          ${input.customerId}::uuid,
          ${input.productId}::uuid,
          ${newRef}::text,
          'open',
          NULL,
          ${JSON.stringify(input.productSnapshot)}::jsonb,
          ${input.selectedOptions ? JSON.stringify(input.selectedOptions) : null}::jsonb,
          now(),
          now(),
          now()
        WHERE NOT EXISTS (SELECT 1 FROM existing_inquiry)
        ON CONFLICT (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')
        DO NOTHING
        RETURNING
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
      ),
      final_inquiry AS (
        SELECT *, false AS is_resumed FROM inserted_inquiry
        UNION ALL
        SELECT *, true AS is_resumed FROM existing_inquiry
      ),
      receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'inquiry',
            'inquiryId', (SELECT id FROM final_inquiry LIMIT 1)::text,
            'reference', (SELECT reference FROM final_inquiry LIMIT 1)::text,
            'isResume', (SELECT is_resumed FROM final_inquiry LIMIT 1),
            'status', (SELECT status FROM final_inquiry LIMIT 1)::text,
            'productId', (SELECT product_id FROM final_inquiry LIMIT 1)::text
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        RETURNING 1
      )
      SELECT * FROM final_inquiry LIMIT 1;
    `);

    // In pg/postgres-js, result can be an array of rows or { rows: [...] }
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    const row = rows[0] as {
      id: string;
      customer_id: string;
      product_id: string | null;
      reference: string;
      status: "open" | "waiting_on_customer" | "resolved" | "closed";
      category: string | null;
      product_snapshot: unknown;
      selected_options: unknown;
      opened_at: string | Date;
      last_reply_at: string | Date | null;
      closed_at: string | Date | null;
      created_at: string | Date;
      updated_at: string | Date;
      is_resumed: boolean;
    };

    if (!row) {
      throw new Error("Failed to create or resume product inquiry.");
    }

    return {
      inquiry: {
        id: row.id,
        customerId: row.customer_id,
        productId: row.product_id,
        reference: row.reference,
        status: row.status,
        category: row.category,
        productSnapshot: row.product_snapshot as Record<string, unknown>,
        selectedOptions: (row.selected_options as string[] | null) ?? null,
        openedAt: new Date(row.opened_at),
        lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at) : null,
        closedAt: row.closed_at ? new Date(row.closed_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      isResume: Boolean(row.is_resumed),
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface CreateOrResumeSupportInquiryInput {
  customerId: string;
  category?: string | null;
  updateId: number;
  attemptId: string;
}

export interface CreateOrResumeSupportInquiryResult {
  inquiry: InquiryRecord;
  isResume: boolean;
}

/**
 * Atomically creates or resumes an active general support inquiry for the given customer and category.
 *
 * Guarantees:
 * 1. Customer row is locked via `FOR UPDATE` to serialize concurrent support taps.
 * 2. Active support inquiry with matching category (`category IS NOT DISTINCT FROM $category`) is resumed.
 * 3. If none exists, creates an open support inquiry with minimal support snapshot.
 * 4. Atomically records receipt in `telegram_update.payload.receipt` under current `attemptId`.
 */
export async function createOrResumeSupportInquiry(
  db: Database,
  input: CreateOrResumeSupportInquiryInput,
): Promise<CreateOrResumeSupportInquiryResult> {
  try {
    const newId = crypto.randomUUID();
    const newRef = generateInquiryReference();
    const targetCategory = input.category ?? null;
    const supportSnapshot = { type: "support" };

    const result = await db.execute<{
      id: string;
      customer_id: string;
      product_id: string | null;
      reference: string;
      status: "open" | "waiting_on_customer" | "resolved" | "closed";
      category: string | null;
      product_snapshot: unknown;
      selected_options: unknown;
      opened_at: string | Date;
      last_reply_at: string | Date | null;
      closed_at: string | Date | null;
      created_at: string | Date;
      updated_at: string | Date;
      is_resumed: boolean;
    }>(sql`
      WITH locked_customer AS (
        SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE
      ),
      existing_inquiry AS (
        SELECT
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
        FROM ${inquiry}
        WHERE customer_id = ${input.customerId}::uuid
          AND product_id IS NULL
          AND (
            (${targetCategory}::text IS NULL AND category IS NULL)
            OR category = ${targetCategory}::text
          )
          AND status IN ('open', 'waiting_on_customer')
        LIMIT 1
      ),
      inserted_inquiry AS (
        INSERT INTO ${inquiry} (
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, created_at, updated_at
        )
        SELECT
          ${newId}::uuid,
          ${input.customerId}::uuid,
          NULL,
          ${newRef},
          'open',
          ${targetCategory}::text,
          ${JSON.stringify(supportSnapshot)}::jsonb,
          NULL,
          now(),
          now(),
          now()
        WHERE NOT EXISTS (SELECT 1 FROM existing_inquiry)
        RETURNING
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
      ),
      final_inquiry AS (
        SELECT *, false AS is_resumed FROM inserted_inquiry
        UNION ALL
        SELECT *, true AS is_resumed FROM existing_inquiry
      ),
      receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'inquiry',
            'inquiryId', (SELECT id FROM final_inquiry LIMIT 1)::text,
            'reference', (SELECT reference FROM final_inquiry LIMIT 1)::text,
            'isResume', (SELECT is_resumed FROM final_inquiry LIMIT 1),
            'status', (SELECT status FROM final_inquiry LIMIT 1)::text,
            'productId', NULL
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        RETURNING 1
      )
      SELECT * FROM final_inquiry LIMIT 1;
    `);

    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    const row = rows[0] as {
      id: string;
      customer_id: string;
      product_id: string | null;
      reference: string;
      status: "open" | "waiting_on_customer" | "resolved" | "closed";
      category: string | null;
      product_snapshot: unknown;
      selected_options: unknown;
      opened_at: string | Date;
      last_reply_at: string | Date | null;
      closed_at: string | Date | null;
      created_at: string | Date;
      updated_at: string | Date;
      is_resumed: boolean;
    };

    if (!row) {
      throw new Error("Failed to create or resume support inquiry.");
    }

    return {
      inquiry: {
        id: row.id,
        customerId: row.customer_id,
        productId: row.product_id,
        reference: row.reference,
        status: row.status,
        category: row.category,
        productSnapshot: row.product_snapshot as Record<string, unknown>,
        selectedOptions: (row.selected_options as string[] | null) ?? null,
        openedAt: new Date(row.opened_at),
        lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at) : null,
        closedAt: row.closed_at ? new Date(row.closed_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      },
      isResume: Boolean(row.is_resumed),
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Lists all currently active inquiries for a customer, bounded by limit.
 */
export async function listActiveCustomerInquiries(
  db: Database,
  customerId: string,
  limit = 10,
): Promise<InquiryRecord[]> {
  try {
    return await db
      .select()
      .from(inquiry)
      .where(
        and(
          eq(inquiry.customerId, customerId),
          inArray(inquiry.status, [...ACTIVE_INQUIRY_STATUSES]),
        ),
      )
      .orderBy(desc(inquiry.updatedAt))
      .limit(limit);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Finds an inquiry by reference strictly scoped to the authenticated customer.
 * Only returns active inquiries (`status IN ('open', 'waiting_on_customer')`).
 */
export async function getActiveCustomerInquiryByReference(
  db: Database,
  params: {
    customerId: string;
    reference: string;
  },
): Promise<InquiryRecord | null> {
  try {
    const normalizedRef = params.reference.trim().toUpperCase();

    const [row] = await db
      .select()
      .from(inquiry)
      .where(
        and(
          eq(inquiry.customerId, params.customerId),
          eq(inquiry.reference, normalizedRef),
          inArray(inquiry.status, [...ACTIVE_INQUIRY_STATUSES]),
        ),
      )
      .limit(1);

    return row ?? null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface AppendInboundCustomerMessageInput {
  inquiryId: string;
  reference: string;
  body: string;
  telegramMessageId: number;
  updateId: number;
  attemptId: string;
}

export interface AppendInboundCustomerMessageResult {
  message: InquiryMessageRecord;
  inquiry: InquiryRecord;
  isDuplicate: boolean;
}

/**
 * Durably saves an inbound customer text message to the specified active inquiry.
 *
 * Guarantees:
 * 1. `inquiry_message` is inserted with `author = 'customer'`, `delivery_status = 'sent'`, `delivered_at = now()`.
 * 2. `UNIQUE (inquiry_id, telegram_message_id)` prevents duplicate message rows on redelivery.
 * 3. Advances inquiry `last_reply_at`, `updated_at`, and flips `waiting_on_customer` to `open` ONLY if message was newly inserted.
 * 4. Atomically binds message receipt in `telegram_update.payload.receipt` under current `attemptId`.
 * 5. Rejects writes if the inquiry is closed or resolved (does NOT reopen closed threads).
 */
export async function appendInboundCustomerMessage(
  db: Database,
  input: AppendInboundCustomerMessageInput,
): Promise<AppendInboundCustomerMessageResult> {
  try {
    const newMessageId = crypto.randomUUID();

    const result = await db.execute<{
      msg_id: string;
      msg_inquiry_id: string;
      msg_author: "customer" | "admin";
      msg_body: string;
      msg_telegram_message_id: number | null;
      msg_delivery_status: "pending" | "sent" | "failed";
      msg_delivery_error: string | null;
      msg_delivered_at: string | Date | null;
      msg_created_at: string | Date;
      inq_id: string;
      inq_customer_id: string;
      inq_product_id: string | null;
      inq_reference: string;
      inq_status: "open" | "waiting_on_customer" | "resolved" | "closed";
      inq_category: string | null;
      inq_product_snapshot: unknown;
      inq_selected_options: unknown;
      inq_opened_at: string | Date;
      inq_last_reply_at: string | Date | null;
      inq_closed_at: string | Date | null;
      inq_created_at: string | Date;
      inq_updated_at: string | Date;
      is_duplicate: boolean;
    }>(sql`
      WITH inserted_message AS (
        INSERT INTO ${inquiryMessage} (
          id, inquiry_id, author, body, telegram_message_id,
          delivery_status, delivery_error, delivered_at, created_at
        )
        VALUES (
          ${newMessageId}::uuid,
          ${input.inquiryId}::uuid,
          'customer',
          ${input.body}::text,
          ${input.telegramMessageId}::bigint,
          'sent',
          NULL,
          now(),
          now()
        )
        ON CONFLICT (inquiry_id, telegram_message_id) DO NOTHING
        RETURNING *
      ),
      existing_message AS (
        SELECT * FROM ${inquiryMessage}
        WHERE inquiry_id = ${input.inquiryId}::uuid
          AND telegram_message_id = ${input.telegramMessageId}::bigint
        LIMIT 1
      ),
      final_message AS (
        SELECT *, false AS is_dup FROM inserted_message
        UNION ALL
        SELECT *, true AS is_dup FROM existing_message
        WHERE NOT EXISTS (SELECT 1 FROM inserted_message)
      ),
      updated_inquiry AS (
        UPDATE ${inquiry}
        SET
          last_reply_at = CASE WHEN EXISTS (SELECT 1 FROM inserted_message) THEN now() ELSE last_reply_at END,
          updated_at = CASE WHEN EXISTS (SELECT 1 FROM inserted_message) THEN now() ELSE updated_at END,
          status = CASE
            WHEN status = 'waiting_on_customer' AND EXISTS (SELECT 1 FROM inserted_message) THEN 'open'
            ELSE status
          END
        WHERE id = ${input.inquiryId}::uuid
          AND status IN ('open', 'waiting_on_customer')
        RETURNING *
      ),
      receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'message',
            'inquiryId', ${input.inquiryId}::text,
            'messageId', (SELECT id FROM final_message LIMIT 1)::text,
            'reference', ${input.reference}::text,
            'body', ${input.body}::text,
            'telegramMessageId', ${input.telegramMessageId}::bigint
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        RETURNING 1
      )
      SELECT
        m.id AS msg_id,
        m.inquiry_id AS msg_inquiry_id,
        m.author AS msg_author,
        m.body AS msg_body,
        m.telegram_message_id AS msg_telegram_message_id,
        m.delivery_status AS msg_delivery_status,
        m.delivery_error AS msg_delivery_error,
        m.delivered_at AS msg_delivered_at,
        m.created_at AS msg_created_at,
        i.id AS inq_id,
        i.customer_id AS inq_customer_id,
        i.product_id AS inq_product_id,
        i.reference AS inq_reference,
        i.status AS inq_status,
        i.category AS inq_category,
        i.product_snapshot AS inq_product_snapshot,
        i.selected_options AS inq_selected_options,
        i.opened_at AS inq_opened_at,
        i.last_reply_at AS inq_last_reply_at,
        i.closed_at AS inq_closed_at,
        i.created_at AS inq_created_at,
        i.updated_at AS inq_updated_at,
        m.is_dup AS is_duplicate
      FROM final_message m
      JOIN ${inquiry} i ON i.id = m.inquiry_id
      LIMIT 1;
    `);

    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    const row = rows[0] as {
      msg_id: string;
      msg_inquiry_id: string;
      msg_author: "customer" | "admin";
      msg_body: string;
      msg_telegram_message_id: number | null;
      msg_delivery_status: "pending" | "sent" | "failed";
      msg_delivery_error: string | null;
      msg_delivered_at: string | Date | null;
      msg_created_at: string | Date;
      inq_id: string;
      inq_customer_id: string;
      inq_product_id: string | null;
      inq_reference: string;
      inq_status: "open" | "waiting_on_customer" | "resolved" | "closed";
      inq_category: string | null;
      inq_product_snapshot: unknown;
      inq_selected_options: unknown;
      inq_opened_at: string | Date;
      inq_last_reply_at: string | Date | null;
      inq_closed_at: string | Date | null;
      inq_created_at: string | Date;
      inq_updated_at: string | Date;
      is_duplicate: boolean;
    };

    if (!row) {
      throw new Error("Target inquiry is closed, resolved, or message save failed.");
    }

    return {
      message: {
        id: row.msg_id,
        inquiryId: row.msg_inquiry_id,
        author: row.msg_author,
        body: row.msg_body,
        telegramMessageId: row.msg_telegram_message_id,
        deliveryStatus: row.msg_delivery_status,
        deliveryError: row.msg_delivery_error,
        deliveredAt: row.msg_delivered_at ? new Date(row.msg_delivered_at) : null,
        createdAt: new Date(row.msg_created_at),
      },
      inquiry: {
        id: row.inq_id,
        customerId: row.inq_customer_id,
        productId: row.inq_product_id,
        reference: row.inq_reference,
        status: row.inq_status,
        category: row.inq_category,
        productSnapshot: row.inq_product_snapshot as Record<string, unknown>,
        selectedOptions: (row.inq_selected_options as string[] | null) ?? null,
        openedAt: new Date(row.inq_opened_at),
        lastReplyAt: row.inq_last_reply_at ? new Date(row.inq_last_reply_at) : null,
        closedAt: row.inq_closed_at ? new Date(row.inq_closed_at) : null,
        createdAt: new Date(row.inq_created_at),
        updatedAt: new Date(row.inq_updated_at),
      },
      isDuplicate: Boolean(row.is_duplicate),
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Re-exports in index.
 */
