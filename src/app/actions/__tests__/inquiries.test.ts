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
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  describe("Authorization enforcement", () => {
    it("sendSellerReplyAction rejects and performs zero DB or transport calls when unauthorized", async () => {
      mockRequireAdmin.mockRejectedValueOnce(new Error("Unauthorized: Admin session required"));

      await expect(
        sendSellerReplyAction({
          inquiryId: "c8e27c10-0000-4000-8000-000000000001",
          body: "Hello customer",
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
    it("rejects invalid or non-UUID inquiryId in sendSellerReplyAction", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "not-a-uuid",
        body: "Hello",
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
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Reply message cannot be empty or whitespace-only.");
      expect(mockSendSellerReply).not.toHaveBeenCalled();
    });

    it("rejects invalid clientOperationId if provided", async () => {
      const res = await sendSellerReplyAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        body: "Valid body",
        clientOperationId: "malformed-op-id",
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("INVALID_INPUT");
      expect(res.message).toBe("Client operation ID must be a valid UUID.");
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

  describe("Successful operations and revalidation", () => {
    it("sendSellerReplyAction revalidates paths and returns success", async () => {
      const dummyMsg = {
        id: "c8e27c10-0000-4000-8000-000000000002",
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        author: "admin",
        body: "Your order is ready",
        deliveryStatus: "sent",
      };

      mockSendSellerReply.mockResolvedValueOnce({
        success: true,
        message: dummyMsg,
      });

      const res = await sendSellerReplyAction(
        {
          inquiryId: "c8e27c10-0000-4000-8000-000000000001",
          body: "Your order is ready",
        },
        {
          transport: {
            sendMessage: vi.fn(),
            editMessageText: vi.fn(),
            answerCallbackQuery: vi.fn(),
          },
        },
      );

      expect(res.success).toBe(true);
      expect(mockRevalidatePath).toHaveBeenCalledWith("/inquiries");
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/inquiries/c8e27c10-0000-4000-8000-000000000001",
      );
    });

    it("transitionInquiryStatusAction revalidates paths and returns success", async () => {
      mockTransitionInquiryStatus.mockResolvedValueOnce({
        id: "c8e27c10-0000-4000-8000-000000000001",
        status: "resolved",
      });

      const res = await transitionInquiryStatusAction({
        inquiryId: "c8e27c10-0000-4000-8000-000000000001",
        targetStatus: "resolved",
      });

      expect(res.success).toBe(true);
      expect(res.message).toBe("Inquiry successfully resolved.");
      expect(mockRevalidatePath).toHaveBeenCalledWith("/inquiries");
      expect(mockRevalidatePath).toHaveBeenCalledWith(
        "/inquiries/c8e27c10-0000-4000-8000-000000000001",
      );
    });
  });
});
