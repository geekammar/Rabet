import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockSendSellerReply = vi.fn();
const mockRetrySellerReply = vi.fn();
const mockTransitionInquiryStatus = vi.fn();

vi.mock("@/lib/data/seller-inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/seller-inbox")>();
  return {
    ...actual,
    sendSellerReply: (...args: unknown[]) => mockSendSellerReply(...args),
    retrySellerReply: (...args: unknown[]) => mockRetrySellerReply(...args),
    transitionInquiryStatus: (...args: unknown[]) => mockTransitionInquiryStatus(...args),
  };
});

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const {
  sendSellerReplyAction,
  retrySellerReplyAction,
  transitionInquiryStatusAction,
} = await import("../inquiries");

describe("Inquiries Server Actions Authorization and Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN";
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  describe("Authorization enforcement", () => {
    it("sendSellerReplyAction rejects and performs zero DB or transport calls when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized: Admin session required"));

      await expect(
        sendSellerReplyAction({
          inquiryId: "c8e27c10-0000-4000-8000-000000000001",
          body: "Hello customer",
          clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
        }),
      ).rejects.toThrow("Unauthorized: Admin session required");

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("retrySellerReplyAction rejects when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized: Admin session required"));

      await expect(
        retrySellerReplyAction({
          inquiryId: "c8e27c10-0000-4000-8000-000000000001",
          sourceMessageId: "c8e27c10-0000-4000-8000-000000000002",
        }),
      ).rejects.toThrow("Unauthorized: Admin session required");

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockRetrySellerReply).not.toHaveBeenCalled();
    });

    it("transitionInquiryStatusAction rejects when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized: Admin session required"));

      await expect(
        transitionInquiryStatusAction({
          inquiryId: "c8e27c10-0000-4000-8000-000000000001",
          targetStatus: "resolved",
        }),
      ).rejects.toThrow("Unauthorized: Admin session required");

      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockTransitionInquiryStatus).not.toHaveBeenCalled();
    });
  });

  describe("Validation enforcement", () => {
    it("rejects null or non-object payloads safely", async () => {
      const res = await sendSellerReplyAction(null as unknown as {
        inquiryId: string;
        body: string;
        clientOperationId: string;
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Payload must be a non-null object.");
    });

    it("rejects non-string inquiryId without throwing", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: 12345 as unknown as string,
        body: "Hello",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Valid inquiry ID is required.");
    });

    it("rejects invalid or non-UUID inquiryId in sendSellerReplyAction", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "not-a-uuid",
        body: "Hello",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Valid inquiry ID is required.");
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("rejects empty or whitespace-only message body in sendSellerReplyAction", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "   \n\t  ",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Reply message cannot be empty or whitespace-only.");
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("requires a valid stable clientOperationId for sendSellerReplyAction", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Valid body",
        clientOperationId: "malformed-op-id",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Client operation ID is required and must be a valid UUID.");
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("rejects missing clientOperationId in sendSellerReplyAction", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Valid body",
      } as unknown as { inquiryId: string; body: string; clientOperationId: string });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Client operation ID is required and must be a valid UUID.");
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("rejects invalid targetStatus in transitionInquiryStatusAction", async () => {
      const res = await transitionInquiryStatusAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        targetStatus: "invalid_status" as unknown as "open",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(mockTransitionInquiryStatus).not.toHaveBeenCalled();
    });
  });

  describe("Authoritative delivery outcome contracts", () => {
    const dummyMsg = {
      id: "c8e27c10-0000-4000-8000-000000000002",
      inquiryId: "c8e27c10-0000-4000-8000-000000000001",
      author: "admin" as const,
      body: "Your order is ready",
      deliveryStatus: "sent" as const,
      telegramMessageId: 8801,
      deliveryError: null,
      deliveredAt: new Date(),
      createdAt: new Date(),
    };

    it("returns confirmed_sent with sent message wording when delivery succeeds", async () => {
      mockSendSellerReply.mockResolvedValueOnce({
        success: true,
        outcome: "confirmed_sent",
        message: dummyMsg,
      });

      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Your order is ready",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(true);
      expect(res.outcome).toBe("confirmed_sent");
      expect(res.message).toBe("Reply sent successfully.");
      expect(mockRevalidatePath).toHaveBeenCalledWith("/inquiries");
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/inquiries/c8e27c10-0000-4000-8000-000000000001",
      );
    });

    it("returns recorded_pending with in-flight wording when reply is already pending (not claiming sent)", async () => {
      mockSendSellerReply.mockResolvedValueOnce({
        success: false,
        outcome: "recorded_pending",
        message: { ...dummyMsg, deliveryStatus: "pending" },
        alreadyReserved: true,
      });

      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Your order is ready",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe("recorded_pending");
      expect(res.code).toBe("DELIVERY_PENDING");
      expect(res.message).toBe("Reply is already recorded and pending delivery.");
    });

    it("returns unconfirmed_outcome with caution wording when outcome is ambiguous", async () => {
      mockSendSellerReply.mockResolvedValueOnce({
        success: false,
        outcome: "unconfirmed_outcome",
        message: { ...dummyMsg, deliveryStatus: "pending" },
        error: "Database delivery record update affected 0 rows",
      });

      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Your order is ready",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe("unconfirmed_outcome");
      expect(res.code).toBe("DELIVERY_UNCONFIRMED");
      expect(res.message).toContain("Delivery status is unconfirmed");
    });

    it("returns confirmed_failed when delivery fails", async () => {
      mockSendSellerReply.mockResolvedValueOnce({
        success: false,
        outcome: "confirmed_failed",
        message: { ...dummyMsg, deliveryStatus: "failed" },
        error: "telegram_api_error_400",
      });

      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Your order is ready",
        clientOperationId: "c8e27c10-0000-4000-8000-000000000002",
      });

      expect(res.success).toBe(false);
      expect(res.outcome).toBe("confirmed_failed");
      expect(res.code).toBe("DELIVERY_FAILED");
      expect(res.message).toContain("Reply was recorded but delivery failed");
    });
  });

  describe("Lifecycle actions and idempotent targets", () => {
    it("transitionInquiryStatusAction distinguishes real transition from idempotent request", async () => {
      // 1. Real transition
      mockTransitionInquiryStatus.mockResolvedValueOnce({
        id: "c8e27c10-0000-4000-8000-000000000001",
        status: "resolved",
        alreadyAtTarget: false,
      });

      const res1 = await transitionInquiryStatusAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        targetStatus: "resolved",
      });

      expect(res1.success).toBe(true);
      expect(res1.message).toBe("Inquiry successfully resolved.");

      // 2. Idempotent already-at-target request
      mockTransitionInquiryStatus.mockResolvedValueOnce({
        id: "c8e27c10-0000-4000-8000-000000000001",
        status: "resolved",
        alreadyAtTarget: true,
      });

      const res2 = await transitionInquiryStatusAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        targetStatus: "resolved",
      });

      expect(res2.success).toBe(true);
      expect(res2.message).toBe("Inquiry is already resolved.");
    });
  });
});
