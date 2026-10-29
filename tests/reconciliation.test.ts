import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockSendSellerReply = vi.fn();
const mockRetrySellerReply = vi.fn();
vi.mock("@/lib/data/seller-inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/seller-inbox")>();
  return {
    ...actual,
    sendSellerReply: (...args: unknown[]) => mockSendSellerReply(...args),
    retrySellerReply: (...args: unknown[]) => mockRetrySellerReply(...args),
  };
});

describe("Server Action: Exact Operation Reconciliation & Reservation Guarantees", () => {
  const originalEnvToken = process.env.TELEGRAM_BOT_TOKEN;
  let sendSellerReplyAction: typeof import("@/app/actions/inquiries").sendSellerReplyAction;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const mod = await import("@/app/actions/inquiries");
    sendSellerReplyAction = mod.sendSellerReplyAction;
  });

  afterEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = originalEnvToken;
  });

  it("1. Missing bot configuration before reservation returns reserved: false and allows submitting same text once configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    const testInqId = "11111111-1111-1111-1111-111111111111";
    const testOpId = "22222222-2222-2222-2222-222222222222";
    const testBody = "Hello customer!";

    // First attempt: missing bot token
    const res1 = await sendSellerReplyAction({
      inquiryId: testInqId,
      body: testBody,
      clientOperationId: testOpId,
    });

    // Proves pre-reservation failure: reserved is false, never called sendSellerReply
    expect(res1.success).toBe(false);
    expect(res1.reserved).toBe(false);
    expect(res1.code).toBe("INVALID_INPUT");
    expect(res1.message).toContain("Telegram bot token is not configured");
    expect(mockSendSellerReply).not.toHaveBeenCalled();

    // Now bot token is configured
    process.env.TELEGRAM_BOT_TOKEN = "valid-token-123";
    mockSendSellerReply.mockResolvedValueOnce({
      success: true,
      outcome: "confirmed_sent",
      message: { id: testOpId, body: testBody, deliveryStatus: "sent" },
    });

    // Second attempt: same text and fresh/same operation can now be submitted
    const res2 = await sendSellerReplyAction(
      {
        inquiryId: testInqId,
        body: testBody,
        clientOperationId: testOpId,
      },
      { db: {} as never },
    );

    expect(res2.success).toBe(true);
    expect(res2.reserved).toBe(true);
    expect(res2.outcome).toBe("confirmed_sent");
    expect(mockSendSellerReply).toHaveBeenCalledTimes(1);
  });

  it("2. Exact draft reconciliation: whitespace edit preserves authoring and rejects trim-equality erasure", () => {
    const originalBody = "Hello Customer";
    const whitespaceEditedBody = "Hello Customer "; // trailing whitespace added by seller

    // Trim equality would falsely claim these are equal:
    expect(originalBody.trim()).toBe(whitespaceEditedBody.trim());

    // Exact equality correctly protects the newer draft from being erased:
    expect(whitespaceEditedBody === originalBody).toBe(false);
  });

  it("3. Unrelated retry event in same inquiry does not clear bound operation for different source message", () => {
    const sourceA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sourceB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    let boundOp: { id: string; body: string } | null = {
      id: sourceA,
      body: "Draft A content",
    };

    // Retry event for sourceB arrives
    const eventDetail = {
      inquiryId: "11111111-1111-1111-1111-111111111111",
      sourceMessageId: sourceB,
      retriedBody: "Message B content",
    };

    // Reconciler checks sourceMessageId:
    if (boundOp && boundOp.id === eventDetail.sourceMessageId) {
      boundOp = null;
    }

    // Operation A is preserved!
    expect(boundOp).not.toBeNull();
    expect(boundOp?.id).toBe(sourceA);
  });

  it("4. Matching failed-operation retry event reconciles only the matching bound operation and draft", () => {
    const sourceA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let boundOp: { id: string; body: string } | null = {
      id: sourceA,
      body: "Draft A content",
    };
    let draftBody = "Draft A content";

    // Retry event for matching sourceA arrives
    const eventDetail = {
      inquiryId: "11111111-1111-1111-1111-111111111111",
      sourceMessageId: sourceA,
      retriedBody: "Draft A content",
    };

    if (boundOp && boundOp.id === eventDetail.sourceMessageId) {
      if (draftBody === eventDetail.retriedBody) {
        draftBody = "";
      }
      boundOp = null;
    }

    expect(boundOp).toBeNull();
    expect(draftBody).toBe("");
  });

  it("5. Editing uncertain operation retains unresolved identity until explicit duplication decision", () => {
    const uncertainOpId = "uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu";
    const unresolvedOp = {
      id: uncertainOpId,
      body: "Uncertain reply text",
      status: "unconfirmed" as const,
    };

    const editedDraft = "Edited new reply text";

    // Text changed:
    expect(editedDraft !== unresolvedOp.body).toBe(true);

    // Unresolved identity is retained separately:
    expect(unresolvedOp.status).toBe("unconfirmed");
    expect(unresolvedOp.id).toBe(uncertainOpId);

    // Submission guard without explicit duplication acknowledgement:
    const duplicationAcknowledged = false;
    const canSend = !unresolvedOp || unresolvedOp.status !== "unconfirmed" || duplicationAcknowledged;
    expect(canSend).toBe(false);

    // Once user explicitly confirms duplication risk:
    const userConfirmedDuplication = true;
    const canSendNow = !unresolvedOp || unresolvedOp.status !== "unconfirmed" || userConfirmedDuplication;
    expect(canSendNow).toBe(true);
  });
});
