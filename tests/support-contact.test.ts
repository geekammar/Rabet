import { describe, expect, it } from "vitest";

import { managedCommerceCopy } from "@/lib/telegram/managed-commerce-copy";
import {
  isTelegramSupportUsername,
  parseTelegramSupportUsername,
  telegramSupportChatUrl,
} from "@/lib/telegram/support-contact";

describe("Telegram support contact input", () => {
  it("normalizes an @username and a plain https t.me link", () => {
    expect(parseTelegramSupportUsername("@Store_Support")).toEqual({
      ok: true,
      username: "Store_Support",
    });
    expect(parseTelegramSupportUsername("  @Store_Support  ")).toEqual({
      ok: true,
      username: "Store_Support",
    });
    expect(
      parseTelegramSupportUsername("https://t.me/Store_Support"),
    ).toEqual({ ok: true, username: "Store_Support" });
    expect(
      parseTelegramSupportUsername("https://t.me/Store_Support/"),
    ).toEqual({ ok: true, username: "Store_Support" });
  });

  it("treats an empty value as an explicit clear", () => {
    expect(parseTelegramSupportUsername("")).toEqual({
      ok: true,
      username: null,
    });
    expect(parseTelegramSupportUsername("   ")).toEqual({
      ok: true,
      username: null,
    });
  });

  it("rejects bare, malformed and non-Telegram values", () => {
    for (const value of [
      "Store_Support",
      "@ab",
      "@1invalid",
      "@bad-name",
      "@bad name",
      "http://t.me/Store_Support",
      "https://t.me/Store_Support/extra",
      "https://t.me/Store_Support?start=1",
      "https://example.com/Store_Support",
      "https://telegram.me/Store_Support",
      null,
      undefined,
      42,
    ]) {
      expect(parseTelegramSupportUsername(value)).toEqual({
        ok: false,
        error: "INVALID_USERNAME",
      });
    }
  });

  it("only accepts stored values that are already normalized", () => {
    expect(isTelegramSupportUsername("Store_Support")).toBe(true);
    expect(isTelegramSupportUsername("@Store_Support")).toBe(false);
    expect(isTelegramSupportUsername("https://t.me/Store_Support")).toBe(false);
    expect(isTelegramSupportUsername(null)).toBe(false);
  });
});

describe("Telegram support chat destination and draft", () => {
  it("builds an encoded direct-chat link for the Arabic and English drafts", () => {
    const arabic = managedCommerceCopy("ar").telegramSupportDraft("منتج أ");
    const english = managedCommerceCopy("en").telegramSupportDraft("Bot A One");

    expect(arabic).toBe("مرحبًا، عندي سؤال عن منتج أ: ");
    expect(english).toBe("Hi, I have a question about Bot A One: ");

    const arabicUrl = new URL(telegramSupportChatUrl("Store_Support", arabic));
    expect(arabicUrl.origin).toBe("https://t.me");
    expect(arabicUrl.pathname).toBe("/Store_Support");
    expect(arabicUrl.searchParams.get("text")).toBe(arabic);

    const englishUrl = new URL(
      telegramSupportChatUrl("Store_Support", english),
    );
    expect(englishUrl.origin).toBe("https://t.me");
    expect(englishUrl.pathname).toBe("/Store_Support");
    expect(englishUrl.searchParams.get("text")).toBe(english);
    expect(englishUrl.href).toContain("Hi%2C%20I%20have%20a%20question");
  });

  it("uses the exact localized button copy", () => {
    expect(managedCommerceCopy("en").askSellerOnTelegram).toBe(
      "Ask the seller on Telegram",
    );
    expect(managedCommerceCopy("ar").askSellerOnTelegram).toBe(
      "اسأل البائع على Telegram",
    );
  });
});
