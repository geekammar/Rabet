import "server-only";

import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  customer,
  inquiry,
  inquiryMessage,
} from "@/db/schema";
import { executeAtomicBatch, toBatchable } from "./catalog";
import { setCustomerBlockedStatus } from "./customer";
import { mapDatabaseError, RabetDataError } from "./errors";
import {
  classifyErrorToSafeDiagnostic,
  formatSafeDiagnostic,
} from "@/lib/telegram/transport";
import type { TelegramTransport } from "@/lib/telegram/types";

export type SellerInquiryFilterStatus =
  | "active"
  | "all"
  | "open"
  | "waiting_on_customer"
  | "resolved"
  | "closed";

export const VALID_SELLER_FILTER_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "all",
  "open",
  "waiting_on_customer",
  "resolved",
  "closed",
]);

export type SellerInquiryFilterType = "all" | "product" | "support";

export const VALID_SELLER_FILTER_TYPES: ReadonlySet<string> = new Set([
  "all",
  "product",
  "support",
]);

export interface ListSellerInquiriesParams {
  status?: SellerInquiryFilterStatus;
  type?: SellerInquiryFilterType;
  reference?: string;
  page?: number;
  pageSize?: number;
}

export interface SellerInquiryItem {
  id: string;
  reference: string;
  status: "open" | "waiting_on_customer" | "resolved" | "closed";
  category: string | null;
  productId: string | null;
  productSnapshot: unknown;
  selectedOptions: unknown;
  openedAt: Date;
  lastReplyAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isSupport: boolean;
  customer: {
    id: string;
    telegramId: number;
    telegramUsername: string | null;
    firstName: string | null;
    lastName: string | null;
    isBlocked: boolean;
  };
  lastMessage: {
    id: string;
    body: string;
    author: "customer" | "admin";
    deliveryStatus: "pending" | "sent" | "failed";
    createdAt: Date;
  } | null;
}

export interface ListSellerInquiriesResult {
  items: SellerInquiryItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Checks whether an inquiry is general support vs product inquiry
 * by inspecting the frozen context (snapshot) rather than solely the nullable productId.
 */
export function isInquirySupport(
  productSnapshot: unknown,
): boolean {
  if (
    productSnapshot &&
    typeof productSnapshot === "object" &&
    "type" in productSnapshot &&
    (productSnapshot as { type: unknown }).type === "support"
  ) {
    return true;
  }
  return false;
}

/**
 * Deterministically derives a stable retry UUID from the source message ID.
 * Follows RFC 4122 v5 formatting using a fixed SHA-256 namespace.
 */
export function deriveRetryOperationId(sourceMessageId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`rabet:seller-reply-retry:${sourceMessageId}`)
    .digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    `5${hash.substring(13, 16)}`,
    `a${hash.substring(17, 20)}`,
    hash.substring(20, 32),
  ].join("-");
}

/**
 * Lists seller inquiries with bounded pagination, filtering, exact reference search,
 * and deterministic ordering. Reading causes zero business writes.
 */
export async function listSellerInquiries(
  db: Database,
  params?: ListSellerInquiriesParams,
): Promise<ListSellerInquiriesResult> {
  try {
    if (params?.status !== undefined) {
      if (
        typeof params.status !== "string" ||
        !VALID_SELLER_FILTER_STATUSES.has(params.status)
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Invalid status filter: "${String(params.status)}".`,
        );
      }
    }

    if (params?.type !== undefined) {
      if (
        typeof params.type !== "string" ||
        !VALID_SELLER_FILTER_TYPES.has(params.type)
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          `Invalid type filter: "${String(params.type)}".`,
        );
      }
    }

    if (params?.page !== undefined) {
      if (
        typeof params.page !== "number" ||
        !Number.isSafeInteger(params.page) ||
        params.page < 1
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "Page must be a positive safe integer.",
        );
      }
    }

    if (params?.pageSize !== undefined) {
      if (
        typeof params.pageSize !== "number" ||
        !Number.isSafeInteger(params.pageSize) ||
        params.pageSize < 1
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "PageSize must be a positive safe integer.",
        );
      }
    }

    const page = Math.min(params?.page ?? 1, 10_000);
    const pageSize = Math.min(100, Math.max(1, params?.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const conditions: import("drizzle-orm").SQL[] = [];

    // Filter by status (default is active: open + waiting_on_customer)
    const filterStatus = params?.status ?? "active";
    if (filterStatus === "active") {
      conditions.push(sql`${inquiry.status} IN ('open', 'waiting_on_customer')`);
    } else if (filterStatus === "open") {
      conditions.push(sql`${inquiry.status} = 'open'`);
    } else if (filterStatus === "waiting_on_customer") {
      conditions.push(sql`${inquiry.status} = 'waiting_on_customer'`);
    } else if (filterStatus === "resolved") {
      conditions.push(sql`${inquiry.status} = 'resolved'`);
    } else if (filterStatus === "closed") {
      conditions.push(sql`${inquiry.status} = 'closed'`);
    }
    // "all" adds no status condition

    // Filter by type (product inquiry vs general support)
    const filterType = params?.type ?? "all";
    if (filterType === "support") {
      conditions.push(sql`${inquiry.productSnapshot}->>'type' = 'support'`);
    } else if (filterType === "product") {
      conditions.push(
        sql`(${inquiry.productSnapshot}->>'type' IS DISTINCT FROM 'support')`,
      );
    }

    // Exact reference search
    if (params?.reference && params.reference.trim().length > 0) {
      const ref = params.reference.trim();
      conditions.push(sql`UPPER(trim(${inquiry.reference})) = UPPER(trim(${ref}))`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 1. Total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inquiry)
      .where(whereClause);

    const totalCount = countResult?.count ?? 0;
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    if (totalCount === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        pageSize,
        totalPages: 1,
      };
    }

    // 2. Inquiries with joined customer
    const rows = await db
      .select({
        inquiry: inquiry,
        customer: customer,
      })
      .from(inquiry)
      .innerJoin(customer, eq(inquiry.customerId, customer.id))
      .where(whereClause)
      .orderBy(desc(inquiry.updatedAt), desc(inquiry.id))
      .limit(pageSize)
      .offset(offset);

    const inquiryIds = rows.map((r) => r.inquiry.id);

    // 3. Latest message previews for the page
    const lastMessageMap = new Map<
      string,
      {
        id: string;
        body: string;
        author: "customer" | "admin";
        deliveryStatus: "pending" | "sent" | "failed";
        createdAt: Date;
      }
    >();

    if (inquiryIds.length > 0) {
      const idListSql = sql.join(
        inquiryIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const latestMessages = await db.execute<{
        id: string;
        inquiry_id: string;
        author: "customer" | "admin";
        body: string;
        delivery_status: "pending" | "sent" | "failed";
        created_at: Date | string;
      }>(
        sql`
          SELECT DISTINCT ON (inquiry_id)
            id, inquiry_id, author, body, delivery_status, created_at
          FROM ${inquiryMessage}
          WHERE inquiry_id IN (${idListSql})
          ORDER BY inquiry_id, created_at DESC, id DESC
        `,
      );

      const msgRows = Array.isArray(latestMessages)
        ? latestMessages
        : (latestMessages as { rows?: unknown[] }).rows ?? [];

      for (const msg of msgRows as Array<{
        id: string;
        inquiry_id: string;
        author: "customer" | "admin";
        body: string;
        delivery_status: "pending" | "sent" | "failed";
        created_at: Date | string;
      }>) {
        lastMessageMap.set(msg.inquiry_id, {
          id: msg.id,
          body: msg.body,
          author: msg.author,
          deliveryStatus: msg.delivery_status,
          createdAt:
            msg.created_at instanceof Date
              ? msg.created_at
              : new Date(msg.created_at),
        });
      }
    }

    const items: SellerInquiryItem[] = rows.map((r) => ({
      id: r.inquiry.id,
      reference: r.inquiry.reference,
      status: r.inquiry.status,
      category: r.inquiry.category,
      productId: r.inquiry.productId,
      productSnapshot: r.inquiry.productSnapshot,
      selectedOptions: r.inquiry.selectedOptions,
      openedAt: r.inquiry.openedAt,
      lastReplyAt: r.inquiry.lastReplyAt,
      closedAt: r.inquiry.closedAt,
      createdAt: r.inquiry.createdAt,
      updatedAt: r.inquiry.updatedAt,
      isSupport: isInquirySupport(
        r.inquiry.productSnapshot,
      ),
      customer: {
        id: r.customer.id,
        telegramId: r.customer.telegramId,
        telegramUsername: r.customer.telegramUsername,
        firstName: r.customer.firstName,
        lastName: r.customer.lastName,
        isBlocked: r.customer.isBlocked,
      },
      lastMessage: lastMessageMap.get(r.inquiry.id) ?? null,
    }));

    return {
      items,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface SellerInquiryThreadDetails {
  inquiry: typeof inquiry.$inferSelect;
  customer: typeof customer.$inferSelect;
  isSupport: boolean;
}

/**
 * Reads an inquiry thread and customer details. Zero business writes.
 */
export async function getSellerInquiryThread(
  db: Database,
  inquiryId: string,
): Promise<SellerInquiryThreadDetails> {
  try {
    const [row] = await db
      .select({
        inquiry: inquiry,
        customer: customer,
      })
      .from(inquiry)
      .innerJoin(customer, eq(inquiry.customerId, customer.id))
      .where(eq(inquiry.id, inquiryId))
      .limit(1);

    if (!row) {
      throw new RabetDataError("NOT_FOUND", `Inquiry not found: ${inquiryId}`);
    }

    return {
      inquiry: row.inquiry,
      customer: row.customer,
      isSupport: isInquirySupport(
        row.inquiry.productSnapshot,
      ),
    };
  } catch (error) {
    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export interface ListInquiryMessagesPagedResult {
  items: Array<typeof inquiryMessage.$inferSelect>;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Lists messages for an inquiry thread with bounded pagination and consistent ordering.
 * Zero business writes.
 */
export async function listInquiryMessagesPaged(
  db: Database,
  inquiryId: string,
  params?: { page?: number; pageSize?: number },
): Promise<ListInquiryMessagesPagedResult> {
  try {
    if (params?.page !== undefined) {
      if (
        typeof params.page !== "number" ||
        !Number.isSafeInteger(params.page) ||
        params.page < 1
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "Page must be a positive safe integer.",
        );
      }
    }

    if (params?.pageSize !== undefined) {
      if (
        typeof params.pageSize !== "number" ||
        !Number.isSafeInteger(params.pageSize) ||
        params.pageSize < 1
      ) {
        throw new RabetDataError(
          "INVALID_INPUT",
          "PageSize must be a positive safe integer.",
        );
      }
    }

    const page = Math.min(params?.page ?? 1, 10_000);
    const pageSize = Math.min(100, Math.max(1, params?.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(inquiryMessage)
      .where(eq(inquiryMessage.inquiryId, inquiryId));

    const totalCount = countResult?.count ?? 0;
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    if (totalCount === 0) {
      return {
        items: [],
        totalCount: 0,
        page,
        pageSize,
        totalPages: 1,
      };
    }

    const items = await db
      .select()
      .from(inquiryMessage)
      .where(eq(inquiryMessage.inquiryId, inquiryId))
      .orderBy(inquiryMessage.createdAt, inquiryMessage.id)
      .limit(pageSize)
      .offset(offset);

    return {
      items,
      totalCount,
      page,
      pageSize,
      totalPages,
    };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export interface ReserveSellerReplyInput {
  inquiryId: string;
  body: string;
  operationId?: string;
}

export type ReserveSellerReplyResult =
  | {
      status: "reserved";
      message: typeof inquiryMessage.$inferSelect;
      inquiry: typeof inquiry.$inferSelect;
      customer: typeof customer.$inferSelect;
      shouldSend: true;
    }
  | {
      status: "already_reserved";
      message: typeof inquiryMessage.$inferSelect;
      inquiry: typeof inquiry.$inferSelect;
      customer: typeof customer.$inferSelect;
      shouldSend: false;
    };

/**
 * Formats the delivered message text with inquiry reference prefix.
 */
export function formatSellerOutgoingText(reference: string, body: string): string {
  return `[${reference}]\n\n${body}`;
}

/**
 * Atomically reserves a seller reply in the database before calling Telegram.
 *
 * Guarantees:
 * 1. Lock customer then inquiry in consistent order compatible with Phase 07.
 * 2. Verify inquiry is active ('open' or 'waiting_on_customer').
 * 3. Idempotent reservation via operation ID: duplicate calls return existing operation outcome.
 * 4. Reusing operation ID with different body/inquiry is rejected.
 * 5. Single atomic batch updates inquiry status to 'waiting_on_customer' and inserts pending message.
 * 6. Rolls back entirely on inactive inquiry or concurrent closure.
 */
export async function reserveSellerReply(
  db: Database,
  input: ReserveSellerReplyInput,
): Promise<ReserveSellerReplyResult> {
  const operationId = input.operationId ?? crypto.randomUUID();

  // Validate body
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "Message body cannot be empty or whitespace-only.",
    );
  }

  // 1. Check if this operationId already exists in inquiry_message
  const [existingMessage] = await db
    .select()
    .from(inquiryMessage)
    .where(eq(inquiryMessage.id, operationId))
    .limit(1);

  if (existingMessage) {
    if (
      existingMessage.inquiryId !== input.inquiryId ||
      existingMessage.body !== input.body
    ) {
      throw new RabetDataError(
        "CONFLICT",
        "Cannot reuse operation ID with different inquiry or body content.",
      );
    }

    const thread = await getSellerInquiryThread(db, input.inquiryId);
    return {
      status: "already_reserved",
      message: existingMessage,
      inquiry: thread.inquiry,
      customer: thread.customer,
      shouldSend: false,
    };
  }

  // 2. Read thread to inspect customer block status and inquiry reference
  const thread = await getSellerInquiryThread(db, input.inquiryId);

  if (thread.customer.isBlocked) {
    throw new RabetDataError(
      "INVALID_INPUT",
      "Customer has blocked the bot. Messages cannot be delivered.",
    );
  }

  if (
    thread.inquiry.status !== "open" &&
    thread.inquiry.status !== "waiting_on_customer"
  ) {
    throw new RabetDataError(
      "INVALID_INPUT",
      `Cannot reply to a ${thread.inquiry.status} inquiry. Thread must be open or waiting_on_customer.`,
    );
  }

  // Check complete outgoing text limit (4096 code units)
  const fullOutgoingText = formatSellerOutgoingText(
    thread.inquiry.reference,
    input.body,
  );
  if (fullOutgoingText.length > 4096) {
    throw new RabetDataError(
      "INVALID_INPUT",
      `Outgoing message text including reference exceeds 4096 characters (received ${fullOutgoingText.length}).`,
    );
  }

  try {
    // 3. Multi-statement atomic batch
    // Statement 1: Lock customer
    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id, is_blocked FROM ${customer} WHERE id = ${thread.customer.id}::uuid FOR UPDATE`,
    );

    // Statement 2: Lock inquiry and verify active status
    const lockInquiryQuery = toBatchable(
      db,
      sql`SELECT id, customer_id, reference, status FROM ${inquiry}
          WHERE id = ${input.inquiryId}::uuid
            AND status IN ('open', 'waiting_on_customer')
          FOR UPDATE`,
    );

    // Statement 3: Insert admin message with pending delivery
    const insertMessageQuery = toBatchable(
      db,
      sql`
        INSERT INTO ${inquiryMessage} (
          id, inquiry_id, author, body, delivery_status, created_at
        )
        SELECT
          ${operationId}::uuid,
          id,
          'admin',
          ${input.body}::text,
          'pending',
          now()
        FROM ${inquiry}
        WHERE id = ${input.inquiryId}::uuid
          AND status IN ('open', 'waiting_on_customer')
        RETURNING id, inquiry_id, author, body, delivery_status, created_at
      `,
    );

    // Statement 4: Update inquiry to waiting_on_customer and update timestamps
    const updateInquiryQuery = toBatchable(
      db,
      sql`
        UPDATE ${inquiry}
        SET status = 'waiting_on_customer',
            last_reply_at = now(),
            updated_at = now()
        WHERE id = ${input.inquiryId}::uuid
          AND status IN ('open', 'waiting_on_customer')
          AND EXISTS (SELECT 1 FROM ${inquiryMessage} WHERE id = ${operationId}::uuid)
        RETURNING id, status, last_reply_at, updated_at
      `,
    );

    // Statement 5: Assertion query to guarantee atomic commit or rollback
    const assertionQuery = toBatchable(
      db,
      sql`
        WITH verified_reservation AS (
          SELECT count(*) AS cnt FROM ${inquiryMessage} WHERE id = ${operationId}::uuid
        ),
        verified_inquiry AS (
          SELECT count(*) AS cnt FROM ${inquiry} WHERE id = ${input.inquiryId}::uuid AND status = 'waiting_on_customer'
        )
        SELECT CASE
          WHEN (SELECT cnt FROM verified_reservation) = 1 AND (SELECT cnt FROM verified_inquiry) = 1 THEN 'ok'
          ELSE CAST('ASSERTION_FAILED_RESERVATION_' || (SELECT cnt FROM verified_reservation) || '_' || (SELECT cnt FROM verified_inquiry) AS date)::text
        END AS reservation_assertion;
      `,
    );

    await executeAtomicBatch(db, [
      lockCustomerQuery,
      lockInquiryQuery,
      insertMessageQuery,
      updateInquiryQuery,
      assertionQuery,
    ]);

    // Read the committed message row
    const [savedMessage] = await db
      .select()
      .from(inquiryMessage)
      .where(eq(inquiryMessage.id, operationId))
      .limit(1);

    if (!savedMessage) {
      throw new RabetDataError(
        "UNCATEGORIZED",
        "Failed to read message after atomic reservation.",
      );
    }

    const updatedThread = await getSellerInquiryThread(db, input.inquiryId);

    return {
      status: "reserved",
      message: savedMessage,
      inquiry: updatedThread.inquiry,
      customer: updatedThread.customer,
      shouldSend: true,
    };
  } catch (error) {
    // If conflict on ID from a concurrent racer:
    const [raceMessage] = await db
      .select()
      .from(inquiryMessage)
      .where(eq(inquiryMessage.id, operationId))
      .limit(1);

    if (raceMessage) {
      if (
        raceMessage.inquiryId !== input.inquiryId ||
        raceMessage.body !== input.body
      ) {
        throw new RabetDataError(
          "CONFLICT",
          "Cannot reuse operation ID with different inquiry or body content.",
        );
      }
      const thread = await getSellerInquiryThread(db, input.inquiryId);
      return {
        status: "already_reserved",
        message: raceMessage,
        inquiry: thread.inquiry,
        customer: thread.customer,
        shouldSend: false,
      };
    }

    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}

export type SellerDeliveryOutcome =
  | "confirmed_sent"
  | "confirmed_failed"
  | "recorded_pending"
  | "unconfirmed_outcome";

export interface CompleteDeliveryParams {
  messageId: string;
  inquiryReference: string;
  body: string;
  customerId: string;
  telegramChatId: number;
}

export type CompleteDeliveryResult =
  | {
      success: true;
      outcome: "confirmed_sent";
      messageId: string;
      telegramMessageId: number;
    }
  | {
      success: false;
      outcome: "confirmed_failed";
      messageId: string;
      error: string;
    }
  | {
      success: false;
      outcome: "unconfirmed_outcome";
      messageId: string;
      error: string;
    };

/**
 * Delivers a reserved seller reply through Telegram and persists honest delivery results.
 *
 * Guarantees:
 * - Obtains transport outcome separately from persistence outcome.
 * - Persistence failure after Telegram acceptance never claims Telegram rejected delivery.
 * - Validates positive integer Telegram message ID before confirming sent.
 * - Checks affected rows / RETURNING on completion update rather than assuming success.
 * - Preserves existing terminal sent state; late/repeated errors cannot downgrade it.
 * - Never changes inquiry lifecycle status during delivery completion.
 */
export async function completeSellerReplyDelivery(
  db: Database,
  transport: TelegramTransport,
  params: CompleteDeliveryParams,
): Promise<CompleteDeliveryResult> {
  const outgoingText = formatSellerOutgoingText(
    params.inquiryReference,
    params.body,
  );

  // 1. Obtain transport outcome separately
  let sendRes: import("@/lib/telegram/types").TelegramSendResult;
  let transportException: unknown = null;

  try {
    sendRes = await transport.sendMessage({
      chatId: params.telegramChatId,
      text: outgoingText,
    });
  } catch (err) {
    transportException = err;
    sendRes = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorKind: "network_error",
    };
  }

  // 2. Separate persistence outcome based on transport result
  if (sendRes.ok) {
    // Validate that a successful send result includes the required valid Telegram message ID
    if (
      typeof sendRes.messageId !== "number" ||
      !Number.isInteger(sendRes.messageId) ||
      sendRes.messageId <= 0
    ) {
      return {
        success: false,
        outcome: "unconfirmed_outcome",
        messageId: params.messageId,
        error:
          "Telegram acknowledged delivery but did not return a valid message ID.",
      };
    }

    const validTelegramMessageId = sendRes.messageId;

    try {
      // 4. Completion checks affected rows/RETURNING rather than assuming an UPDATE succeeded.
      // 6. Only transition pending -> sent, preventing regression of terminal states.
      const [updated] = await db
        .update(inquiryMessage)
        .set({
          deliveryStatus: "sent",
          telegramMessageId: validTelegramMessageId,
          deliveredAt: new Date(),
          deliveryError: null,
        })
        .where(
          and(
            eq(inquiryMessage.id, params.messageId),
            eq(inquiryMessage.deliveryStatus, "pending"),
          ),
        )
        .returning();

      if (!updated) {
        // Zero rows affected: inspect authoritative database state
        const [current] = await db
          .select({
            id: inquiryMessage.id,
            deliveryStatus: inquiryMessage.deliveryStatus,
            telegramMessageId: inquiryMessage.telegramMessageId,
          })
          .from(inquiryMessage)
          .where(eq(inquiryMessage.id, params.messageId))
          .limit(1);

        if (current?.deliveryStatus === "sent") {
          // Terminal sent state already preserved
          return {
            success: true,
            outcome: "confirmed_sent",
            messageId: params.messageId,
            telegramMessageId:
              current.telegramMessageId ?? validTelegramMessageId,
          };
        }

        // Missing or suppressed completion update does not return confirmed sent
        return {
          success: false,
          outcome: "unconfirmed_outcome",
          messageId: params.messageId,
          error:
            "Telegram accepted delivery, but updating delivery status affected 0 rows.",
        };
      }

      return {
        success: true,
        outcome: "confirmed_sent",
        messageId: params.messageId,
        telegramMessageId: validTelegramMessageId,
      };
    } catch {
      // 3. A persistence exception after Telegram acceptance never becomes a claim that Telegram rejected delivery
      // Keep operation unconfirmed
      return {
        success: false,
        outcome: "unconfirmed_outcome",
        messageId: params.messageId,
        error:
          "Message was accepted by Telegram, but delivery confirmation failed to persist.",
      };
    }
  }

  // Handled Telegram failure or transport exception
  const safeDiag = transportException
    ? formatSafeDiagnostic(classifyErrorToSafeDiagnostic(transportException))
    : formatSafeDiagnostic({
        category: sendRes.errorKind ?? "api_error",
        httpStatus: sendRes.httpStatus,
        retryAfterSeconds: sendRes.retryAfterSeconds,
      });

  // Explicit Telegram rejection vs uncertain transport outcome:
  // - Explicit rejection: Telegram responded rejecting delivery (403 blocked, 4xx client errors, 429 rate limit)
  // - Uncertain transport outcome: Timeout, network exception, 5xx server/gateway errors, malformed response
  const isUncertainTransportOutcome =
    transportException !== null ||
    sendRes.errorKind === "timeout" ||
    sendRes.errorKind === "network_error" ||
    (typeof sendRes.httpStatus === "number" && sendRes.httpStatus >= 500);

  if (isUncertainTransportOutcome) {
    try {
      await db
        .update(inquiryMessage)
        .set({
          deliveryError: safeDiag,
        })
        .where(
          and(
            eq(inquiryMessage.id, params.messageId),
            eq(inquiryMessage.deliveryStatus, "pending"),
          ),
        );
    } catch {
      // Non-fatal if diagnostic persistence fails
    }

    return {
      success: false,
      outcome: "unconfirmed_outcome",
      messageId: params.messageId,
      error: safeDiag,
    };
  }

  if (sendRes.isBlocked || sendRes.errorKind === "blocked") {
    try {
      await setCustomerBlockedStatus(db, params.customerId, true);
    } catch {
      // Non-fatal if customer status update fails
    }
  }

  try {
    // Only update pending -> failed so an existing sent record is not downgraded by a later error path
    const [updated] = await db
      .update(inquiryMessage)
      .set({
        deliveryStatus: "failed",
        deliveryError: safeDiag,
      })
      .where(
        and(
          eq(inquiryMessage.id, params.messageId),
          eq(inquiryMessage.deliveryStatus, "pending"),
        ),
      )
      .returning();

    if (!updated) {
      const [current] = await db
        .select({
          id: inquiryMessage.id,
          deliveryStatus: inquiryMessage.deliveryStatus,
          telegramMessageId: inquiryMessage.telegramMessageId,
        })
        .from(inquiryMessage)
        .where(eq(inquiryMessage.id, params.messageId))
        .limit(1);

      if (current?.deliveryStatus === "sent") {
        // Preserved terminal sent state
        return {
          success: true,
          outcome: "confirmed_sent",
          messageId: params.messageId,
          telegramMessageId: current.telegramMessageId ?? 0,
        };
      }

      if (current?.deliveryStatus === "failed") {
        return {
          success: false,
          outcome: "confirmed_failed",
          messageId: params.messageId,
          error: safeDiag,
        };
      }

      return {
        success: false,
        outcome: "unconfirmed_outcome",
        messageId: params.messageId,
        error: safeDiag,
      };
    }

    return {
      success: false,
      outcome: "confirmed_failed",
      messageId: params.messageId,
      error: safeDiag,
    };
  } catch {
    return {
      success: false,
      outcome: "unconfirmed_outcome",
      messageId: params.messageId,
      error: safeDiag,
    };
  }
}

export interface SendSellerReplyInput {
  inquiryId: string;
  body: string;
  operationId?: string;
}

export type SendSellerReplyResult =
  | {
      success: true;
      outcome: "confirmed_sent";
      message: typeof inquiryMessage.$inferSelect;
      alreadyReserved?: boolean;
    }
  | {
      success: false;
      outcome: "confirmed_failed";
      message: typeof inquiryMessage.$inferSelect;
      error: string;
      alreadyReserved?: boolean;
    }
  | {
      success: false;
      outcome: "recorded_pending";
      message: typeof inquiryMessage.$inferSelect;
      alreadyReserved?: boolean;
    }
  | {
      success: false;
      outcome: "unconfirmed_outcome";
      message: typeof inquiryMessage.$inferSelect;
      error: string;
      alreadyReserved?: boolean;
    };

/**
 * End-to-end seller reply flow:
 * 1. Reserves pending message and advances inquiry to 'waiting_on_customer' in atomic batch.
 * 2. If already reserved by a prior attempt, returns without re-sending.
 * 3. Sends via Telegram and updates delivery status honestly.
 */
export async function sendSellerReply(
  db: Database,
  transport: TelegramTransport,
  input: SendSellerReplyInput,
): Promise<SendSellerReplyResult> {
  const reservation = await reserveSellerReply(db, input);

  if (!reservation.shouldSend) {
    if (reservation.message.deliveryStatus === "sent") {
      return {
        success: true,
        outcome: "confirmed_sent",
        message: reservation.message,
        alreadyReserved: true,
      };
    }
    if (reservation.message.deliveryStatus === "failed") {
      return {
        success: false,
        outcome: "confirmed_failed",
        message: reservation.message,
        error:
          reservation.message.deliveryError ?? "Previous delivery attempt failed",
        alreadyReserved: true,
      };
    }
    // deliveryStatus === "pending":
    // Check if deliveryError indicates an unconfirmed outcome from an earlier transport attempt
    if (reservation.message.deliveryError) {
      return {
        success: false,
        outcome: "unconfirmed_outcome",
        message: reservation.message,
        error: reservation.message.deliveryError,
        alreadyReserved: true,
      };
    }
    return {
      success: false,
      outcome: "recorded_pending",
      message: reservation.message,
      alreadyReserved: true,
    };
  }

  const delivery = await completeSellerReplyDelivery(db, transport, {
    messageId: reservation.message.id,
    inquiryReference: reservation.inquiry.reference,
    body: reservation.message.body,
    customerId: reservation.customer.id,
    telegramChatId: reservation.customer.telegramId,
  });

  const [finalMessage] = await db
    .select()
    .from(inquiryMessage)
    .where(eq(inquiryMessage.id, reservation.message.id))
    .limit(1);

  const returnedMsg = finalMessage ?? reservation.message;

  if (delivery.outcome === "confirmed_sent") {
    return {
      success: true,
      outcome: "confirmed_sent",
      message: returnedMsg,
    };
  }

  if (delivery.outcome === "confirmed_failed") {
    return {
      success: false,
      outcome: "confirmed_failed",
      message: returnedMsg,
      error: delivery.error,
    };
  }

  return {
    success: false,
    outcome: "unconfirmed_outcome",
    message: returnedMsg,
    error: delivery.error,
  };
}

export interface RetrySellerReplyInput {
  inquiryId: string;
  sourceMessageId: string;
}

/**
 * Explicit seller retry for a failed or stale-pending reply.
 *
 * Guarantees:
 * 1. Derives stable retry operation UUID server-side from sourceMessageId.
 * 2. Concurrent retries of the same source resolve to one retry row and one transport call.
 * 3. Validates source is an admin message on the inquiry.
 * 4. Stale pending replies (>2 minutes) are eligible with uncertain warning.
 * 5. Requires an active conversation ('open' or 'waiting_on_customer').
 */
export async function retrySellerReply(
  db: Database,
  transport: TelegramTransport,
  input: RetrySellerReplyInput,
): Promise<SendSellerReplyResult> {
  // 1. Fetch source message
  const [sourceMessage] = await db
    .select()
    .from(inquiryMessage)
    .where(eq(inquiryMessage.id, input.sourceMessageId))
    .limit(1);

  if (!sourceMessage || sourceMessage.inquiryId !== input.inquiryId) {
    throw new RabetDataError(
      "NOT_FOUND",
      "Source message for retry was not found on this inquiry.",
    );
  }

  if (sourceMessage.author !== "admin") {
    throw new RabetDataError(
      "INVALID_INPUT",
      "Only seller replies can be retried.",
    );
  }

  if (sourceMessage.deliveryStatus === "sent") {
    throw new RabetDataError(
      "INVALID_INPUT",
      "Cannot retry a reply that was already sent successfully.",
    );
  }

  if (sourceMessage.deliveryStatus === "pending") {
    const elapsedMs = Date.now() - sourceMessage.createdAt.getTime();
    if (elapsedMs < 120_000) {
      throw new RabetDataError(
        "INVALID_INPUT",
        "A pending reply is still in flight. Please wait 2 minutes before retrying.",
      );
    }
  }

  // 2. Derive stable retry ID
  const retryOperationId = deriveRetryOperationId(input.sourceMessageId);

  // 3. Check if retry row already exists
  const [existingRetry] = await db
    .select()
    .from(inquiryMessage)
    .where(eq(inquiryMessage.id, retryOperationId))
    .limit(1);

  if (existingRetry) {
    if (existingRetry.deliveryStatus === "sent") {
      return {
        success: true,
        outcome: "confirmed_sent",
        message: existingRetry,
        alreadyReserved: true,
      };
    }
    if (existingRetry.deliveryStatus === "failed") {
      return {
        success: false,
        outcome: "confirmed_failed",
        message: existingRetry,
        error: existingRetry.deliveryError ?? "Previous retry attempt failed",
        alreadyReserved: true,
      };
    }
    if (existingRetry.deliveryError) {
      return {
        success: false,
        outcome: "unconfirmed_outcome",
        message: existingRetry,
        error: existingRetry.deliveryError,
        alreadyReserved: true,
      };
    }
    return {
      success: false,
      outcome: "recorded_pending",
      message: existingRetry,
      alreadyReserved: true,
    };
  }

  // 4. Reserve and send using the derived retry ID
  return sendSellerReply(db, transport, {
    inquiryId: input.inquiryId,
    body: sourceMessage.body,
    operationId: retryOperationId,
  });
}

export type InquiryLifecycleTargetStatus = "open" | "resolved" | "closed";

export interface TransitionInquiryStatusInput {
  inquiryId: string;
  targetStatus: InquiryLifecycleTargetStatus;
}

export type TransitionInquiryStatusResult = typeof inquiry.$inferSelect & {
  alreadyAtTarget: boolean;
};

function mapInquiryRow(row: Record<string, unknown>): typeof inquiry.$inferSelect {
  return {
    id: row.id as string,
    customerId: ((row.customerId ?? row.customer_id) as string),
    productId: (((row.productId ?? row.product_id) as string | null) ?? null),
    reference: row.reference as string,
    status: row.status as "open" | "waiting_on_customer" | "resolved" | "closed",
    category: (((row.category as string | null) ?? null)),
    productSnapshot: (row.productSnapshot ?? row.product_snapshot) as unknown,
    selectedOptions: (row.selectedOptions ?? row.selected_options) as unknown,
    openedAt: row.openedAt instanceof Date ? row.openedAt : new Date((row.openedAt ?? row.opened_at) as string | number),
    lastReplyAt: (row.lastReplyAt || row.last_reply_at)
      ? ((row.lastReplyAt ?? row.last_reply_at) instanceof Date ? (row.lastReplyAt ?? row.last_reply_at) as Date : new Date((row.lastReplyAt ?? row.last_reply_at) as string | number))
      : null,
    closedAt: (row.closedAt || row.closed_at)
      ? ((row.closedAt ?? row.closed_at) instanceof Date ? (row.closedAt ?? row.closed_at) as Date : new Date((row.closedAt ?? row.closed_at) as string | number))
      : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt ?? row.created_at) as string | number),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt ?? row.updated_at) as string | number),
  };
}

/**
 * Transitions an inquiry's lifecycle status following strict allowed transitions:
 * - open -> resolved
 * - waiting_on_customer -> resolved
 * - open -> closed
 * - waiting_on_customer -> closed
 * - resolved -> closed
 * - closed -> open (explicit seller reopen)
 *
 * Guarantees under customer & inquiry locks:
 * - Enforces customer then inquiry pessimistic lock order.
 * - Detects concurrent races and zero-row updates.
 * - Distinguishes actual transitions from idempotent already-at-target requests without rewriting timestamps.
 * - Prevents losing race from claiming false transition success (returns CONFLICT).
 * - Enforces reopen conflict checks under locks for both product and support inquiries.
 */
export async function transitionInquiryStatus(
  db: Database,
  input: TransitionInquiryStatusInput,
): Promise<TransitionInquiryStatusResult> {
  const [inquiryLookup] = await db
    .select({
      id: inquiry.id,
      customerId: inquiry.customerId,
      status: inquiry.status,
      productId: inquiry.productId,
      category: inquiry.category,
      productSnapshot: inquiry.productSnapshot,
      closedAt: inquiry.closedAt,
      updatedAt: inquiry.updatedAt,
    })
    .from(inquiry)
    .where(eq(inquiry.id, input.inquiryId))
    .limit(1);

  if (!inquiryLookup) {
    throw new RabetDataError("NOT_FOUND", `Inquiry not found: ${input.inquiryId}`);
  }

  const targetStatus = input.targetStatus;
  const isSupport = isInquirySupport(inquiryLookup.productSnapshot);

  if (
    targetStatus !== "open" &&
    targetStatus !== "resolved" &&
    targetStatus !== "closed"
  ) {
    throw new RabetDataError(
      "INVALID_INPUT",
      `Invalid target status "${String(targetStatus)}".`,
    );
  }

  // Validate allowed transitions based on authoritative lookup
  const allowed =
    inquiryLookup.status === targetStatus ||
    (inquiryLookup.status === "open" && targetStatus === "resolved") ||
    (inquiryLookup.status === "waiting_on_customer" && targetStatus === "resolved") ||
    (inquiryLookup.status === "open" && targetStatus === "closed") ||
    (inquiryLookup.status === "waiting_on_customer" && targetStatus === "closed") ||
    (inquiryLookup.status === "resolved" && targetStatus === "closed") ||
    (inquiryLookup.status === "closed" && targetStatus === "open");

  if (!allowed) {
    throw new RabetDataError(
      "INVALID_INPUT",
      `Invalid status transition from "${inquiryLookup.status}" to "${targetStatus}".`,
    );
  }

  try {
    // 1. Lock customer row first
    const lockCustomerQuery = toBatchable(
      db,
      sql`SELECT id FROM ${customer} WHERE id = ${inquiryLookup.customerId}::uuid FOR UPDATE`,
    );

    // 2. Lock inquiry row second (consistent lock order)
    const lockInquiryQuery = toBatchable(
      db,
      sql`SELECT * FROM ${inquiry} WHERE id = ${input.inquiryId}::uuid FOR UPDATE`,
    );

    if (targetStatus === "open") {
      let conflictQuery;
      if (!isSupport && inquiryLookup.productId) {
        conflictQuery = toBatchable(
          db,
          sql`
            WITH conflict_check AS (
              SELECT count(*) AS cnt, max(reference) AS ref FROM ${inquiry}
              WHERE customer_id = ${inquiryLookup.customerId}::uuid
                AND product_id = ${inquiryLookup.productId}::uuid
                AND id != ${input.inquiryId}::uuid
                AND status IN ('open', 'waiting_on_customer')
            )
            SELECT CASE
              WHEN (SELECT cnt FROM conflict_check) = 0 THEN 'ok'
              ELSE CAST('ASSERTION_FAILED_REOPEN_CONFLICT_' || (SELECT coalesce(ref, 'EXISTING') FROM conflict_check) AS date)::text
            END AS conflict_assertion;
          `,
        );
      } else {
        const categorySql = inquiryLookup.category
          ? sql`${inquiryLookup.category}::text`
          : sql`NULL::text`;

        conflictQuery = toBatchable(
          db,
          sql`
            WITH conflict_check AS (
              SELECT count(*) AS cnt, max(reference) AS ref FROM ${inquiry}
              WHERE customer_id = ${inquiryLookup.customerId}::uuid
                AND product_id IS NULL
                AND (category IS NOT DISTINCT FROM ${categorySql})
                AND id != ${input.inquiryId}::uuid
                AND status IN ('open', 'waiting_on_customer')
            )
            SELECT CASE
              WHEN (SELECT cnt FROM conflict_check) = 0 THEN 'ok'
              ELSE CAST('ASSERTION_FAILED_REOPEN_CONFLICT_' || (SELECT coalesce(ref, 'EXISTING') FROM conflict_check) AS date)::text
            END AS conflict_assertion;
          `,
        );
      }

      const reopenUpdate = toBatchable(
        db,
        sql`
          UPDATE ${inquiry}
          SET status = 'open',
              closed_at = NULL,
              updated_at = now()
          WHERE id = ${input.inquiryId}::uuid
            AND status = 'closed'
          RETURNING *
        `,
      );

      const assertionQuery = toBatchable(
        db,
        sql`
          WITH current_inq AS (
            SELECT status FROM ${inquiry} WHERE id = ${input.inquiryId}::uuid
          )
          SELECT CASE
            WHEN (SELECT status FROM current_inq) = 'open' THEN 'ok'
            ELSE CAST('ASSERTION_FAILED_TRANSITION_CONFLICT_' || (SELECT status FROM current_inq) AS date)::text
          END AS transition_assertion;
        `,
      );

      const batchResults = await executeAtomicBatch(db, [
        lockCustomerQuery,
        lockInquiryQuery,
        conflictQuery,
        reopenUpdate,
        assertionQuery,
      ]);

      const lockInqRaw = batchResults[1];
      const lockInqRows = Array.isArray(lockInqRaw)
        ? lockInqRaw
        : (lockInqRaw as { rows?: unknown[] })?.rows ?? [];
      const lockedRow = lockInqRows[0] as Record<string, unknown> | undefined;

      const updateResult = batchResults[3];
      const rows = Array.isArray(updateResult)
        ? updateResult
        : (updateResult as { rows?: unknown[] })?.rows ?? [];
      const updatedRow = rows[0] as Record<string, unknown> | undefined;

      if (updatedRow) {
        return {
          ...mapInquiryRow(updatedRow),
          alreadyAtTarget: false,
        };
      }

      if (lockedRow && lockedRow.status === "open") {
        return {
          ...mapInquiryRow(lockedRow),
          alreadyAtTarget: true,
        };
      }

      throw new RabetDataError(
        "NOT_FOUND",
        `Inquiry not found after status transition: ${input.inquiryId}`,
      );
    } else if (targetStatus === "closed") {
      const closeUpdate = toBatchable(
        db,
        sql`
          UPDATE ${inquiry}
          SET status = 'closed',
              closed_at = now(),
              updated_at = now()
          WHERE id = ${input.inquiryId}::uuid
            AND status IN ('open', 'waiting_on_customer', 'resolved')
          RETURNING *
        `,
      );

      const assertionQuery = toBatchable(
        db,
        sql`
          WITH current_inq AS (
            SELECT status FROM ${inquiry} WHERE id = ${input.inquiryId}::uuid
          )
          SELECT CASE
            WHEN (SELECT status FROM current_inq) = 'closed' THEN 'ok'
            ELSE CAST('ASSERTION_FAILED_TRANSITION_CONFLICT_' || (SELECT status FROM current_inq) AS date)::text
          END AS transition_assertion;
        `,
      );

      const batchResults = await executeAtomicBatch(db, [
        lockCustomerQuery,
        lockInquiryQuery,
        closeUpdate,
        assertionQuery,
      ]);

      const lockInqRaw = batchResults[1];
      const lockInqRows = Array.isArray(lockInqRaw)
        ? lockInqRaw
        : (lockInqRaw as { rows?: unknown[] })?.rows ?? [];
      const lockedRow = lockInqRows[0] as Record<string, unknown> | undefined;

      const updateResult = batchResults[2];
      const rows = Array.isArray(updateResult)
        ? updateResult
        : (updateResult as { rows?: unknown[] })?.rows ?? [];
      const updatedRow = rows[0] as Record<string, unknown> | undefined;

      if (updatedRow) {
        return {
          ...mapInquiryRow(updatedRow),
          alreadyAtTarget: false,
        };
      }

      if (lockedRow && lockedRow.status === "closed") {
        return {
          ...mapInquiryRow(lockedRow),
          alreadyAtTarget: true,
        };
      }

      throw new RabetDataError(
        "NOT_FOUND",
        `Inquiry not found after status transition: ${input.inquiryId}`,
      );
    } else if (targetStatus === "resolved") {
      const resolveUpdate = toBatchable(
        db,
        sql`
          UPDATE ${inquiry}
          SET status = 'resolved',
              updated_at = now()
          WHERE id = ${input.inquiryId}::uuid
            AND status IN ('open', 'waiting_on_customer')
          RETURNING *
        `,
      );

      const assertionQuery = toBatchable(
        db,
        sql`
          WITH current_inq AS (
            SELECT status FROM ${inquiry} WHERE id = ${input.inquiryId}::uuid
          )
          SELECT CASE
            WHEN (SELECT status FROM current_inq) = 'resolved' THEN 'ok'
            ELSE CAST('ASSERTION_FAILED_TRANSITION_CONFLICT_' || (SELECT status FROM current_inq) AS date)::text
          END AS transition_assertion;
        `,
      );

      const batchResults = await executeAtomicBatch(db, [
        lockCustomerQuery,
        lockInquiryQuery,
        resolveUpdate,
        assertionQuery,
      ]);

      const lockInqRaw = batchResults[1];
      const lockInqRows = Array.isArray(lockInqRaw)
        ? lockInqRaw
        : (lockInqRaw as { rows?: unknown[] })?.rows ?? [];
      const lockedRow = lockInqRows[0] as Record<string, unknown> | undefined;

      const updateResult = batchResults[2];
      const rows = Array.isArray(updateResult)
        ? updateResult
        : (updateResult as { rows?: unknown[] })?.rows ?? [];
      const updatedRow = rows[0] as Record<string, unknown> | undefined;

      if (updatedRow) {
        return {
          ...mapInquiryRow(updatedRow),
          alreadyAtTarget: false,
        };
      }

      if (lockedRow && lockedRow.status === "resolved") {
        return {
          ...mapInquiryRow(lockedRow),
          alreadyAtTarget: true,
        };
      }

      throw new RabetDataError(
        "NOT_FOUND",
        `Inquiry not found after status transition: ${input.inquiryId}`,
      );
    }

    throw new RabetDataError(
      "INVALID_INPUT",
      `Invalid target status "${targetStatus}".`,
    );
  } catch (error) {
    const errText =
      (error instanceof Error ? error.message : "") +
      " " +
      ((error as { cause?: Error })?.cause?.message ?? "") +
      " " +
      String(error);

    if (errText.includes("ASSERTION_FAILED_REOPEN_CONFLICT_")) {
      const match = errText.match(/ASSERTION_FAILED_REOPEN_CONFLICT_([A-Za-z0-9-]+)/);
      const conflictRef = match ? match[1] : "an existing thread";
      throw new RabetDataError(
        "CONFLICT",
        `Cannot reopen: Another active conversation already exists (${conflictRef}). Close or resolve it first.`,
      );
    }

    if (errText.includes("ASSERTION_FAILED_TRANSITION_CONFLICT_")) {
      const match = errText.match(
        /ASSERTION_FAILED_TRANSITION_CONFLICT_([A-Za-z0-9_]+)/,
      );
      const currentSt = match ? match[1] : "modified";
      throw new RabetDataError(
        "CONFLICT",
        `Cannot transition to "${targetStatus}": conversation status was concurrently changed to "${currentSt}".`,
      );
    }

    if (error instanceof RabetDataError) throw error;
    throw mapDatabaseError(error);
  }
}
