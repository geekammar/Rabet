import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const React = await import("react");

  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children?: React.ReactNode;
    }) => React.createElement("a", { href, ...props }, children),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/merchant-settings", () => ({
  saveMerchantStoreLanguageAction: vi.fn(),
  saveMerchantTelegramSupportAction: vi.fn(),
  saveMerchantVodafoneCashAction: vi.fn(),
}));

vi.mock("@/app/actions/merchant-telegram", () => ({
  confirmMerchantTelegramConnection: vi.fn(),
  startMerchantTelegramConnection: vi.fn(),
  publishMerchantTelegramStore: vi.fn(),
  recoverMerchantTelegramConnection: vi.fn(),
  verifyMerchantTelegramBotStart: vi.fn(),
}));

vi.mock("@/app/actions/merchant-notification-bot", () => ({
  checkMerchantNotificationBotManagedAction: vi.fn(),
  checkMerchantNotificationBotPairingAction: vi.fn(),
  connectMerchantNotificationBotAction: vi.fn(),
  disconnectMerchantNotificationBotAction: vi.fn(),
  sendMerchantNotificationBotTestAction: vi.fn(),
  startMerchantNotificationBotPairingAction: vi.fn(),
}));

vi.mock("@/components/merchant/merchant-logout-button", () => ({
  MerchantLogoutButton: () => null,
}));

const { MerchantSetup } = await import(
  "@/components/merchant/merchant-setup"
);

const expiresAt = "2026-11-27T19:00:00.000Z";

describe("setup purpose isolation", () => {
  it("renders the storefront and notification sections from their own purposes", () => {
    const html = renderToStaticMarkup(
      createElement(MerchantSetup, {
        storeName: "COD PR56 Store B",
        email: "merchant@example.test",
        status: "active",
        readOnly: false,
        initialLocale: "en",
        telegramConnection: {
          state: "preparing",
          attemptId: "store-attempt",
          botUsername: "StoreBotPurpose",
          botName: "Store Bot Purpose",
          expiresAt,
          verificationUrl:
            "https://t.me/StoreBotPurpose?start=store-challenge",
        },
        isAndroidTelegramLaunch: false,
        telegramLaunchOrigin: null,
        codOrdersEnabled: true,
        needsAttentionOrders: [],
        needsAttentionTotal: 0,
        needsAttentionTransfers: [],
        needsAttentionTransferTotal: 0,
        vodafoneCashSetting: null,
        storeDefaultLanguageCode: "en",
        telegramSupportUsername: null,
        notificationBot: {
          supported: true,
          state: null,
          managed: {
            state: "awaiting_start",
            attemptId: "notification-attempt",
            botUsername: "NotifyBotPurpose",
            botName: "Notify Bot Purpose",
            verificationUrl:
              "https://t.me/NotifyBotPurpose?start=notification-challenge",
            expiresAt,
          },
        },
      }),
    );

    const storefrontStart = html.indexOf(
      'data-testid="merchant-telegram-connection"',
    );
    const notificationStart = html.indexOf(
      'data-testid="merchant-notification-bot"',
    );

    expect(storefrontStart).toBeGreaterThanOrEqual(0);
    expect(notificationStart).toBeGreaterThan(storefrontStart);

    const storefront = html.slice(storefrontStart, notificationStart);
    const notification = html.slice(notificationStart);

    expect(storefront).toContain("StoreBotPurpose");
    expect(storefront).toContain(
      "https://t.me/StoreBotPurpose?start=store-challenge",
    );
    expect(storefront).not.toContain("NotifyBotPurpose");
    expect(storefront).not.toContain("notification-challenge");

    expect(notification).toContain("NotifyBotPurpose");
    expect(notification).toContain(
      "https://t.me/NotifyBotPurpose?start=notification-challenge",
    );
    expect(notification).not.toContain("StoreBotPurpose");
    expect(notification).not.toContain("store-challenge");
  });

  it("posts Resume through its own route and keeps Create as a separate form", () => {
    function setupHtml(
      managed: Parameters<typeof MerchantSetup>[0]["notificationBot"]["managed"],
    ) {
      return renderToStaticMarkup(
        createElement(MerchantSetup, {
          storeName: "COD PR56 Store B",
          email: "merchant@example.test",
          status: "active",
          readOnly: false,
          initialLocale: "en",
          telegramConnection: { state: "not_connected" },
          isAndroidTelegramLaunch: false,
          telegramLaunchOrigin: null,
          codOrdersEnabled: true,
          needsAttentionOrders: [],
          needsAttentionTotal: 0,
          needsAttentionTransfers: [],
          needsAttentionTransferTotal: 0,
          vodafoneCashSetting: null,
          storeDefaultLanguageCode: "en",
          telegramSupportUsername: null,
          notificationBot: {
            supported: true,
            state: null,
            managed,
          },
        }),
      );
    }

    const resumable = setupHtml({
      state: "expired",
      attemptId: "expired-attempt",
      reason: "expired",
      retryable: true,
      resumable: true,
      botUsername: "NotifyBotPurpose",
      botName: "Notify Bot Purpose",
    });

    expect(resumable).toContain(
      'action="/app/setup/notification-bot/resume"',
    );
    expect(resumable).toContain('name="attemptId" value="expired-attempt"');
    expect(resumable).toContain(
      'data-testid="merchant-notification-bot-managed-resume"',
    );
    expect(resumable).not.toContain(
      'action="/app/setup/notification-bot/start"',
    );

    const fresh = setupHtml({ state: "idle" });

    expect(fresh).toContain('action="/app/setup/notification-bot/start"');
    expect(fresh).toContain(
      'data-testid="merchant-notification-bot-managed-create"',
    );
    expect(fresh).not.toContain(
      'action="/app/setup/notification-bot/resume"',
    );
  });
});
