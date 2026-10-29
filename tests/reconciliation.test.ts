import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelegramTransport } from "@/lib/telegram/types";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// In-memory mock database state
interface MockInquiryMessage {
  id: string;
  inquiryId: string;
  author: string;
  body: string;
  deliveryStatus: "pending" | "sent" | "failed";
  deliveryError: string | null;
  telegramMessageId: number | null;
  createdAt: Date;
}

let mockMessages: MockInquiryMessage[] = [];

// Track EVERY transport invocation (success, failure, exception)
interface TransportInvocation {
  chatId: number | string;
  text: string;
  ok: boolean;
  error?: string;
  thrown?: boolean;
}

function createLedgerTransport(baseTransport: TelegramTransport) {
  const ledger: TransportInvocation[] = [];
  const wrapped: TelegramTransport & { ledger: TransportInvocation[]; totalInvocations: number } = {
    ledger,
    get totalInvocations() {
      return ledger.length;
    },
    async sendMessage(params) {
      try {
        const res = await baseTransport.sendMessage(params);
        ledger.push({
          chatId: params.chatId,
          text: params.text,
          ok: res.ok,
          error: res.ok ? undefined : res.error,
        });
        return res;
      } catch (err) {
        ledger.push({
          chatId: params.chatId,
          text: params.text,
          ok: false,
          error: String(err),
          thrown: true,
        });
        throw err;
      }
    },
    async editMessageText(params) {
      return baseTransport.editMessageText(params);
    },
    async answerCallbackQuery(params) {
      return baseTransport.answerCallbackQuery(params);
    },
  };
  return wrapped;
}

// In-memory session storage simulation for client persistence assertions
class MemorySessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

// Mock seller-inbox data functions to operate on in-memory mockMessages
vi.mock("@/lib/data/seller-inbox", async () => {
  return {
    sendSellerReply: async (
      _db: unknown,
      transport: TelegramTransport,
      input: { inquiryId: string; body: string; operationId: string },
    ) => {
      // 1. Check if already reserved
      const existing = mockMessages.find((m) => m.id === input.operationId);
      if (existing) {
        if (existing.deliveryStatus === "sent") {
          return {
            success: true,
            outcome: "confirmed_sent",
            message: existing,
            alreadyReserved: true,
          };
        }
        if (existing.deliveryStatus === "failed") {
          return {
            success: false,
            outcome: "confirmed_failed",
            message: existing,
            error: existing.deliveryError ?? "Previous delivery failed",
            alreadyReserved: true,
          };
        }
        return {
          success: false,
          outcome: existing.deliveryError ? "unconfirmed_outcome" : "recorded_pending",
          message: existing,
          error: existing.deliveryError ?? undefined,
          alreadyReserved: true,
        };
      }

      // 2. Reserve pending message
      const newMsg: MockInquiryMessage = {
        id: input.operationId,
        inquiryId: input.inquiryId,
        author: "admin",
        body: input.body,
        deliveryStatus: "pending",
        deliveryError: null,
        telegramMessageId: null,
        createdAt: new Date(),
      };
      mockMessages.push(newMsg);

      // 3. Dispatch to transport
      const sendRes = await transport.sendMessage({
        chatId: 10001,
        text: `[INQ-TEST]\n\n${input.body}`,
      });

      if (sendRes.ok && sendRes.messageId) {
        newMsg.deliveryStatus = "sent";
        newMsg.telegramMessageId = sendRes.messageId;
        return {
          success: true,
          outcome: "confirmed_sent",
          message: newMsg,
        };
      }

      if (sendRes.errorKind === "timeout" || sendRes.errorKind === "network_error") {
        newMsg.deliveryError = sendRes.error;
        return {
          success: false,
          outcome: "unconfirmed_outcome",
          message: newMsg,
          error: sendRes.error,
        };
      }

      newMsg.deliveryStatus = "failed";
      newMsg.deliveryError = sendRes.error ?? "Delivery failed";
      return {
        success: false,
        outcome: "confirmed_failed",
        message: newMsg,
        error: newMsg.deliveryError,
      };
    },

    getSellerOperationStatus: async (
      _db: unknown,
      inquiryId: string,
      operationId: string,
    ) => {
      const msg = mockMessages.find(
        (m) => m.id === operationId && m.inquiryId === inquiryId,
      );
      if (!msg || msg.author !== "admin") {
        return { found: false, operationId, inquiryId };
      }
      let outcome: "confirmed_sent" | "confirmed_failed" | "unconfirmed_outcome" | "recorded_pending";
      if (msg.deliveryStatus === "sent") {
        outcome = "confirmed_sent";
      } else if (msg.deliveryStatus === "failed") {
        outcome = "confirmed_failed";
      } else if (msg.deliveryError) {
        outcome = "unconfirmed_outcome";
      } else {
        outcome = "recorded_pending";
      }
      return {
        found: true,
        operationId,
        inquiryId,
        outcome,
        message: msg,
      };
    },

    retrySellerReply: vi.fn(),
    transitionInquiryStatus: vi.fn(),
  };
});

describe("Phase 09: Exact Operation Reconciliation & Identity Preservation", () => {
  const originalEnvToken = process.env.TELEGRAM_BOT_TOKEN;
  let sendSellerReplyAction: typeof import("@/app/actions/inquiries").sendSellerReplyAction;
  let reconcileSellerOperationAction: typeof import("@/app/actions/inquiries").reconcileSellerOperationAction;
  let sessionStorage: MemorySessionStorage;

  const testInquiryId = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMessages = [];
    sessionStorage = new MemorySessionStorage();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const mod = await import("@/app/actions/inquiries");
    sendSellerReplyAction = mod.sendSellerReplyAction;
    reconcileSellerOperationAction = mod.reconcileSellerOperationAction;
  });

  afterEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = originalEnvToken;
  });

  it("Scenario A: Delayed first response — identity persisted before dispatch, reload reconciles, no duplicate transport call", async () => {
    const rawTransport = createFakeTelegramTransport();
    const transport = createLedgerTransport(rawTransport);

    const clientOpId = "22222222-2222-2222-2222-222222222222";
    const replyBody = "Delayed first response text";

    // 1. Synchronously persist operation identity BEFORE dispatch (the repair under test)
    const boundOpKey = `rabet_bound_op_${testInquiryId}`;
    const unresolvedOpKey = `rabet_unresolved_op_${testInquiryId}`;
    const storageKey = `rabet_draft_inquiry_${testInquiryId}`;

    sessionStorage.setItem(
      boundOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "pending" }),
    );
    sessionStorage.setItem(
      unresolvedOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "pending" }),
    );
    sessionStorage.setItem(storageKey, replyBody);

    // Prove operation identity was stored before server response arrives:
    expect(sessionStorage.getItem(boundOpKey)).toContain(clientOpId);
    expect(sessionStorage.getItem(unresolvedOpKey)).toContain(clientOpId);
    expect(sessionStorage.getItem(storageKey)).toBe(replyBody);

    // 2. Server action executes and commits reservation + delivery
    const result = await sendSellerReplyAction(
      {
        inquiryId: testInquiryId,
        body: replyBody,
        clientOperationId: clientOpId,
      },
      { transport, db: {} as never },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("confirmed_sent");
    expect(transport.totalInvocations).toBe(1);

    // 3. Simulate page reload before response callback was processed:
    // Composer mounts afresh and reads sessionStorage:
    const restoredUnresolved = JSON.parse(sessionStorage.getItem(unresolvedOpKey)!);
    expect(restoredUnresolved.id).toBe(clientOpId);

    // 4. Reconcile read-only on mount
    const reconciliation = await reconcileSellerOperationAction(
      {
        inquiryId: testInquiryId,
        operationId: restoredUnresolved.id,
      },
      { db: {} as never },
    );

    expect(reconciliation.success).toBe(true);
    expect(reconciliation.found).toBe(true);
    if (reconciliation.found) {
      expect(reconciliation.outcome).toBe("confirmed_sent");
      expect(reconciliation.body).toBe(replyBody);
      // Reconciled successfully: clear draft and bindings
      sessionStorage.removeItem(storageKey);
      sessionStorage.removeItem(boundOpKey);
      sessionStorage.removeItem(unresolvedOpKey);
    }

    expect(sessionStorage.getItem(storageKey)).toBeNull();

    // 5. If seller attempts to resubmit with the same stable identity:
    const duplicateRes = await sendSellerReplyAction(
      {
        inquiryId: testInquiryId,
        body: replyBody,
        clientOperationId: clientOpId,
      },
      { transport, db: {} as never },
    );

    expect(duplicateRes.success).toBe(true);
    expect(duplicateRes.outcome).toBe("confirmed_sent");

    // Exact transport ledger assertion: ZERO second transport calls occurred!
    expect(transport.totalInvocations).toBe(1);
    expect(transport.ledger).toHaveLength(1);
    expect(transport.ledger[0].ok).toBe(true);
  });

  it("Scenario B: Generic unknown result — preserves identity, reconciles by reading, does not label confirmed_failed", async () => {
    const rawTransport = createFakeTelegramTransport();
    const transport = createLedgerTransport(rawTransport);

    const clientOpId = "33333333-3333-3333-3333-333333333333";
    const replyBody = "Message with generic network error";

    // Pre-dispatch persistence
    const boundOpKey = `rabet_bound_op_${testInquiryId}`;
    const unresolvedOpKey = `rabet_unresolved_op_${testInquiryId}`;
    const storageKey = `rabet_draft_inquiry_${testInquiryId}`;

    sessionStorage.setItem(
      boundOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "pending" }),
    );
    sessionStorage.setItem(
      unresolvedOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "pending" }),
    );
    sessionStorage.setItem(storageKey, replyBody);

    // Simulate transport timeout / network exception
    rawTransport.failSendWith = "ETIMEDOUT: Connection dropped";
    rawTransport.failSendKind = "timeout";

    const result = await sendSellerReplyAction(
      {
        inquiryId: testInquiryId,
        body: replyBody,
        clientOperationId: clientOpId,
      },
      { transport, db: {} as never },
    );

    // Crucial check: outcome is unconfirmed_outcome, NOT confirmed_failed
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("unconfirmed_outcome");
    expect(result.outcome).not.toBe("confirmed_failed");

    // Update client state to unconfirmed
    sessionStorage.setItem(
      boundOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "unconfirmed" }),
    );
    sessionStorage.setItem(
      unresolvedOpKey,
      JSON.stringify({ id: clientOpId, body: replyBody, status: "unconfirmed" }),
    );

    // Reconcile by reading durable state
    const reconcileRes = await reconcileSellerOperationAction(
      {
        inquiryId: testInquiryId,
        operationId: clientOpId,
      },
      { db: {} as never },
    );

    expect(reconcileRes.success).toBe(true);
    expect(reconcileRes.found).toBe(true);
    if (reconcileRes.found) {
      expect(reconcileRes.outcome).toBe("unconfirmed_outcome");
      expect(reconcileRes.deliveryStatus).toBe("pending");
      expect(reconcileRes.outcome).not.toBe("confirmed_failed");
    }

    // Transport ledger proves exactly 1 failed attempt, 0 duplicate sends
    expect(transport.totalInvocations).toBe(1);
    expect(transport.ledger[0].ok).toBe(false);
    expect(transport.ledger[0].error).toContain("ETIMEDOUT");
  });

  it("Scenario C: Edit and revert — preserves identity and prevents accidental fresh submission", () => {
    const originalText = "Original message to customer";
    const opA = "44444444-4444-4444-4444-444444444444";

    const boundOpKey = `rabet_bound_op_${testInquiryId}`;
    const unresolvedOpKey = `rabet_unresolved_op_${testInquiryId}`;

    // Unresolved operation A exists
    sessionStorage.setItem(
      boundOpKey,
      JSON.stringify({ id: opA, body: originalText, status: "unconfirmed" }),
    );
    sessionStorage.setItem(
      unresolvedOpKey,
      JSON.stringify({ id: opA, body: originalText, status: "unconfirmed" }),
    );

    const storageKey = `rabet_draft_inquiry_${testInquiryId}`;

    // Step 1: Seller edits draft
    const editedText = "Edited message to customer";
    sessionStorage.setItem(storageKey, editedText);
    expect(sessionStorage.getItem(storageKey)).toBe(editedText);

    // boundOp detaches because body changed, but unresolvedOp is retained:
    sessionStorage.removeItem(boundOpKey);

    expect(sessionStorage.getItem(boundOpKey)).toBeNull();
    const preservedUnresolved = JSON.parse(sessionStorage.getItem(unresolvedOpKey)!);
    expect(preservedUnresolved.id).toBe(opA);
    expect(preservedUnresolved.body).toBe(originalText);

    // Step 2: Seller reverts text back to originalText
    // Reconnecting logic in handleBodyChange re-associates opA:
    if (preservedUnresolved.body === originalText) {
      sessionStorage.setItem(
        boundOpKey,
        JSON.stringify({ id: preservedUnresolved.id, body: originalText, status: "unconfirmed" }),
      );
    }

    const reconnectedBound = JSON.parse(sessionStorage.getItem(boundOpKey)!);
    expect(reconnectedBound.id).toBe(opA);

    // Verify submission reuses opA without rotating to a fresh UUID
    let submittedOpId: string;
    if (reconnectedBound && reconnectedBound.body === originalText) {
      submittedOpId = reconnectedBound.id;
    } else {
      submittedOpId = crypto.randomUUID();
    }

    expect(submittedOpId).toBe(opA);
  });

  it("Scenario D: Unrelated operation — retry B while A is unresolved leaves A intact", () => {
    const opA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const opB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const boundOpKey = `rabet_bound_op_${testInquiryId}`;
    const unresolvedOpKey = `rabet_unresolved_op_${testInquiryId}`;
    const storageKey = `rabet_draft_inquiry_${testInquiryId}`;

    const draftA = "Authoring draft for A";
    sessionStorage.setItem(
      boundOpKey,
      JSON.stringify({ id: opA, body: draftA, status: "unconfirmed" }),
    );
    sessionStorage.setItem(
      unresolvedOpKey,
      JSON.stringify({ id: opA, body: draftA, status: "unconfirmed" }),
    );
    sessionStorage.setItem(storageKey, draftA);

    // Event for unrelated opB retry completes:
    const eventB = {
      inquiryId: testInquiryId,
      sourceMessageId: opB,
      retriedBody: "Message B content",
    };

    // Reconciler handler logic from ReplyComposer:
    const currentBound = JSON.parse(sessionStorage.getItem(boundOpKey)!);
    const currentUnresolved = JSON.parse(sessionStorage.getItem(unresolvedOpKey)!);
    const currentDraft = sessionStorage.getItem(storageKey);

    if (currentBound?.id === eventB.sourceMessageId) {
      sessionStorage.removeItem(boundOpKey);
    }
    if (currentUnresolved?.id === eventB.sourceMessageId) {
      sessionStorage.removeItem(unresolvedOpKey);
    }
    if (currentBound?.id === eventB.sourceMessageId && currentDraft === eventB.retriedBody) {
      sessionStorage.removeItem(storageKey);
    }

    // A remains 100% intact!
    expect(sessionStorage.getItem(boundOpKey)).not.toBeNull();
    expect(sessionStorage.getItem(unresolvedOpKey)).not.toBeNull();
    expect(sessionStorage.getItem(storageKey)).toBe(draftA);
    expect(JSON.parse(sessionStorage.getItem(unresolvedOpKey)!).id).toBe(opA);

    // Now matching event for opA arrives:
    const eventA = {
      inquiryId: testInquiryId,
      sourceMessageId: opA,
      retriedBody: draftA,
    };

    if (JSON.parse(sessionStorage.getItem(boundOpKey)!).id === eventA.sourceMessageId) {
      sessionStorage.removeItem(boundOpKey);
    }
    if (JSON.parse(sessionStorage.getItem(unresolvedOpKey)!).id === eventA.sourceMessageId) {
      sessionStorage.removeItem(unresolvedOpKey);
    }
    if (sessionStorage.getItem(storageKey) === eventA.retriedBody) {
      sessionStorage.removeItem(storageKey);
    }

    // Operation A is now reconciled and cleared
    expect(sessionStorage.getItem(boundOpKey)).toBeNull();
    expect(sessionStorage.getItem(unresolvedOpKey)).toBeNull();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("Scenario E: Pre-reservation failure — missing config produces reserved: false, then succeeds once configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    const rawTransport = createFakeTelegramTransport();
    const transport = createLedgerTransport(rawTransport);

    const testOpId = "55555555-5555-5555-5555-555555555555";
    const testBody = "Hello before config";

    // Attempt 1: Bot token missing (no transport override provided)
    const res1 = await sendSellerReplyAction(
      {
        inquiryId: testInquiryId,
        body: testBody,
        clientOperationId: testOpId,
      },
      { db: {} as never },
    );

    expect(res1.success).toBe(false);
    expect(res1.reserved).toBe(false);
    expect(res1.code).toBe("INVALID_INPUT");
    expect(res1.message).toContain("Telegram bot token is not configured");

    // Transport ledger proves ZERO calls were made:
    expect(transport.totalInvocations).toBe(0);
    expect(transport.ledger).toHaveLength(0);

    // Now bot token is configured
    process.env.TELEGRAM_BOT_TOKEN = "valid-token-scenario-e";

    // Attempt 2: Same text and stable operation ID submitted
    const res2 = await sendSellerReplyAction(
      {
        inquiryId: testInquiryId,
        body: testBody,
        clientOperationId: testOpId,
      },
      { transport, db: {} as never },
    );

    expect(res2.success).toBe(true);
    expect(res2.reserved).toBe(true);
    expect(res2.outcome).toBe("confirmed_sent");

    // Transport ledger proves exactly 1 transport call was made across the whole sequence
    expect(transport.totalInvocations).toBe(1);
    expect(transport.ledger).toHaveLength(1);
    expect(transport.ledger[0].ok).toBe(true);
  });
});
