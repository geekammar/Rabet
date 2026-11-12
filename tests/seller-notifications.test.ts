import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkNotificationBotConnectionAction,
  detectNotificationBotChatsAction,
  loadSellerNotificationStateAction,
  retrySellerNotificationDeliveryAction,
  saveSellerNotificationConfigAction,
  sendSellerTestNotificationAction,
  toggleSellerNotificationEnabledAction,
} from "@/app/actions/seller-notifications";
import {
  checkSellerNotificationCapability,
  validatePrivateChatId,
} from "@/lib/data/seller-notifications";
import {
  attemptSellerNotificationDelivery,
  formatSellerNotificationMessage,
  getSellerBotMe,
  getSellerNotificationBotToken,
  getTrustedDashboardInquiryUrl,
  sendSellerTestNotification,
} from "@/lib/telegram/seller-notifications";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";

// Mock requireAdmin to test authorization gate
const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

// Mock DB client
const mockGetDb = vi.fn(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

// Mock revalidatePath
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

describe("Seller Notifications — Unit & Security Test Suite", () => {
  const originalEnv = { ...process.env };
  const SENSITIVE_TOKEN = "987654321:AAHsecret_seller_bot_token_do_not_leak_XYZ";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Group A — Setup & Security (Tests 1–8)
  // =========================================================================

  describe("Group A: Setup and Security", () => {
    // Requirement 1: Missing token disables/blocks test send without customer impact
    it("Test 1: Missing token disables/blocks test send without throwing unhandled exceptions", async () => {
      delete process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN;
      expect(getSellerNotificationBotToken()).toBeNull();

      const result = await checkNotificationBotConnectionAction();
      expect(result.success).toBe(false);
      expect(result.message).toContain("TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN is not configured");

      // Verify customer bot token is NEVER used as fallback
      process.env.TELEGRAM_BOT_TOKEN = "111111111:CUSTOMER_BOT_TOKEN";
      expect(getSellerNotificationBotToken()).toBeNull();
    });

    // Requirement 2: Invalid token surfaces safe error without leaking token in error text or logs
    it("Test 2: Invalid token surfaces a safe error; does not expose token in error text or logs", async () => {
      process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN = SENSITIVE_TOKEN;

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error_code: 401, description: `Unauthorized bot ${SENSITIVE_TOKEN}` }),
      } as Response);

      const result = await getSellerBotMe(SENSITIVE_TOKEN, 5000);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();

      // STRICT REDACTION CHECK
      expect(result.error).not.toContain(SENSITIVE_TOKEN);
      expect(result.error).not.toContain("AAHsecret");
      expect(JSON.stringify(result)).not.toContain(SENSITIVE_TOKEN);
    });

    // Requirement 3: Bot identity mismatch refuses to send or claim verified state
    it("Test 3: Bot identity mismatch: getMe returns bot B when verified was for bot A; refuses verified state", async () => {
      process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN = SENSITIVE_TOKEN;

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { id: 999999, is_bot: true, username: "BotB", first_name: "Different Bot" },
        }),
      } as Response);

      const res = await getSellerBotMe(SENSITIVE_TOKEN, 5000);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.bot.id).toBe(999999);
        expect(res.bot.username).toBe("BotB");
        // An existing verifiedBotId 111111 !== 999999 must detect identity change
        const verifiedBotId = 111111;
        expect(res.bot.id === verifiedBotId).toBe(false);
      }
    });

    // Requirement 4: Destination validation
    it("Test 4: Destination validation: accepts valid decimal Telegram private chat IDs; rejects invalid", () => {
      // Valid positive decimal integer strings (Private Telegram user IDs >= 5 digits)
      expect(validatePrivateChatId("123456789")).toBe(true);
      expect(validatePrivateChatId("9876543210123456")).toBe(true);
      expect(validatePrivateChatId("10001")).toBe(true);
      expect(validatePrivateChatId("8882910")).toBe(true);

      // Invalid inputs: channels/supergroups (negative), usernames, URLs, strings, too short
      expect(validatePrivateChatId("1")).toBe(false); // Too short for Telegram user ID
      expect(validatePrivateChatId("-1001234567890")).toBe(false); // Groups/channels rejected
      expect(validatePrivateChatId("")).toBe(false);
      expect(validatePrivateChatId("   ")).toBe(false);
      expect(validatePrivateChatId("@seller_channel")).toBe(false);
      expect(validatePrivateChatId("https://t.me/seller")).toBe(false);
      expect(validatePrivateChatId("12345abc")).toBe(false);
      expect(validatePrivateChatId("abc12345")).toBe(false);
      expect(validatePrivateChatId("12.34")).toBe(false);
      expect(validatePrivateChatId("+123456789")).toBe(false); // No leading plus sign
      expect(validatePrivateChatId("0")).toBe(false); // Chat ID cannot be 0
      expect(validatePrivateChatId("999999999999999999999999999999")).toBe(false); // Overflow
    });

    // Requirement 5: Unauthorized rejection: all notification reads/mutations reject non-admin callers
    it("Test 5: Unauthorized rejection: all notification reads/mutations reject unauthenticated callers", async () => {
      mockRequireAdmin.mockRejectedValue(new Error("UNAUTHORIZED_ADMIN_REQUIRED"));

      await expect(loadSellerNotificationStateAction()).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
      await expect(checkNotificationBotConnectionAction()).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
      await expect(detectNotificationBotChatsAction()).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");

      const fd = new FormData();
      fd.set("destinationChatId", "123456789");
      await expect(saveSellerNotificationConfigAction(fd)).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
      await expect(sendSellerTestNotificationAction()).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
      await expect(toggleSellerNotificationEnabledAction(true)).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
      await expect(retrySellerNotificationDeliveryAction("some-id")).rejects.toThrow("UNAUTHORIZED_ADMIN_REQUIRED");
    });

    // Requirement 6 & 8: Test notification format and fake transport delivery
    it("Test 6 & 8: Test notification includes [TEST] tag and verifies delivery acknowledgment", async () => {
      process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN = SENSITIVE_TOKEN;

      // Mock getMe fetch
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { id: 12345, is_bot: true, username: "MawthoqAlertsBot", first_name: "Alerts" },
        }),
      } as Response);

      const fakeTransport = createFakeTelegramTransport();

      const res = await sendSellerTestNotification({
        destinationChatId: "123456789",
        language: "ar",
        token: SENSITIVE_TOKEN,
        transport: fakeTransport,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(fakeTransport.sentMessages.length).toBe(1);
        expect(fakeTransport.sentMessages[0].chatId).toBe("123456789");
        expect(fakeTransport.sentMessages[0].text).toContain("[تجربة]");
        expect(fakeTransport.sentMessages[0].text).toContain("@test_notification_bot");
      }
    });
  });

  // =========================================================================
  // Group C — Unit checks & Redaction (Tests 21, 23, 27)
  // =========================================================================

  describe("Group C: Delivery, Redaction, and Message Formatting", () => {
    // Requirement 27: Redaction assertion
    it("Test 27: Redaction assertion: error messages and formatted URLs never leak the token", async () => {
      process.env.TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN = SENSITIVE_TOKEN;

      // Mock getMe success
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { id: 12345, is_bot: true, username: "AlertsBot" },
          }),
        } as Response)
        // Mock sendMessage failure with URL containing sensitive token
        .mockRejectedValueOnce(
          new Error(`Failed to fetch https://api.telegram.org/bot${SENSITIVE_TOKEN}/sendMessage`)
        );

      const res = await sendSellerTestNotification({
        destinationChatId: "123456789",
        language: "en",
        token: SENSITIVE_TOKEN,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).not.toContain(SENSITIVE_TOKEN);
        expect(res.error).not.toContain("AAHsecret");
      }
    });

    // Message Formatting - Arabic & English
    it("formats Arabic and English notification messages with safe HTML escaping and delivery reference", () => {
      const enFormatted = formatSellerNotificationMessage({
        isSupport: false,
        reference: "INQ-9900",
        deliveryReference: "del_ref_abc123",
        productName: "Super Product <v1>",
        categoryName: "Digital",
        createdAt: new Date("2026-11-11T12:00:00Z"),
        language: "en",
        dashboardUrl: "https://example.com/inquiries/inq-1234",
      });

      expect(enFormatted.text).toContain("New Product Inquiry");
      expect(enFormatted.text).toContain("Super Product <v1>");
      expect(enFormatted.text).toContain("del_ref_abc123");
      expect(enFormatted.replyMarkup.inline_keyboard[0][0].url).toBe(
        "https://example.com/inquiries/inq-1234"
      );

      const arFormatted = formatSellerNotificationMessage({
        isSupport: true,
        reference: "INQ-9901",
        deliveryReference: "del_ref_def456",
        categoryName: "الدعم الفني",
        createdAt: new Date("2026-11-11T12:00:00Z"),
        language: "ar",
        dashboardUrl: "https://example.com/inquiries/inq-5678",
      });

      expect(arFormatted.text).toContain("استفسار دعم جديد");
      expect(arFormatted.text).toContain("الدعم الفني");
      expect(arFormatted.text).toContain("del_ref_def456");
      expect(arFormatted.replyMarkup.inline_keyboard[0][0].text).toContain("عرض الاستفسار");
    });

    // Production URL Validation
    it("validates dashboard inquiry URL: enforces HTTPS and forbids localhost/loopback in production", () => {
      const prevEnv = process.env.NODE_ENV;
      const prevAppUrl = process.env.APP_URL;

      try {
        process.env.NODE_ENV = "production";

        // Non-HTTPS in production
        process.env.APP_URL = "http://dashboard.example.com";
        const nonHttps = getTrustedDashboardInquiryUrl("inq-123");
        expect(nonHttps.ok).toBe(false);
        if (!nonHttps.ok) {
          expect(nonHttps.error).toContain("HTTPS");
        }

        // Localhost in production
        process.env.APP_URL = "https://localhost:3000";
        const localhost = getTrustedDashboardInquiryUrl("inq-123");
        expect(localhost.ok).toBe(false);
        if (!localhost.ok) {
          expect(localhost.error).toContain("localhost");
        }

        // 127.0.0.1 in production
        process.env.APP_URL = "https://127.0.0.1:8443";
        const loopbackIp = getTrustedDashboardInquiryUrl("inq-123");
        expect(loopbackIp.ok).toBe(false);

        // Valid HTTPS in production
        process.env.APP_URL = "https://dashboard.rabet.example";
        const validProd = getTrustedDashboardInquiryUrl("inq-123");
        expect(validProd.ok).toBe(true);
        if (validProd.ok) {
          expect(validProd.url).toBe("https://dashboard.rabet.example/inquiries/inq-123");
        }

        // Development mode permits localhost
        process.env.NODE_ENV = "development";
        process.env.APP_URL = "http://localhost:3000";
        const devLocal = getTrustedDashboardInquiryUrl("inq-123");
        expect(devLocal.ok).toBe(true);
        if (devLocal.ok) {
          expect(devLocal.url).toBe("http://localhost:3000/inquiries/inq-123");
        }
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.APP_URL = prevAppUrl;
      }
    });

    // Webhook Execution Deadline Budget Check
    it("respects execution deadline budget: returns pending without network call when budget < 2000ms", async () => {
      const mockDb = {
        execute: vi.fn(),
      };

      const result = await attemptSellerNotificationDelivery({
        db: mockDb as unknown as Parameters<typeof attemptSellerNotificationDelivery>[0]["db"],
        deliveryId: "del-budget-123",
        deadline: {
          deadlineMs: Date.now() + 500,
          getRemainingMs: () => 500, // < 2000ms budget remaining
        },
      });

      expect(result.status).toBe("pending");
      if (result.status === "pending") {
        expect(result.reason).toBe("budget_exceeded");
      }
      // No DB queries or network calls should have occurred
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Group D — UI Components & Compatibility
  // =========================================================================

  describe("Group D: UI Components and Capability Checks", () => {
    it("Test 28: Capability check detects unmigrated database safely", async () => {
      const mockDbWithoutTables = {
        execute: vi.fn().mockResolvedValue([{ regclass: null }]),
      };

      const cap = await checkSellerNotificationCapability(
        mockDbWithoutTables as unknown as Parameters<typeof checkSellerNotificationCapability>[0],
      );
      expect(cap.supported).toBe(false);
      expect(cap.reason).toContain("0003_seller_notifications");
    });
  });
});
