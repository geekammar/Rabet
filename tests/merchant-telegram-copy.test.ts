import { describe, expect, it } from "vitest";

import { MERCHANT_TELEGRAM_COPY } from "@/components/merchant/merchant-telegram-copy";

describe("merchant Telegram connection copy", () => {
  it("keeps every connection state and retry action available in Arabic and English", () => {
    for (const locale of ["ar", "en"] as const) {
      const copy = MERCHANT_TELEGRAM_COPY[locale];

      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.connect.length).toBeGreaterThan(0);
      expect(copy.openTelegram.length).toBeGreaterThan(0);
      expect(copy.refresh.length).toBeGreaterThan(0);
      expect(copy.confirm.length).toBeGreaterThan(0);
      expect(copy.connectedTitle.length).toBeGreaterThan(0);
      expect(copy.retry.length).toBeGreaterThan(0);
      expect(copy.errors.RETRYABLE.length).toBeGreaterThan(0);
      expect(copy.errors.expired.length).toBeGreaterThan(0);
      expect(copy.errors.foreign_webhook.length).toBeGreaterThan(0);
      expect(copy.errors.webhook_registration_failed.length).toBeGreaterThan(0);
      expect(copy.errors.activation_lease_lost.length).toBeGreaterThan(0);
      expect(copy.errors.activation_conflict.length).toBeGreaterThan(0);
      expect(copy.errors.activation_superseded.length).toBeGreaterThan(0);
      expect(copy.errors.REVIEW.length).toBeGreaterThan(0);
      expect(copy.errors.webhook_outcome_unknown.length).toBeGreaterThan(0);
      expect(copy.launchFailedTitle.length).toBeGreaterThan(0);
      expect(copy.launchFailedBody.length).toBeGreaterThan(0);
    }
  });

  it("names the fresh and pending primary actions", () => {
    expect(MERCHANT_TELEGRAM_COPY.ar.connect).toBe("إنشاء بوت متجري");
    expect(MERCHANT_TELEGRAM_COPY.en.connect).toBe("Create my store bot");
    expect(MERCHANT_TELEGRAM_COPY.ar.openTelegram).toBe(
      "متابعة إنشاء البوت",
    );
    expect(MERCHANT_TELEGRAM_COPY.en.openTelegram).toBe(
      "Continue creating the bot",
    );
  });

  it("provides distinct Arabic and English text for the visible states", () => {
    expect(MERCHANT_TELEGRAM_COPY.ar.waitingTitle).not.toBe(
      MERCHANT_TELEGRAM_COPY.en.waitingTitle,
    );
    expect(MERCHANT_TELEGRAM_COPY.ar.confirmTitle).not.toBe(
      MERCHANT_TELEGRAM_COPY.en.confirmTitle,
    );
    expect(MERCHANT_TELEGRAM_COPY.ar.connectedTitle).not.toBe(
      MERCHANT_TELEGRAM_COPY.en.connectedTitle,
    );
  });
});
