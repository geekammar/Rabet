import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  merchantNotificationBot,
  store,
  storeMembership,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  confirmMerchantNotificationBotPairing,
  markMerchantNotificationBotPairingAmbiguous,
  mergeMerchantNotificationBotPairingCandidates,
  readMerchantNotificationBotSecret,
  readMerchantNotificationBotState,
  recordMerchantNotificationBotTestSuccess,
} from "@/lib/data/merchant-notification-bot";
import { checkMerchantNotificationBotPairing, connectMerchantNotificationBot, disconnectMerchantNotificationBot, sendMerchantNotificationBotTest, startMerchantNotificationBotPairing } from "@/lib/merchant/notification-bot";
import type { TelegramBotApiClient, TelegramBotUpdate } from "@/lib/telegram/manager-api";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const KEY = crypto.randomBytes(32);
const KEY_ID = "notification-bot-test-v1";
const TOKEN_A = "123456789:AAHnotification_bot_token_store_a_1234567890";
const TOKEN_B = "987654321:AAHnotification_bot_token_store_b_1234567890";

let testDb: TestDatabase | null = null;

type Fixture = {
  storeAId: string;
  storeBId: string;
  userAId: string;
  userBId: string;
};

let fixture: Fixture;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.TELEGRAM_CONNECTION_TOKEN_KEY = KEY.toString("base64");
  process.env.TELEGRAM_CONNECTION_TOKEN_KEY_ID = KEY_ID;

  testDb = await createTestDatabase("merchant_notification_bot");
  const db = testDb.db;

  const [storeA] = await db
    .insert(store)
    .values({ name: "Notification Store A", slug: "notification-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Notification Store B", slug: "notification-store-b", status: "active" })
    .returning();
  const [userA] = await db
    .insert(appUser)
    .values({ email: "notification.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "notification.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    userAId: userA.id,
    userBId: userB.id,
  };
});

afterAll(async () => {
  delete process.env.TELEGRAM_CONNECTION_TOKEN_KEY;
  delete process.env.TELEGRAM_CONNECTION_TOKEN_KEY_ID;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`
    truncate table "merchant_notification_bot" restart identity cascade
  `);
  await testDb.db
    .update(store)
    .set({ status: "active" })
    .where(eq(store.id, fixture.storeAId));
  await testDb.db
    .update(store)
    .set({ status: "active" })
    .where(eq(store.id, fixture.storeBId));
  await testDb.db
    .update(appUser)
    .set({ sessionVersion: 0 })
    .where(inArray(appUser.id, [fixture.userAId, fixture.userBId]));
  await testDb.db
    .update(storeMembership)
    .set({ status: "active" })
    .where(
      inArray(storeMembership.userId, [
        fixture.userAId,
        fixture.userBId,
      ]),
    );
});

function db() {
  return testDb!.db;
}

async function accessFor(userId: string) {
  const access = await resolveMerchantAccess(db(), {
    userId,
    sessionVersion: 0,
  });

  if (!access) throw new Error("Expected merchant access in fixture");

  return access;
}

function botApi(
  botId: number,
  username: string,
  updates: TelegramBotUpdate[] = [],
  overrides: Partial<TelegramBotApiClient> = {},
): TelegramBotApiClient {
  return {
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: {
        id: botId,
        is_bot: true,
        first_name: username,
        username,
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

function pagedBotApi(
  botId: number,
  username: string,
  allUpdates: TelegramBotUpdate[],
) {
  const offsets: Array<number | undefined> = [];
  const api = botApi(botId, username, [], {
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

function codeFromLink(link: string): string {
  const code = new URL(link).searchParams.get("start");

  if (!code) throw new Error("Expected a pairing code in the deep link");

  return code;
}

function startUpdate(
  code: string,
  chatId: number,
  options: {
    type?: string;
    text?: string;
    updateId?: number;
    username?: string;
  } = {},
): TelegramBotUpdate {
  return {
    update_id: options.updateId ?? 1,
    message: {
      message_id: 1,
      from: {
        id: chatId,
        is_bot: false,
        first_name: "Store Owner",
        username: options.username ?? "store_owner",
      },
      chat: {
        id: chatId,
        type: options.type ?? "private",
        username: options.username ?? "store_owner",
        first_name: "Store Owner",
      },
      date: Math.floor(Date.now() / 1000),
      text: options.text ?? `/start ${code}`,
    },
  };
}

async function connectStore(
  access: Awaited<ReturnType<typeof accessFor>>,
  botId: number,
  username: string,
  token = TOKEN_A,
) {
  return connectMerchantNotificationBot(
    db(),
    access,
    { token },
    { api: botApi(botId, username) },
  );
}

async function connectAndPair(
  access: Awaited<ReturnType<typeof accessFor>>,
  botId: number,
  username: string,
  chatId: number,
  token = TOKEN_A,
) {
  const connected = await connectStore(access, botId, username, token);

  if (!connected.ok || !connected.pairing) {
    throw new Error("Expected pairing link");
  }

  const code = codeFromLink(connected.pairing.deepLink);
  const paired = await checkMerchantNotificationBotPairing(
    db(),
    access,
    { api: botApi(botId, username, [startUpdate(code, chatId)]) },
  );

  if (!paired.ok) {
    throw new Error(`Expected pairing to succeed: ${paired.error}`);
  }

  return { code, token };
}

describe.skipIf(!shouldRun)("merchant notification bot", () => {
  it("connects with an encrypted token, pairs one private chat and sends a test", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    expect(connected.ok).toBe(true);
    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    expect(connected.pairing.deepLink).toContain(
      "https://t.me/StoreOneAlertsBot?start=",
    );
    expect(JSON.stringify(connected)).not.toContain(TOKEN_A);

    const stored = await db()
      .select()
      .from(merchantNotificationBot)
      .where(eq(merchantNotificationBot.storeId, fixture.storeAId));

    expect(stored).toHaveLength(1);
    expect(stored[0].tokenCiphertext).not.toBe(TOKEN_A);
    expect(stored[0].tokenCiphertext).not.toContain("AAHnotification");
    expect(stored[0].pairingCodeHash).toMatch(/^[0-9a-f]{64}$/);

    const state = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );

    expect(state?.configured).toBe(true);
    expect(state?.pairingActive).toBe(true);
    expect(state?.destinationChatId).toBeNull();
    expect(JSON.stringify(state)).not.toContain("token");
    expect(JSON.stringify(state)).not.toContain(TOKEN_A);

    const code = codeFromLink(connected.pairing.deepLink);
    const pairingApi = botApi(1001, "StoreOneAlertsBot", [
      startUpdate(code, 5550001),
    ]);
    const paired = await checkMerchantNotificationBotPairing(
      db(),
      access,
      { api: pairingApi },
    );

    expect(paired.ok).toBe(true);

    const pairedState = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(pairedState?.pairingActive).toBe(false);
    expect(pairedState?.destinationChatId).toBe("5550001");
    expect(pairedState?.destinationChatTitle).toBe("Store Owner");
    expect(pairedState?.verifiedAt).toBeNull();

    const transport = createFakeTelegramTransport();
    const testResult = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport },
    );

    expect(testResult.ok).toBe(true);
    if (!testResult.ok) throw new Error("Expected test send");

    expect(testResult.messageId).toBeTruthy();
    expect(transport.sentMessages).toHaveLength(1);
    expect(transport.sentMessages[0].chatId).toBe("5550001");
    expect(transport.sentMessages[0].text).toContain("Notification Store A");
    expect(transport.sentMessages[0].text).toContain("test message");

    const verified = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(verified?.verifiedAt).not.toBeNull();
    expect(verified?.lastTestAt).not.toBeNull();
  });

  it("does not pair on a missing, wrong or group-chat message", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);

    const pending = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", []),
    });
    expect(pending).toEqual({ ok: false, error: "PAIRING_PENDING" });

    const wrong = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", [
        startUpdate(code, 5550001, { text: "/start not-the-code" }),
      ]),
    });
    expect(wrong).toEqual({ ok: false, error: "PAIRING_PENDING" });

    const group = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", [
        startUpdate(code, 5550001, { type: "group" }),
      ]),
    });
    expect(group).toEqual({ ok: false, error: "PAIRING_PENDING" });

    const ambiguous = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", [
        startUpdate(code, 5550001),
        startUpdate(code, 5550002, { updateId: 2, username: "other_owner" }),
      ]),
    });
    expect(ambiguous).toEqual({ ok: false, error: "PAIRING_AMBIGUOUS" });

    const state = await readMerchantNotificationBotState(asAppDb(db()), fixture.storeAId);
    expect(state?.destinationChatId).toBeNull();
  });

  it("pairs a match found after a full unrelated page", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const backlog: TelegramBotUpdate[] = [
      ...Array.from({ length: 150 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 1,
          text: "old message",
        }),
      ),
      startUpdate(code, 5550001, { updateId: 151 }),
    ];
    const { api } = pagedBotApi(1001, "StoreOneAlertsBot", backlog);

    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api,
    });

    expect(paired.ok).toBe(true);

    const state = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(state?.destinationChatId).toBe("5550001");
  });

  it("persists pairing progress across repeated checks", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const backlog: TelegramBotUpdate[] = [
      ...Array.from({ length: 150 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 1,
          text: "old message",
        }),
      ),
      startUpdate(code, 5550001, { updateId: 151 }),
    ];

    const first = pagedBotApi(1001, "StoreOneAlertsBot", backlog);
    const pending = await checkMerchantNotificationBotPairing(db(), access, {
      api: first.api,
      pairingMaxPages: 1,
    });

    expect(pending).toEqual({ ok: false, error: "PAIRING_PENDING" });

    const afterFirst = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(afterFirst?.pairingUpdateOffset).toBe(101);
    expect(afterFirst?.destinationChatId).toBeNull();

    const second = pagedBotApi(1001, "StoreOneAlertsBot", backlog);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api: second.api,
      pairingMaxPages: 1,
    });

    expect(paired.ok).toBe(true);
    expect(second.offsets).toEqual([101]);

    const afterSecond = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(afterSecond?.pairingUpdateOffset).toBeNull();
    expect(afterSecond?.pairingCodeHash).toBeNull();
    expect(afterSecond?.destinationChatId).toBe("5550001");
  });

  it("rejects a challenge when two distinct chats match across pages", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const pageOne: TelegramBotUpdate[] = [
      startUpdate(code, 5550001, { updateId: 1, username: "owner_a" }),
      ...Array.from({ length: 99 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 2,
          text: "old message",
        }),
      ),
    ];
    const pageTwo: TelegramBotUpdate[] = [
      startUpdate(code, 5550002, { updateId: 101, username: "owner_b" }),
    ];

    const { api } = pagedBotApi(1001, "StoreOneAlertsBot", [
      ...pageOne,
      ...pageTwo,
    ]);
    const ambiguous = await checkMerchantNotificationBotPairing(db(), access, {
      api,
    });

    expect(ambiguous).toEqual({ ok: false, error: "PAIRING_AMBIGUOUS" });

    const secret = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(secret?.pairingFailureCode).toBe("ambiguous");
    expect(secret?.pairingCodeHash).toBeNull();
    expect(secret?.pairingCandidates).toBeNull();
    expect(secret?.destinationChatId).toBeNull();

    const getUpdates = vi.fn(async () => ({
      ok: true as const,
      result: [] as TelegramBotUpdate[],
    }));
    const recheckApi = botApi(1001, "StoreOneAlertsBot", [], { getUpdates });
    const recheck = await checkMerchantNotificationBotPairing(db(), access, {
      api: recheckApi,
    });

    expect(recheck).toEqual({ ok: false, error: "PAIRING_AMBIGUOUS" });
    expect(getUpdates).not.toHaveBeenCalled();

    const fresh = await startMerchantNotificationBotPairing(db(), access);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok || !fresh.pairing) throw new Error("Expected fresh pairing");

    const freshCode = codeFromLink(fresh.pairing.deepLink);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", [
        startUpdate(freshCode, 5550001, { updateId: 201 }),
      ]),
    });

    expect(paired.ok).toBe(true);

    const state = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(state?.destinationChatId).toBe("5550001");
    expect(state?.pairingFailureCode).toBeNull();
  });

  it("counts repeated messages from the same chat as one candidate", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const pageOne: TelegramBotUpdate[] = [
      startUpdate(code, 5550001, { updateId: 1, username: "owner" }),
      startUpdate(code, 5550001, { updateId: 2, username: "owner" }),
      ...Array.from({ length: 98 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 3,
          text: "old message",
        }),
      ),
    ];

    const { api } = pagedBotApi(1001, "StoreOneAlertsBot", pageOne);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api,
    });

    expect(paired.ok).toBe(true);

    const state = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(state?.destinationChatId).toBe("5550001");
  });

  it("retains a candidate across a page-budget retry", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const pageOne: TelegramBotUpdate[] = [
      startUpdate(code, 5550001, { updateId: 1 }),
      ...Array.from({ length: 99 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 2,
          text: "old message",
        }),
      ),
    ];

    const first = pagedBotApi(1001, "StoreOneAlertsBot", pageOne);
    const pending = await checkMerchantNotificationBotPairing(db(), access, {
      api: first.api,
      pairingMaxPages: 1,
    });

    expect(pending).toEqual({ ok: false, error: "PAIRING_PENDING" });

    const afterFirst = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(afterFirst?.pairingCandidates?.map((candidate) => candidate.chatId)).toEqual([
      "5550001",
    ]);
    expect(afterFirst?.pairingUpdateOffset).toBe(101);

    const second = pagedBotApi(1001, "StoreOneAlertsBot", pageOne);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api: second.api,
      pairingMaxPages: 10,
    });

    expect(paired.ok).toBe(true);
    expect(second.offsets).toEqual([101]);
  });

  it("retains a candidate across a page error", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const code = codeFromLink(connected.pairing.deepLink);
    const pageOne: TelegramBotUpdate[] = [
      startUpdate(code, 5550001, { updateId: 1 }),
      ...Array.from({ length: 99 }, (_, index) =>
        startUpdate("unused", 5550001, {
          updateId: index + 2,
          text: "old message",
        }),
      ),
    ];

    const getUpdates = vi.fn(
      async (input?: { offset?: number; limit?: number }) => {
        if (!input?.offset) {
          return {
            ok: true as const,
            result: pageOne.slice(0, input?.limit ?? 100),
          };
        }

        return {
          ok: false as const,
          error: "Network error",
          errorKind: "network_error" as const,
        };
      },
    );
    const brokenApi = botApi(1001, "StoreOneAlertsBot", [], { getUpdates });
    const failed = await checkMerchantNotificationBotPairing(db(), access, {
      api: brokenApi,
    });

    expect(failed).toEqual({ ok: false, error: "TELEGRAM_UNAVAILABLE" });

    const afterFailure = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(afterFailure?.pairingCandidates?.map((candidate) => candidate.chatId)).toEqual([
      "5550001",
    ]);
    expect(afterFailure?.pairingUpdateOffset).toBe(101);

    const second = pagedBotApi(1001, "StoreOneAlertsBot", pageOne);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api: second.api,
    });

    expect(paired.ok).toBe(true);
  });

  it("atomically merges concurrent candidates and refuses a two-chat confirm", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const secret = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    const pairingCodeHash = secret?.pairingCodeHash;

    if (!pairingCodeHash) throw new Error("Expected an active challenge");

    const candidateA = {
      chatId: "5550001",
      title: "Owner A",
      username: "owner_a",
      date: 1,
    };
    const candidateB = {
      chatId: "5550002",
      title: "Owner B",
      username: "owner_b",
      date: 2,
    };

    const first = await mergeMerchantNotificationBotPairingCandidates(
      asAppDb(db()),
      {
        storeId: fixture.storeAId,
        pairingCodeHash,
        candidates: [candidateA],
        nextOffset: 101,
      },
    );

    expect(first?.candidates.map((candidate) => candidate.chatId)).toEqual([
      "5550001",
    ]);

    const second = await mergeMerchantNotificationBotPairingCandidates(
      asAppDb(db()),
      {
        storeId: fixture.storeAId,
        pairingCodeHash,
        candidates: [candidateB],
        nextOffset: 201,
      },
    );

    expect(
      second?.candidates.map((candidate) => candidate.chatId).sort(),
    ).toEqual(["5550001", "5550002"]);

    expect(
      await confirmMerchantNotificationBotPairing(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash,
        chatId: candidateA.chatId,
        chatTitle: candidateA.title,
        chatUsername: candidateA.username,
      }),
    ).toBe(false);

    expect(
      await markMerchantNotificationBotPairingAmbiguous(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash,
      }),
    ).toBe(true);

    const after = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(after?.pairingFailureCode).toBe("ambiguous");
    expect(after?.pairingCodeHash).toBeNull();

    expect(
      await mergeMerchantNotificationBotPairingCandidates(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash,
        candidates: [candidateA],
        nextOffset: 301,
      }),
    ).toBeNull();
  });

  it("does not let an old challenge overwrite a replacement", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const before = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    const oldHash = before?.pairingCodeHash;

    if (!oldHash) throw new Error("Expected an active challenge");

    const candidateA = {
      chatId: "5550001",
      title: "Owner A",
      username: "owner_a",
      date: 1,
    };
    const candidateB = {
      chatId: "5550002",
      title: "Owner B",
      username: "owner_b",
      date: 2,
    };

    await mergeMerchantNotificationBotPairingCandidates(asAppDb(db()), {
      storeId: fixture.storeAId,
      pairingCodeHash: oldHash,
      candidates: [candidateA],
      nextOffset: 101,
    });

    const fresh = await startMerchantNotificationBotPairing(db(), access);
    expect(fresh.ok).toBe(true);

    const afterStart = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(afterStart?.pairingCodeHash).not.toBe(oldHash);
    expect(afterStart?.pairingCandidates).toBeNull();

    expect(
      await mergeMerchantNotificationBotPairingCandidates(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash: oldHash,
        candidates: [candidateB],
        nextOffset: 201,
      }),
    ).toBeNull();

    expect(
      await confirmMerchantNotificationBotPairing(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash: oldHash,
        chatId: candidateA.chatId,
        chatTitle: candidateA.title,
        chatUsername: candidateA.username,
      }),
    ).toBe(false);

    const still = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(still?.pairingCodeHash).toBe(afterStart?.pairingCodeHash);
    expect(still?.pairingCandidates).toBeNull();
    expect(still?.pairingFailureCode).toBeNull();
  });

  it("disconnect invalidates pending pairing writes", async () => {
    const access = await accessFor(fixture.userAId);
    const connected = await connectStore(access, 1001, "StoreOneAlertsBot");

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const secret = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    const pairingCodeHash = secret?.pairingCodeHash;

    if (!pairingCodeHash) throw new Error("Expected an active challenge");

    const candidate = {
      chatId: "5550001",
      title: "Owner A",
      username: "owner_a",
      date: 1,
    };

    await disconnectMerchantNotificationBot(db(), access);

    expect(
      await mergeMerchantNotificationBotPairingCandidates(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash,
        candidates: [candidate],
        nextOffset: 101,
      }),
    ).toBeNull();

    expect(
      await confirmMerchantNotificationBotPairing(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash,
        chatId: candidate.chatId,
        chatTitle: candidate.title,
        chatUsername: candidate.username,
      }),
    ).toBe(false);
  });

  it("rejects an expired pairing challenge and can issue a new one", async () => {
    const access = await accessFor(fixture.userAId);
    const expiredAt = new Date(Date.now() - 60 * 60 * 1000);

    const connected = await connectMerchantNotificationBot(
      db(),
      access,
      { token: TOKEN_A },
      {
        api: botApi(1001, "StoreOneAlertsBot"),
        now: () => expiredAt,
      },
    );

    if (!connected.ok || !connected.pairing) throw new Error("Expected pairing");

    const expired = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", []),
    });
    expect(expired).toEqual({ ok: false, error: "PAIRING_EXPIRED" });

    const expiredSecret = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    const expiredHash = expiredSecret?.pairingCodeHash;

    if (!expiredHash) throw new Error("Expected an expired challenge");

    expect(
      await mergeMerchantNotificationBotPairingCandidates(asAppDb(db()), {
        storeId: fixture.storeAId,
        pairingCodeHash: expiredHash,
        candidates: [
          {
            chatId: "5550001",
            title: "Owner",
            username: "owner",
            date: 1,
          },
        ],
        nextOffset: 101,
      }),
    ).toBeNull();

    const fresh = await startMerchantNotificationBotPairing(db(), access);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok || !fresh.pairing) throw new Error("Expected fresh pairing");

    const code = codeFromLink(fresh.pairing.deepLink);
    const paired = await checkMerchantNotificationBotPairing(db(), access, {
      api: botApi(1001, "StoreOneAlertsBot", [startUpdate(code, 5550001)]),
    });
    expect(paired.ok).toBe(true);
  });

  it("reports Telegram test-send failures without recording verification", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    const blockedTransport = createFakeTelegramTransport();
    blockedTransport.failSendWith = "Forbidden: bot was blocked by the user";
    blockedTransport.failSendKind = "blocked";
    blockedTransport.failSendIsBlocked = true;

    const blocked = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "ar" },
      { transport: blockedTransport },
    );
    expect(blocked).toEqual({ ok: false, error: "TEST_BLOCKED" });

    const missingTransport = createFakeTelegramTransport();
    missingTransport.failSendWith = "Bad Request: chat not found";
    missingTransport.failSendKind = "api_error";
    missingTransport.failSendHttpStatus = 400;

    const missing = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport: missingTransport },
    );
    expect(missing).toEqual({ ok: false, error: "TEST_CHAT_NOT_FOUND" });

    const limitedTransport = createFakeTelegramTransport();
    limitedTransport.failSendWith = "Too Many Requests: retry later";
    limitedTransport.failSendKind = "rate_limited";
    limitedTransport.failSendRetryAfter = 7;

    const limited = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport: limitedTransport },
    );
    expect(limited).toEqual({
      ok: false,
      error: "TEST_RATE_LIMITED",
      retryAfterSeconds: 7,
    });

    const networkTransport = createFakeTelegramTransport();
    networkTransport.failSendWith = "Network error";
    networkTransport.failSendKind = "network_error";

    const network = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport: networkTransport },
    );
    expect(network).toEqual({ ok: false, error: "TEST_NETWORK" });

    const state = await readMerchantNotificationBotState(asAppDb(db()), fixture.storeAId);
    expect(state?.verifiedAt).toBeNull();

    const successTransport = createFakeTelegramTransport();
    const success = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "ar" },
      { transport: successTransport },
    );
    expect(success.ok).toBe(true);
    expect(successTransport.sentMessages[0].text).toContain("تم ربط");
  });

  it("does not call the transport when the store is suspended after access resolution", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, fixture.storeAId));

    const transport = createFakeTelegramTransport();
    const result = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(transport.sentMessages).toHaveLength(0);
  });

  it("does not call the transport when membership is revoked after access resolution", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    await db()
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.userId, fixture.userAId));

    const transport = createFakeTelegramTransport();
    const result = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(transport.sentMessages).toHaveLength(0);
  });

  it("does not verify a send when the configuration changes during delivery", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    const before = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );

    if (!before) throw new Error("Expected a connected notification bot");

    const transport = createFakeTelegramTransport();
    const originalSend = transport.sendMessage.bind(transport);
    let changed = false;

    transport.sendMessage = async (params) => {
      if (!changed) {
        changed = true;

        // Same bot id and same destination chat id: only the configuration
        // identity changes, as a reconnect/re-pair ending in the same pair.
        await db()
          .update(merchantNotificationBot)
          .set({ configEpoch: crypto.randomUUID() })
          .where(eq(merchantNotificationBot.storeId, fixture.storeAId));
      }

      return originalSend(params);
    };

    const result = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport },
    );

    expect(result).toEqual({ ok: false, error: "CONFIGURATION_CHANGED" });
    expect(transport.sentMessages).toHaveLength(1);

    const after = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );

    expect(after?.configEpoch).not.toBe(before.configEpoch);
    expect(after?.botId).toBe(before.botId);
    expect(after?.destinationChatId).toBe(before.destinationChatId);
    expect(after?.verifiedAt).toBeNull();

    const state = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(state?.verifiedAt).toBeNull();
  });

  it("enforces one bot per store and isolates two stores", async () => {
    const accessA = await accessFor(fixture.userAId);
    const accessB = await accessFor(fixture.userBId);

    await connectAndPair(accessA, 1001, "StoreOneAlertsBot", 5550001, TOKEN_A);
    await connectAndPair(accessB, 2002, "StoreTwoAlertsBot", 6660002, TOKEN_B);

    const stateA = await readMerchantNotificationBotState(asAppDb(db()), fixture.storeAId);
    const stateB = await readMerchantNotificationBotState(asAppDb(db()), fixture.storeBId);

    expect(stateA?.botUsername).toBe("StoreOneAlertsBot");
    expect(stateA?.destinationChatId).toBe("5550001");
    expect(stateB?.botUsername).toBe("StoreTwoAlertsBot");
    expect(stateB?.destinationChatId).toBe("6660002");

    const duplicate = await connectStore(
      accessB,
      1001,
      "StoreOneAlertsBot",
      TOKEN_B,
    );
    expect(duplicate).toEqual({ ok: false, error: "BOT_ALREADY_CONNECTED" });

    const secretA = await readMerchantNotificationBotSecret(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(secretA?.pairingCodeHash).toBeNull();

    const crossStoreConfirm = await confirmMerchantNotificationBotPairing(
      asAppDb(db()),
      {
        storeId: fixture.storeBId,
        pairingCodeHash: crypto.randomBytes(32).toString("hex"),
        chatId: "5550001",
        chatTitle: "Wrong Store",
        chatUsername: null,
      },
    );
    expect(crossStoreConfirm).toBe(false);

    await expect(
      recordMerchantNotificationBotTestSuccess(asAppDb(db()), {
        storeId: fixture.storeBId,
        expectedChatId: "5550001",
        expectedBotId: 1001,
        expectedConfigEpoch: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });

    const disconnectedB = await disconnectMerchantNotificationBot(db(), accessB);
    expect(disconnectedB.ok).toBe(true);

    const stateAAfter = await readMerchantNotificationBotState(
      asAppDb(db()),
      fixture.storeAId,
    );
    expect(stateAAfter?.destinationChatId).toBe("5550001");
    expect(await readMerchantNotificationBotState(asAppDb(db()), fixture.storeBId)).toBeNull();
  });

  it("denies every write for a suspended (read-only) store", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, fixture.storeAId));

    const readOnlyAccess = await accessFor(fixture.userAId);
    expect(readOnlyAccess.readOnly).toBe(true);

    const getMe = vi.fn(async () => ({
      ok: true as const,
      result: { id: 1001, is_bot: true, username: "StoreOneAlertsBot" },
    }));
    const getUpdates = vi.fn(async () => ({ ok: true as const, result: [] }));
    const api = botApi(1001, "StoreOneAlertsBot", [], { getMe, getUpdates });
    const transport = createFakeTelegramTransport();

    expect(
      await connectMerchantNotificationBot(
        db(),
        readOnlyAccess,
        { token: TOKEN_A },
        { api },
      ),
    ).toEqual({ ok: false, error: "DENIED" });
    expect(
      await startMerchantNotificationBotPairing(db(), readOnlyAccess),
    ).toEqual({ ok: false, error: "DENIED" });
    expect(
      await checkMerchantNotificationBotPairing(db(), readOnlyAccess, { api }),
    ).toEqual({ ok: false, error: "DENIED" });
    expect(
      await sendMerchantNotificationBotTest(
        db(),
        readOnlyAccess,
        { locale: "en" },
        { transport },
      ),
    ).toEqual({ ok: false, error: "DENIED" });
    expect(
      await disconnectMerchantNotificationBot(db(), readOnlyAccess),
    ).toEqual({ ok: false, error: "DENIED" });

    expect(getMe).not.toHaveBeenCalled();
    expect(getUpdates).not.toHaveBeenCalled();
    expect(transport.sentMessages).toHaveLength(0);

    const state = await readMerchantNotificationBotState(asAppDb(db()), fixture.storeAId);
    expect(state?.destinationChatId).toBe("5550001");
  });

  it("disconnects the bot and removes the stored token", async () => {
    const access = await accessFor(fixture.userAId);
    await connectAndPair(access, 1001, "StoreOneAlertsBot", 5550001);

    const result = await disconnectMerchantNotificationBot(db(), access);

    expect(result).toEqual({ ok: true });
    expect(
      await db()
        .select()
        .from(merchantNotificationBot)
        .where(eq(merchantNotificationBot.storeId, fixture.storeAId)),
    ).toHaveLength(0);
    expect(
      await readMerchantNotificationBotState(asAppDb(db()), fixture.storeAId),
    ).toBeNull();
  });

});
