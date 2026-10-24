import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeTelegramTransport,
  createFetchTelegramTransport,
  sanitizeTelegramError,
} from "@/lib/telegram/transport";

describe("telegram transport and error sanitization", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("redacts bot token and API URLs from error messages", () => {
    const rawToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ";
    const errorWithToken = new Error(
      `Failed to fetch https://api.telegram.org/bot${rawToken}/sendMessage: 500 Internal Server Error`,
    );

    const sanitized = sanitizeTelegramError(errorWithToken, rawToken);

    expect(sanitized).not.toContain(rawToken);
    expect(sanitized).toContain("[REDACTED_BOT_TOKEN]");
  });

  it("redacts database connection strings and bearer tokens", () => {
    const errorWithDb = new Error(
      "Query failed: postgresql://admin:super_secret_pw@ep-example.neon.tech/main?sslmode=require Bearer secret-12345",
    );
    const sanitized = sanitizeTelegramError(errorWithDb);

    expect(sanitized).not.toContain("super_secret_pw");
    expect(sanitized).toContain("[REDACTED_DB_URL]");
    expect(sanitized).toContain("Bearer [REDACTED]");
  });

  it("handles string errors and strips bot url patterns even without token provided", () => {
    const rawError =
      "Request to https://api.telegram.org/bot987654321:XYZ_secret_key/answerCallbackQuery failed";
    const sanitized = sanitizeTelegramError(rawError);

    expect(sanitized).not.toContain("987654321:XYZ_secret_key");
    expect(sanitized).toContain("[REDACTED_BOT_TOKEN]");
  });

  it("captures calls and simulates errors in fake transport", async () => {
    const fake = createFakeTelegramTransport();

    const sendRes = await fake.sendMessage({
      chatId: 12345,
      text: "Hello",
      replyMarkup: { inline_keyboard: [[{ text: "Tap", callback_data: "home" }]] },
    });

    expect(sendRes.ok).toBe(true);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0].text).toBe("Hello");

    const editRes = await fake.editMessageText({
      chatId: 12345,
      messageId: 1001,
      text: "Updated",
    });
    expect(editRes.ok).toBe(true);
    expect(fake.editedMessages).toHaveLength(1);
    expect(fake.editedMessages[0].text).toBe("Updated");

    const answerRes = await fake.answerCallbackQuery({
      callbackQueryId: "cb_1",
      text: "Alert",
      showAlert: true,
    });
    expect(answerRes.ok).toBe(true);
    expect(fake.answeredCallbacks).toHaveLength(1);

    // Simulated failure
    fake.failSendWith = "Network Timeout";
    fake.failSendKind = "timeout";
    const failedSend = await fake.sendMessage({ chatId: 12345, text: "Fail" });
    expect(failedSend.ok).toBe(false);
    expect(failedSend.error).toBe("Network Timeout");
    expect(failedSend.errorKind).toBe("timeout");

    fake.clear();
    expect(fake.sentMessages).toHaveLength(0);
    expect(fake.failSendWith).toBeUndefined();
  });

  it("enforces Telegram payload limits in fake transport", async () => {
    const fake = createFakeTelegramTransport();

    // Text exceeds 4096 characters
    const overlongText = "A".repeat(4097);
    const textRes = await fake.sendMessage({ chatId: 123, text: overlongText });
    expect(textRes.ok).toBe(false);
    expect(textRes.error).toContain("exceeds Telegram limit of 4096 characters");

    // Callback data exceeds 64 UTF-8 bytes
    const overlongCallback = "B".repeat(65);
    const cbRes = await fake.sendMessage({
      chatId: 123,
      text: "Valid text",
      replyMarkup: {
        inline_keyboard: [[{ text: "Btn", callback_data: overlongCallback }]],
      },
    });
    expect(cbRes.ok).toBe(false);
    expect(cbRes.error).toContain("exceeds Telegram limit of 64 bytes");
  });

  describe("createFetchTelegramTransport", () => {
    const token = "dummy-token";

    it("classifies HTTP 429 rate limiting with retry_after parameter", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 8",
            parameters: { retry_after: 8 },
          }),
      } as unknown as Response);

      const transport = createFetchTelegramTransport(token);
      const res = await transport.sendMessage({ chatId: 123, text: "Hello" });

      expect(res.ok).toBe(false);
      expect(res.errorKind).toBe("rate_limited");
      expect(res.retryAfterSeconds).toBe(8);
    });

    it("treats 400 'message is not modified' as a successful no-op on editMessageText", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            ok: false,
            error_code: 400,
            description:
              "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
          }),
      } as unknown as Response);

      const transport = createFetchTelegramTransport(token);
      const res = await transport.editMessageText({
        chatId: 123,
        messageId: 456,
        text: "Same content",
      });

      expect(res.ok).toBe(true);
      expect(res.messageId).toBe(456);
    });

    it("classifies 400 'message can't be edited' as not_editable", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: message can't be edited",
          }),
      } as unknown as Response);

      const transport = createFetchTelegramTransport(token);
      const res = await transport.editMessageText({
        chatId: 123,
        messageId: 456,
        text: "Edited",
      });

      expect(res.ok).toBe(false);
      expect(res.errorKind).toBe("not_editable");
    });

    it("handles non-JSON error response bodies (e.g. 502 Bad Gateway HTML)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "<html><body>502 Bad Gateway</body></html>",
      } as unknown as Response);

      const transport = createFetchTelegramTransport(token);
      const res = await transport.sendMessage({ chatId: 123, text: "Ping" });

      expect(res.ok).toBe(false);
      expect(res.errorKind).toBe("api_error");
      expect(res.error).toContain("502");
    });

    it("classifies TimeoutError / AbortError as timeout", async () => {
      const timeoutError = new Error("The operation was aborted due to timeout");
      timeoutError.name = "TimeoutError";
      globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

      const transport = createFetchTelegramTransport(token);
      const res = await transport.sendMessage({ chatId: 123, text: "Ping" });

      expect(res.ok).toBe(false);
      expect(res.errorKind).toBe("timeout");
    });
  });
});
