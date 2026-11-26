import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TelegramBotApiClient,
  TelegramBotUpdate,
} from "@/lib/telegram/manager-api";
import {
  buildMerchantNotificationTestMessage,
  findMerchantNotificationPairingMatch,
  hashMerchantNotificationPairingCode,
  merchantNotificationPairingCandidatesFromUpdates,
  merchantNotificationPairingPayloadFromText,
  normalizeMerchantNotificationBotToken,
  readMerchantNotificationBotIdentity,
  readMerchantNotificationBotPairingPage,
  sendMerchantNotificationBotTest,
} from "@/lib/telegram/merchant-notification-bot";
import { MERCHANT_NOTIFICATION_BOT_COPY } from "@/components/merchant/merchant-notification-bot-copy";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";

const TOKEN = "123456789:AAHnotification_bot_token_abcdefghijklmnop";

function botApi(
  updates: TelegramBotUpdate[] = [],
  overrides: Partial<TelegramBotApiClient> = {},
): TelegramBotApiClient {
  return {
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: {
        id: 1001,
        is_bot: true,
        first_name: "Alerts",
        username: "StoreAlertsBot",
      },
    })),
    getManagedBotToken: vi.fn(async () => ({
      ok: false as const,
      error: "not used",
    })),
    setWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getWebhookInfo: vi.fn(async () => ({
      ok: true as const,
      result: { url: "" },
    })),
    deleteWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getUpdates: vi.fn(async () => ({ ok: true as const, result: updates })),
    ...overrides,
  } as TelegramBotApiClient;
}

function pagedBotApi(allUpdates: TelegramBotUpdate[]) {
  const offsets: Array<number | undefined> = [];
  const api = botApi([], {
    getUpdates: vi.fn(
      async (input?: { offset?: number; limit?: number }) => {
        offsets.push(input?.offset);

        const offset = input?.offset ?? 0;
        const limit = input?.limit ?? 100;

        return {
          ok: true as const,
          result: allUpdates
            .filter((update) => update.update_id >= offset)
            .slice(0, limit),
        };
      },
    ),
  });

  return { api, offsets };
}

function textUpdate(
  updateId: number,
  text = "old message",
): TelegramBotUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: {
        id: 5550001,
        is_bot: false,
        first_name: "Owner",
        username: "owner",
      },
      chat: {
        id: 5550001,
        type: "private",
        username: "owner",
        first_name: "Owner",
      },
      date: 1,
      text,
    },
  };
}

function startUpdate(
  text: string,
  chatId = 5550001,
  type = "private",
  fromIsBot = false,
  updateId = 1,
): TelegramBotUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: {
        id: chatId,
        is_bot: fromIsBot,
        first_name: "Owner",
        username: "owner",
      },
      chat: {
        id: chatId,
        type,
        username: "owner",
        first_name: "Owner",
      },
      date: 1,
      text,
    },
  };
}

describe("merchant notification bot — onboarding copy", () => {
  it("offers managed creation in Arabic and English and keeps the manual fallback", () => {
    for (const locale of ["ar", "en"] as const) {
      const copy = MERCHANT_NOTIFICATION_BOT_COPY[locale];
      expect(copy.managedTitle.length).toBeGreaterThan(0);
      expect(copy.managedCreate.length).toBeGreaterThan(0);
      expect(copy.managedCheck.length).toBeGreaterThan(0);
      expect(copy.advancedTitle.length).toBeGreaterThan(0);
      expect(copy.errors.BOT_START_PENDING.length).toBeGreaterThan(0);
      expect(copy.errors.EXPIRED.length).toBeGreaterThan(0);
    }

    expect(MERCHANT_NOTIFICATION_BOT_COPY.ar.managedCreate).toContain("بوت");
    expect(MERCHANT_NOTIFICATION_BOT_COPY.en.managedCreate.toLowerCase()).toContain(
      "notification bot",
    );
    expect(MERCHANT_NOTIFICATION_BOT_COPY.en.advancedTitle.toLowerCase()).toContain(
      "token",
    );
  });
});

describe("merchant notification bot — token and pairing helpers", () => {
  it("accepts only a Telegram-shaped bot token", () => {
    expect(normalizeMerchantNotificationBotToken(TOKEN)).toBe(TOKEN);
    expect(normalizeMerchantNotificationBotToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(normalizeMerchantNotificationBotToken("")).toBeNull();
    expect(normalizeMerchantNotificationBotToken("not-a-token")).toBeNull();
    expect(normalizeMerchantNotificationBotToken("123:short")).toBeNull();
    expect(normalizeMerchantNotificationBotToken(null)).toBeNull();
  });

  it("extracts a pairing payload from a /start deep link or a bare code", () => {
    const code = "pairing_code_1234567890";

    expect(merchantNotificationPairingPayloadFromText(`/start ${code}`)).toBe(code);
    expect(
      merchantNotificationPairingPayloadFromText(`/start@StoreAlertsBot ${code}`),
    ).toBe(code);
    expect(merchantNotificationPairingPayloadFromText(code)).toBe(code);
    expect(merchantNotificationPairingPayloadFromText("/start")).toBeNull();
    expect(
      merchantNotificationPairingPayloadFromText("hello there"),
    ).toBeNull();
    expect(merchantNotificationPairingPayloadFromText(undefined)).toBeNull();
    expect(
      merchantNotificationPairingPayloadFromText(`/start ${"x".repeat(300)}`),
    ).toBeNull();
  });

  it("finds exactly one private chat and reports ambiguity", () => {
    const code = "pairing_code_1234567890";
    const hash = hashMerchantNotificationPairingCode(code);

    expect(findMerchantNotificationPairingMatch([], hash)).toEqual({
      status: "pending",
    });

    expect(
      findMerchantNotificationPairingMatch(
        [startUpdate(`/start ${code}`)],
        hashMerchantNotificationPairingCode("other-code"),
      ),
    ).toEqual({ status: "pending" });

    expect(
      findMerchantNotificationPairingMatch(
        [startUpdate(`/start ${code}`)],
        hash,
      ),
    ).toEqual({
      status: "paired",
      chat: {
        chatId: "5550001",
        title: "Owner",
        username: "owner",
      },
    });

    expect(
      findMerchantNotificationPairingMatch(
        [
          startUpdate(`/start ${code}`, 5550001),
          startUpdate(`/start ${code}`, 5550002),
        ],
        hash,
      ),
    ).toEqual({ status: "ambiguous" });
  });

  it("ignores group chats, bots and malformed chat ids", () => {
    const code = "pairing_code_1234567890";
    const hash = hashMerchantNotificationPairingCode(code);

    expect(
      findMerchantNotificationPairingMatch(
        [startUpdate(`/start ${code}`, 5550001, "group")],
        hash,
      ),
    ).toEqual({ status: "pending" });

    expect(
      findMerchantNotificationPairingMatch(
        [startUpdate(`/start ${code}`, 5550001, "private", true)],
        hash,
      ),
    ).toEqual({ status: "pending" });

    expect(
      findMerchantNotificationPairingMatch(
        [startUpdate(`/start ${code}`, -100123456)],
        hash,
      ),
    ).toEqual({ status: "pending" });
  });

  it("extracts one candidate per distinct private chat", () => {
    const code = "pairing_code_candidates_1234";
    const hash = hashMerchantNotificationPairingCode(code);
    const candidates = merchantNotificationPairingCandidatesFromUpdates(
      [
        startUpdate(`/start ${code}`, 5550001, "private", false, 1),
        startUpdate(`/start ${code}`, 5550001, "private", false, 2),
        startUpdate(`/start ${code}`, 5550002, "private", false, 3),
        startUpdate(`/start ${code}`, 5550003, "group", false, 4),
        startUpdate(`/start ${code}`, 5550004, "private", true, 5),
      ],
      hash,
    );

    expect(candidates.map((candidate) => candidate.chatId).sort()).toEqual([
      "5550001",
      "5550002",
    ]);
  });

  it("reports a full page containing a candidate as not complete", async () => {
    const code = "pairing_code_full_page_1234";
    const hash = hashMerchantNotificationPairingCode(code);
    const all = [
      startUpdate(`/start ${code}`, 5550001, "private", false, 1),
      ...Array.from({ length: 99 }, (_, index) =>
        textUpdate(index + 2),
      ),
      startUpdate(`/start ${code}`, 5550001, "private", false, 101),
    ];

    const first = pagedBotApi(all);
    const page = await readMerchantNotificationBotPairingPage(
      TOKEN,
      hash,
      { api: first.api, limit: 100 },
    );

    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("Expected a page");

    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0].chatId).toBe("5550001");
    expect(page.isFullPage).toBe(true);
    expect(page.nextOffset).toBe(101);
    expect(first.offsets).toEqual([undefined]);
  });

  it("uses the supplied offset for the next page", async () => {
    const code = "pairing_code_next_page_1234";
    const hash = hashMerchantNotificationPairingCode(code);
    const all = [
      ...Array.from({ length: 100 }, (_, index) =>
        textUpdate(index + 1),
      ),
      startUpdate(`/start ${code}`, 5550001, "private", false, 101),
    ];

    const paged = pagedBotApi(all);
    const page = await readMerchantNotificationBotPairingPage(
      TOKEN,
      hash,
      { api: paged.api, offset: 101, limit: 100 },
    );

    expect(page.status).toBe("ok");
    if (page.status !== "ok") throw new Error("Expected a page");

    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0].chatId).toBe("5550001");
    expect(page.isFullPage).toBe(false);
    expect(page.nextOffset).toBe(102);
    expect(paged.offsets).toEqual([101]);
  });

  it("maps getMe and getUpdates failures to allowlisted codes", async () => {
    const invalid = await readMerchantNotificationBotIdentity(TOKEN, {
      api: botApi([], {
        getMe: vi.fn(async () => ({
          ok: false as const,
          error: "Unauthorized",
          httpStatus: 401,
        })),
      }),
    });
    expect(invalid).toEqual({ ok: false, code: "INVALID_TOKEN" });

    const unavailable = await readMerchantNotificationBotIdentity(TOKEN, {
      api: botApi([], {
        getMe: vi.fn(async () => ({
          ok: false as const,
          error: "Network error",
          errorKind: "network_error" as const,
        })),
      }),
    });
    expect(unavailable).toEqual({ ok: false, code: "TELEGRAM_UNAVAILABLE" });

    const notBot = await readMerchantNotificationBotIdentity(TOKEN, {
      api: botApi([], {
        getMe: vi.fn(async () => ({
          ok: true as const,
          result: {
            id: 1,
            is_bot: false,
            first_name: "Person",
            username: "person",
          },
        })),
      }),
    });
    expect(notBot).toEqual({ ok: false, code: "INVALID_TOKEN" });

    const webhook = await readMerchantNotificationBotPairingPage(
      TOKEN,
      "a".repeat(64),
      {
        api: botApi([], {
          getUpdates: vi.fn(async () => ({
            ok: false as const,
            error:
              "Conflict: can't use getUpdates method while webhook is active",
            httpStatus: 409,
          })),
        }),
      },
    );
    expect(webhook).toEqual({ status: "error", code: "WEBHOOK_ACTIVE" });

    const limited = await readMerchantNotificationBotPairingPage(
      TOKEN,
      "a".repeat(64),
      {
        api: botApi([], {
          getUpdates: vi.fn(async () => ({
            ok: false as const,
            error: "Too Many Requests",
            errorKind: "rate_limited" as const,
            retryAfterSeconds: 9,
          })),
        }),
      },
    );
    expect(limited).toEqual({
      status: "error",
      code: "RATE_LIMITED",
      retryAfterSeconds: 9,
    });
  });

  it("builds bilingual test text and maps send failures safely", async () => {
    expect(buildMerchantNotificationTestMessage("ar", "متجر تجريبي")).toContain(
      "متجر تجريبي",
    );
    expect(buildMerchantNotificationTestMessage("en", "Demo Store")).toContain(
      "Demo Store",
    );
    expect(buildMerchantNotificationTestMessage("en", "")).toContain(
      "Your store",
    );

    const transport = createFakeTelegramTransport();
    const sent = await sendMerchantNotificationBotTest({
      token: TOKEN,
      chatId: "5550001",
      locale: "en",
      storeName: "Demo Store",
      transport,
    });

    expect(sent.ok).toBe(true);
    expect(transport.sentMessages).toHaveLength(1);

    const blocked = createFakeTelegramTransport();
    blocked.failSendWith = "Forbidden: bot was blocked by the user";
    blocked.failSendKind = "blocked";
    blocked.failSendIsBlocked = true;

    expect(
      await sendMerchantNotificationBotTest({
        token: TOKEN,
        chatId: "5550001",
        locale: "en",
        storeName: "Demo Store",
        transport: blocked,
      }),
    ).toEqual({ ok: false, code: "BLOCKED" });

    const missing = createFakeTelegramTransport();
    missing.failSendWith = "Bad Request: chat not found";
    missing.failSendKind = "api_error";
    missing.failSendHttpStatus = 400;

    expect(
      await sendMerchantNotificationBotTest({
        token: TOKEN,
        chatId: "5550001",
        locale: "en",
        storeName: "Demo Store",
        transport: missing,
      }),
    ).toEqual({ ok: false, code: "CHAT_NOT_FOUND" });

    const unauthorized = createFakeTelegramTransport();
    unauthorized.failSendWith = "Unauthorized";
    unauthorized.failSendKind = "api_error";
    unauthorized.failSendHttpStatus = 401;

    expect(
      await sendMerchantNotificationBotTest({
        token: TOKEN,
        chatId: "5550001",
        locale: "en",
        storeName: "Demo Store",
        transport: unauthorized,
      }),
    ).toEqual({ ok: false, code: "INVALID_TOKEN" });
  });
});

const mockIsMerchantAppEnabled = vi.fn(() => true);
const mockGetMerchantAccess = vi.fn();
const mockService = {
  connect: vi.fn(),
  startPairing: vi.fn(),
  checkPairing: vi.fn(),
  sendTest: vi.fn(),
  disconnect: vi.fn(),
};
const mockRevalidatePath = vi.fn();
const mockRefresh = vi.fn();

vi.mock("@/lib/auth/merchant-gate", () => ({
  isMerchantAppEnabled: () => mockIsMerchantAppEnabled(),
}));
vi.mock("@/lib/auth/merchant-session", () => ({
  getMerchantAccess: () => mockGetMerchantAccess(),
}));
vi.mock("@/db/transaction-client", () => ({
  getTransactionDb: () => ({ transaction: vi.fn() }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
  refresh: () => mockRefresh(),
}));
vi.mock("@/lib/merchant/notification-bot", () => ({
  connectMerchantNotificationBot: (...args: unknown[]) => mockService.connect(...args),
  startMerchantNotificationBotPairing: (...args: unknown[]) =>
    mockService.startPairing(...args),
  checkMerchantNotificationBotPairing: (...args: unknown[]) =>
    mockService.checkPairing(...args),
  sendMerchantNotificationBotTest: (...args: unknown[]) =>
    mockService.sendTest(...args),
  disconnectMerchantNotificationBot: (...args: unknown[]) =>
    mockService.disconnect(...args),
}));

import {
  checkMerchantNotificationBotPairingAction,
  connectMerchantNotificationBotAction,
  disconnectMerchantNotificationBotAction,
  sendMerchantNotificationBotTestAction,
  startMerchantNotificationBotPairingAction,
} from "@/app/actions/merchant-notification-bot";

function access(overrides: Record<string, unknown> = {}) {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    sessionVersion: 0,
    role: "owner",
    email: "owner@example.test",
    store: {
      id: "00000000-0000-4000-8000-000000000010",
      name: "Demo Store",
      slug: "demo-store",
      status: "active",
    },
    scope: { storeId: "00000000-0000-4000-8000-000000000010" },
    readOnly: false,
    ...overrides,
  };
}

describe("merchant notification bot — Server Action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMerchantAppEnabled.mockReturnValue(true);
    mockGetMerchantAccess.mockResolvedValue(access());
    mockService.connect.mockResolvedValue({
      ok: true,
      pairing: { deepLink: "https://t.me/StoreAlertsBot?start=abc", expiresAt: "x" },
    });
    mockService.startPairing.mockResolvedValue({
      ok: true,
      pairing: { deepLink: "https://t.me/StoreAlertsBot?start=def", expiresAt: "x" },
    });
    mockService.checkPairing.mockResolvedValue({ ok: true });
    mockService.sendTest.mockResolvedValue({ ok: true, messageId: 42 });
    mockService.disconnect.mockResolvedValue({ ok: true });
  });

  it("fails closed when the merchant app is disabled", async () => {
    mockIsMerchantAppEnabled.mockReturnValue(false);

    expect(await connectMerchantNotificationBotAction({ token: TOKEN })).toEqual({
      ok: false,
      error: "UNAVAILABLE",
    });
    expect(await checkMerchantNotificationBotPairingAction()).toEqual({
      ok: false,
      error: "UNAVAILABLE",
    });
    expect(mockService.connect).not.toHaveBeenCalled();
  });

  it("denies missing sessions and read-only stores before any service call", async () => {
    mockGetMerchantAccess.mockResolvedValueOnce(null);

    expect(await connectMerchantNotificationBotAction({ token: TOKEN })).toEqual({
      ok: false,
      error: "DENIED",
    });

    mockGetMerchantAccess.mockResolvedValue(access({ readOnly: true }));

    expect(await connectMerchantNotificationBotAction({ token: TOKEN })).toEqual({
      ok: false,
      error: "DENIED",
    });
    expect(await startMerchantNotificationBotPairingAction()).toEqual({
      ok: false,
      error: "DENIED",
    });
    expect(await checkMerchantNotificationBotPairingAction()).toEqual({
      ok: false,
      error: "DENIED",
    });
    expect(await sendMerchantNotificationBotTestAction({ locale: "en" })).toEqual({
      ok: false,
      error: "DENIED",
    });
    expect(await disconnectMerchantNotificationBotAction()).toEqual({
      ok: false,
      error: "DENIED",
    });

    expect(mockService.connect).not.toHaveBeenCalled();
    expect(mockService.startPairing).not.toHaveBeenCalled();
    expect(mockService.checkPairing).not.toHaveBeenCalled();
    expect(mockService.sendTest).not.toHaveBeenCalled();
    expect(mockService.disconnect).not.toHaveBeenCalled();
  });

  it("uses only the verified session store and never a submitted store id", async () => {
    const result = await connectMerchantNotificationBotAction({
      token: TOKEN,
      storeId: "00000000-0000-4000-8000-000000000099",
    });

    expect(result.ok).toBe(true);
    expect(mockService.connect).toHaveBeenCalledTimes(1);

    const [dbArg, accessArg, inputArg] = mockService.connect.mock.calls[0] as [
      unknown,
      { scope: { storeId: string } },
      { token: string },
    ];

    expect(dbArg).toBeDefined();
    expect(accessArg.scope.storeId).toBe(
      "00000000-0000-4000-8000-000000000010",
    );
    expect(inputArg).toEqual({ token: TOKEN });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/app/setup");
  });

  it("sends only the locale to the test service and reports the message id", async () => {
    const result = await sendMerchantNotificationBotTestAction({
      locale: "en",
      storeId: "00000000-0000-4000-8000-000000000099",
      chatId: "999",
    });

    expect(result).toEqual({ ok: true, messageId: 42 });
    expect(mockService.sendTest).toHaveBeenCalledTimes(1);

    const [, , inputArg] = mockService.sendTest.mock.calls[0] as [
      unknown,
      unknown,
      { locale: string },
    ];

    expect(inputArg).toEqual({ locale: "en" });
  });

  it("returns service errors unchanged and does not refresh on failure", async () => {
    mockService.connect.mockResolvedValue({
      ok: false,
      error: "BOT_ALREADY_CONNECTED",
    });

    expect(await connectMerchantNotificationBotAction({ token: TOKEN })).toEqual({
      ok: false,
      error: "BOT_ALREADY_CONNECTED",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
