import { describe, expect, it } from "vitest";

import {
  createFakeTelegramTransport,
  sanitizeTelegramError,
} from "@/lib/telegram/transport";

describe("telegram transport and error sanitization", () => {
  it("redacts bot token and API URLs from error messages", () => {
    const rawToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ";
    const errorWithToken = new Error(
      `Failed to fetch https://api.telegram.org/bot${rawToken}/sendMessage: 500 Internal Server Error`,
    );

    const sanitized = sanitizeTelegramError(errorWithToken, rawToken);

    expect(sanitized).not.toContain(rawToken);
    expect(sanitized).toContain("[REDACTED_BOT_TOKEN]");
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
    const failedSend = await fake.sendMessage({ chatId: 12345, text: "Fail" });
    expect(failedSend.ok).toBe(false);
    expect(failedSend.error).toBe("Network Timeout");

    fake.clear();
    expect(fake.sentMessages).toHaveLength(0);
    expect(fake.failSendWith).toBeUndefined();
  });
});
