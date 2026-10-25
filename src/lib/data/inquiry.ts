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
import { executeAtomicBatch, toBatchable } from "./catalog";
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
 * 1. Customer row is locked via executed `FOR UPDATE` statement in an atomic batch.
 * 2. Update attempt is locked and guarded in an executed statement under current attemptId.
 * 3. Inquiry creation/resumption runs in a fresh snapshot following customer lock acquisition.
 * 4. The partial unique index prevents duplicate active inquiries under concurrent taps.
 * 5. Atomically binds business receipt in `telegram_update.payload.receipt`.
 * 6. Fencing guard enforces that a stale attempt updates 0 rows and aborts the batch.
 */
export async function createOrResumeProductInquiry(
  db: Database,
  input: CreateOrResumeProductInquiryInput,
): Promise<CreateOrResumeProductInquiryResult> {
  try {
    const newId = crypto.randomUUID();
    const newRef = generateInquiryReference();

    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE`,
    );

    const lockAttemptQuery = toBatchable(
      db,
      sql`SELECT update_id FROM ${telegramUpdate}
          WHERE update_id = ${input.updateId}::bigint
            AND processed_at IS NULL
            AND payload->>'attemptId' = ${input.attemptId}::text
          FOR UPDATE`,
    );

    const resolveQuery = toBatchable(
      db,
      sql`
      WITH locked_attempt AS (
        SELECT update_id FROM ${telegramUpdate}
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        FOR UPDATE
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
        ORDER BY created_at ASC
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
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
          AND NOT EXISTS (SELECT 1 FROM existing_inquiry)
        ON CONFLICT (customer_id, product_id) WHERE status IN ('open', 'waiting_on_customer')
        DO NOTHING
        RETURNING
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
      ),
      resolved_inquiry AS (
        SELECT *, false AS is_resumed FROM inserted_inquiry
        UNION ALL
        SELECT *, true AS is_resumed FROM existing_inquiry
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
        UNION ALL
        SELECT
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at,
          true AS is_resumed
        FROM ${inquiry}
        WHERE customer_id = ${input.customerId}::uuid
          AND product_id = ${input.productId}::uuid
          AND status IN ('open', 'waiting_on_customer')
          AND EXISTS (SELECT 1 FROM locked_attempt)
        LIMIT 1
      ),
      receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'inquiry',
            'inquiryId', (SELECT id FROM resolved_inquiry LIMIT 1)::text,
            'reference', (SELECT reference FROM resolved_inquiry LIMIT 1)::text,
            'isResume', (SELECT is_resumed FROM resolved_inquiry LIMIT 1),
            'status', (SELECT status FROM resolved_inquiry LIMIT 1)::text,
            'productId', (SELECT product_id FROM resolved_inquiry LIMIT 1)::text,
            'category', NULL
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
          AND EXISTS (SELECT 1 FROM resolved_inquiry)
        RETURNING update_id
      ),
      fencing_guard AS (
        SELECT CASE
          WHEN (SELECT count(*) FROM receipt_update) != 1
          THEN (1 / 0)::text
          ELSE 'ok'
        END AS fence_status
      )
      SELECT
        r.*
      FROM resolved_inquiry r
      CROSS JOIN fencing_guard fg;
    `,
    );

    const batchResults = await executeAtomicBatch(db, [
      lockCustomerQuery,
      lockAttemptQuery,
      resolveQuery,
    ]);

    const resRaw = batchResults[2];
    const rows = Array.isArray(resRaw) ? resRaw : (resRaw as { rows: unknown[] })?.rows ?? [];
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
      throw new Error("Failed to create or resume product inquiry: attempt fencing or resolution failed.");
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
 * 1. Customer row is locked via executed `FOR UPDATE` statement in an atomic batch.
 * 2. Update attempt is locked and guarded in an executed statement under current attemptId.
 * 3. Inquiry create/resume runs in a fresh snapshot following customer lock acquisition.
 * 4. Concurrent taps for customer + category return the exact same active support thread.
 * 5. Atomically binds business receipt in `telegram_update.payload.receipt`.
 * 6. Fencing guard enforces that a stale attempt updates 0 rows and aborts the batch.
 */
export async function createOrResumeSupportInquiry(
  db: Database,
  input: CreateOrResumeSupportInquiryInput,
): Promise<CreateOrResumeSupportInquiryResult> {
  try {
    const newId = crypto.randomUUID();
    const newRef = generateInquiryReference();
    const targetCategory = input.category ?? null;

    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE`,
    );

    const lockAttemptQuery = toBatchable(
      db,
      sql`SELECT update_id FROM ${telegramUpdate}
          WHERE update_id = ${input.updateId}::bigint
            AND processed_at IS NULL
            AND payload->>'attemptId' = ${input.attemptId}::text
          FOR UPDATE`,
    );

    const resolveQuery = toBatchable(
      db,
      sql`
      WITH locked_attempt AS (
        SELECT update_id FROM ${telegramUpdate}
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        FOR UPDATE
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
        ORDER BY created_at ASC
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
          ${newRef}::text,
          'open',
          ${targetCategory}::text,
          ${JSON.stringify({ type: "support" })}::jsonb,
          NULL,
          now(),
          now(),
          now()
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
          AND NOT EXISTS (SELECT 1 FROM existing_inquiry)
        RETURNING
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
      ),
      resolved_inquiry AS (
        SELECT *, false AS is_resumed FROM inserted_inquiry
        UNION ALL
        SELECT *, true AS is_resumed FROM existing_inquiry
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
        LIMIT 1
      ),
      receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'inquiry',
            'inquiryId', (SELECT id FROM resolved_inquiry LIMIT 1)::text,
            'reference', (SELECT reference FROM resolved_inquiry LIMIT 1)::text,
            'isResume', (SELECT is_resumed FROM resolved_inquiry LIMIT 1),
            'status', (SELECT status FROM resolved_inquiry LIMIT 1)::text,
            'productId', NULL,
            'category', ${targetCategory}::text
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
          AND EXISTS (SELECT 1 FROM resolved_inquiry)
        RETURNING update_id
      ),
      fencing_guard AS (
        SELECT CASE
          WHEN (SELECT count(*) FROM receipt_update) != 1
          THEN (1 / 0)::text
          ELSE 'ok'
        END AS fence_status
      )
      SELECT
        r.*
      FROM resolved_inquiry r
      CROSS JOIN fencing_guard fg;
    `,
    );

    const batchResults = await executeAtomicBatch(db, [
      lockCustomerQuery,
      lockAttemptQuery,
      resolveQuery,
    ]);

    const resRaw = batchResults[2];
    const rows = Array.isArray(resRaw) ? resRaw : (resRaw as { rows: unknown[] })?.rows ?? [];
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
      throw new Error("Failed to create or resume support inquiry: attempt fencing or resolution failed.");
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

export interface AppendInboundCustomerMessageInput {
  customerId: string;
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
 * 1. Customer row is locked via executed `FOR UPDATE` statement.
 * 2. Destination inquiry MUST be active and MUST belong to the authenticated customer.
 * 3. Message insert, inquiry metadata touch, and update receipt commit in one atomic batch.
 * 4. Fencing guard enforces that a stale attempt or closed destination aborts the batch with 0 writes.
 */
export async function appendInboundCustomerMessage(
  db: Database,
  input: AppendInboundCustomerMessageInput,
): Promise<AppendInboundCustomerMessageResult> {
  try {
    const newMessageId = crypto.randomUUID();

    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE`,
    );

    const lockAttemptQuery = toBatchable(
      db,
      sql`SELECT update_id FROM ${telegramUpdate}
          WHERE update_id = ${input.updateId}::bigint
            AND processed_at IS NULL
            AND payload->>'attemptId' = ${input.attemptId}::text
          FOR UPDATE`,
    );

    const appendQuery = toBatchable(
      db,
      sql`
      WITH locked_attempt AS (
        SELECT update_id FROM ${telegramUpdate}
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        FOR UPDATE
      ),
      locked_inquiry AS (
        SELECT * FROM ${inquiry}
        WHERE id = ${input.inquiryId}::uuid
          AND customer_id = ${input.customerId}::uuid
          AND status IN ('open', 'waiting_on_customer')
        FOR UPDATE
      ),
      inserted_message AS (
        INSERT INTO ${inquiryMessage} (
          id, inquiry_id, author, body, telegram_message_id,
          delivery_status, delivery_error, delivered_at, created_at
        )
        SELECT
          ${newMessageId}::uuid,
          id,
          'customer',
          ${input.body}::text,
          ${input.telegramMessageId}::bigint,
          'sent',
          NULL,
          now(),
          now()
        FROM locked_inquiry
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
        ON CONFLICT (inquiry_id, telegram_message_id) DO NOTHING
        RETURNING *
      ),
      existing_message AS (
        SELECT * FROM ${inquiryMessage}
        WHERE inquiry_id = ${input.inquiryId}::uuid
          AND telegram_message_id = ${input.telegramMessageId}::bigint
          AND EXISTS (SELECT 1 FROM locked_inquiry)
          AND EXISTS (SELECT 1 FROM locked_attempt)
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
          AND EXISTS (SELECT 1 FROM final_message)
        RETURNING *
      ),
      resolved_inquiry AS (
        SELECT * FROM updated_inquiry
        UNION ALL
        SELECT * FROM locked_inquiry
        WHERE NOT EXISTS (SELECT 1 FROM updated_inquiry)
          AND EXISTS (SELECT 1 FROM final_message)
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
            'telegramMessageId', ${input.telegramMessageId}::bigint,
            'isNewSupport', false
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
          AND EXISTS (SELECT 1 FROM final_message)
        RETURNING update_id
      ),
      fencing_guard AS (
        SELECT CASE
          WHEN (SELECT count(*) FROM receipt_update) != 1
          THEN (1 / 0)::text
          ELSE 'ok'
        END AS fence_status
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
      JOIN resolved_inquiry i ON i.id = m.inquiry_id
      CROSS JOIN fencing_guard fg;
    `,
    );

    const batchResults = await executeAtomicBatch(db, [
      lockCustomerQuery,
      lockAttemptQuery,
      appendQuery,
    ]);

    const resRaw = batchResults[2];
    const rows = Array.isArray(resRaw) ? resRaw : (resRaw as { rows: unknown[] })?.rows ?? [];
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
      throw new Error("Target inquiry is closed, resolved, or attempt lost.");
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

export interface RouteAndAppendCustomerTextInput {
  customerId: string;
  body: string;
  telegramMessageId: number;
  updateId: number;
  attemptId: string;
}

export type RouteAndAppendCustomerTextResult =
  | {
      status: "saved";
      inquiry: InquiryRecord;
      message: InquiryMessageRecord;
      isNewSupport: boolean;
      isDuplicate: boolean;
    }
  | {
      status: "ambiguous";
      activeCount: number;
    };

/**
 * Executes atomic ordinary text routing under the customer row lock.
 *
 * Guarantees:
 * 1. Customer row is locked via executed `FOR UPDATE` statement.
 * 2. Determines destination consistently in a fresh snapshot following lock acquisition.
 * 3. 0 active inquiries: Creates general support inquiry, inserts message, updates inquiry, and writes message receipt atomically.
 * 4. 1 active inquiry: Appends message to that active thread and writes message receipt atomically.
 * 5. >1 active inquiries: Writes ambiguous receipt with active references, leaves 0 messages inserted.
 * 6. Fencing guard aborts batch if attempt is stale.
 */
export async function routeAndAppendCustomerText(
  db: Database,
  input: RouteAndAppendCustomerTextInput,
): Promise<RouteAndAppendCustomerTextResult> {
  try {
    const newInqId = crypto.randomUUID();
    const newRef = generateInquiryReference();
    const newMsgId = crypto.randomUUID();

    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id FROM ${customer} WHERE id = ${input.customerId}::uuid FOR UPDATE`,
    );

    const lockAttemptQuery = toBatchable(
      db,
      sql`SELECT update_id FROM ${telegramUpdate}
          WHERE update_id = ${input.updateId}::bigint
            AND processed_at IS NULL
            AND payload->>'attemptId' = ${input.attemptId}::text
          FOR UPDATE`,
    );

    const routeQuery = toBatchable(
      db,
      sql`
      WITH locked_attempt AS (
        SELECT update_id FROM ${telegramUpdate}
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
        FOR UPDATE
      ),
      active_inquiries AS (
        SELECT * FROM ${inquiry}
        WHERE customer_id = ${input.customerId}::uuid
          AND status IN ('open', 'waiting_on_customer')
        ORDER BY updated_at DESC
      ),
      active_count AS (
        SELECT count(*)::int AS cnt FROM active_inquiries
      ),
      created_support AS (
        INSERT INTO ${inquiry} (
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, created_at, updated_at
        )
        SELECT
          ${newInqId}::uuid,
          ${input.customerId}::uuid,
          NULL,
          ${newRef}::text,
          'open',
          NULL,
          ${JSON.stringify({ type: "support" })}::jsonb,
          NULL,
          now(),
          now(),
          now()
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
          AND (SELECT cnt FROM active_count) = 0
        RETURNING *
      ),
      target_inquiry AS (
        SELECT *, true AS is_new FROM created_support
        UNION ALL
        SELECT *, false AS is_new FROM active_inquiries
        WHERE (SELECT cnt FROM active_count) = 1
      ),
      inserted_message AS (
        INSERT INTO ${inquiryMessage} (
          id, inquiry_id, author, body, telegram_message_id,
          delivery_status, delivery_error, delivered_at, created_at
        )
        SELECT
          ${newMsgId}::uuid,
          t.id,
          'customer',
          ${input.body}::text,
          ${input.telegramMessageId}::bigint,
          'sent',
          NULL,
          now(),
          now()
        FROM target_inquiry t
        WHERE EXISTS (SELECT 1 FROM locked_attempt)
        ON CONFLICT (inquiry_id, telegram_message_id) DO NOTHING
        RETURNING *
      ),
      existing_message AS (
        SELECT m.* FROM ${inquiryMessage} m
        JOIN target_inquiry t ON t.id = m.inquiry_id
        WHERE m.telegram_message_id = ${input.telegramMessageId}::bigint
          AND EXISTS (SELECT 1 FROM locked_attempt)
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
        WHERE id IN (SELECT id FROM target_inquiry)
          AND EXISTS (SELECT 1 FROM final_message)
        RETURNING *
      ),
      resolved_inquiry AS (
        SELECT * FROM updated_inquiry
        UNION ALL
        SELECT
          id, customer_id, product_id, reference, status, category,
          product_snapshot, selected_options, opened_at, last_reply_at,
          closed_at, created_at, updated_at
        FROM target_inquiry
        WHERE NOT EXISTS (SELECT 1 FROM updated_inquiry)
      ),
      msg_receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'message',
            'inquiryId', (SELECT id FROM resolved_inquiry LIMIT 1)::text,
            'messageId', (SELECT id FROM final_message LIMIT 1)::text,
            'reference', (SELECT reference FROM resolved_inquiry LIMIT 1)::text,
            'telegramMessageId', ${input.telegramMessageId}::bigint,
            'isNewSupport', (SELECT is_new FROM target_inquiry LIMIT 1)
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
          AND EXISTS (SELECT 1 FROM final_message)
        RETURNING update_id
      ),
      ambiguous_receipt_update AS (
        UPDATE ${telegramUpdate}
        SET payload = jsonb_set(
          coalesce(payload, '{}'::jsonb),
          '{receipt}',
          jsonb_build_object(
            'kind', 'ambiguous',
            'activeReferences', (SELECT coalesce(jsonb_agg(reference), '[]'::jsonb) FROM active_inquiries)
          )
        )
        WHERE update_id = ${input.updateId}::bigint
          AND processed_at IS NULL
          AND payload->>'attemptId' = ${input.attemptId}::text
          AND (SELECT cnt FROM active_count) > 1
        RETURNING update_id
      ),
      fencing_guard AS (
        SELECT CASE
          WHEN (
            (SELECT count(*) FROM msg_receipt_update) +
            (SELECT count(*) FROM ambiguous_receipt_update)
          ) != 1
          THEN (1 / 0)::text
          ELSE 'ok'
        END AS fence_status
      )
      SELECT
        (SELECT cnt FROM active_count) AS active_count,
        m.id AS msg_id,
        m.inquiry_id AS msg_inquiry_id,
        m.author AS msg_author,
        m.body AS msg_body,
        m.telegram_message_id AS msg_telegram_message_id,
        m.delivery_status AS msg_delivery_status,
        m.delivery_error AS msg_delivery_error,
        m.delivered_at AS msg_delivered_at,
        m.created_at AS msg_created_at,
        m.is_dup AS is_duplicate,
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
        t.is_new AS inq_is_new
      FROM (SELECT 1) AS dummy
      CROSS JOIN fencing_guard fg
      LEFT JOIN final_message m ON true
      LEFT JOIN resolved_inquiry i ON i.id = m.inquiry_id
      LEFT JOIN target_inquiry t ON t.id = i.id;
    `,
    );

    const batchResults = await executeAtomicBatch(db, [
      lockCustomerQuery,
      lockAttemptQuery,
      routeQuery,
    ]);

    const resRaw = batchResults[2];
    const rows = Array.isArray(resRaw) ? resRaw : (resRaw as { rows: unknown[] })?.rows ?? [];
    const row = rows[0] as {
      active_count: number;
      msg_id?: string | null;
      msg_inquiry_id?: string | null;
      msg_author?: "customer" | "admin" | null;
      msg_body?: string | null;
      msg_telegram_message_id?: number | null;
      msg_delivery_status?: "pending" | "sent" | "failed" | null;
      msg_delivery_error?: string | null;
      msg_delivered_at?: string | Date | null;
      msg_created_at?: string | Date | null;
      is_duplicate?: boolean | null;
      inq_id?: string | null;
      inq_customer_id?: string | null;
      inq_product_id?: string | null;
      inq_reference?: string | null;
      inq_status?: "open" | "waiting_on_customer" | "resolved" | "closed" | null;
      inq_category?: string | null;
      inq_product_snapshot?: unknown;
      inq_selected_options?: unknown;
      inq_opened_at?: string | Date | null;
      inq_last_reply_at?: string | Date | null;
      inq_closed_at?: string | Date | null;
      inq_created_at?: string | Date | null;
      inq_updated_at?: string | Date | null;
      inq_is_new?: boolean | null;
    };

    if (!row) {
      throw new Error("Text routing transaction aborted: attempt lost or fencing failed.");
    }

    if (row.active_count > 1) {
      return {
        status: "ambiguous",
        activeCount: row.active_count,
      };
    }

    if (!row.msg_id || !row.inq_id) {
      throw new Error("Expected saved message and inquiry row for active count <= 1.");
    }

    return {
      status: "saved",
      inquiry: {
        id: row.inq_id,
        customerId: row.inq_customer_id!,
        productId: row.inq_product_id ?? null,
        reference: row.inq_reference!,
        status: row.inq_status!,
        category: row.inq_category ?? null,
        productSnapshot: row.inq_product_snapshot as Record<string, unknown>,
        selectedOptions: (row.inq_selected_options as string[] | null) ?? null,
        openedAt: new Date(row.inq_opened_at!),
        lastReplyAt: row.inq_last_reply_at ? new Date(row.inq_last_reply_at) : null,
        closedAt: row.inq_closed_at ? new Date(row.inq_closed_at) : null,
        createdAt: new Date(row.inq_created_at!),
        updatedAt: new Date(row.inq_updated_at!),
      },
      message: {
        id: row.msg_id,
        inquiryId: row.msg_inquiry_id!,
        author: row.msg_author!,
        body: row.msg_body!,
        telegramMessageId: row.msg_telegram_message_id ?? null,
        deliveryStatus: row.msg_delivery_status!,
        deliveryError: row.msg_delivery_error ?? null,
        deliveredAt: row.msg_delivered_at ? new Date(row.msg_delivered_at) : null,
        createdAt: new Date(row.msg_created_at!),
      },
      isNewSupport: Boolean(row.inq_is_new),
      isDuplicate: Boolean(row.is_duplicate),
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

export interface ListActiveCustomerInquiriesPagedResult {
  inquiries: InquiryRecord[];
  totalCount: number;
  page: number;
  totalPages: number;
}

/**
 * Lists active inquiries for a customer with deterministic pagination.
 */
export async function listActiveCustomerInquiriesPaged(
  db: Database,
  customerId: string,
  pagination: { page: number; pageSize: number },
): Promise<ListActiveCustomerInquiriesPagedResult> {
  try {
    const page = Math.max(1, pagination.page);
    const pageSize = Math.max(1, Math.min(50, pagination.pageSize));
    const offset = (page - 1) * pageSize;

    const [countRes] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inquiry)
      .where(
        and(
          eq(inquiry.customerId, customerId),
          inArray(inquiry.status, [...ACTIVE_INQUIRY_STATUSES]),
        ),
      );
    const totalCount = countRes?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    const rows = await db
      .select()
      .from(inquiry)
      .where(
        and(
          eq(inquiry.customerId, customerId),
          inArray(inquiry.status, [...ACTIVE_INQUIRY_STATUSES]),
        ),
      )
      .orderBy(desc(inquiry.updatedAt))
      .limit(pageSize)
      .offset(offset);

    return {
      inquiries: rows,
      totalCount,
      page,
      totalPages,
    };
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
