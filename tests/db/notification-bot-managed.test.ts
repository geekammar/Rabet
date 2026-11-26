import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import {
  appUser,
  merchantNotificationBot,
  store,
  storeMembership,
  telegramLinkAttempt,
} from "@/db/schema";
import type { MerchantAccess } from "@/lib/auth/merchant-session";
import {
  connectMerchantNotificationBot,
  disconnectMerchantNotificationBot,
  sendMerchantNotificationBotTest,
} from "@/lib/merchant/notification-bot";
import { decryptConnectionSecret } from "@/lib/telegram/connection-secrets";
import type {
  TelegramBotApiClient,
  TelegramBotUpdate,
} from "@/lib/telegram/manager-api";
import {
  TELEGRAM_LINK_ATTEMPT_TTL_MS,
  bindLinkAttemptToTelegramUser,
  createTelegramLinkAttempt,
  ensureNotificationBotLinkAttempt,
  handleManagedBotEvent,
  handleManagerStartMessage,
  managedBotStartChallengeCopy,
  managedNotificationBotConfirmationCopy,
  verifyManagedNotificationBotStart,
} from "@/lib/telegram/manager-provisioning";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import type { TelegramMessage } from "@/lib/telegram/types";
import {
  createTestDatabase,
  hasTestCluster,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const KEY = crypto.randomBytes(32);
const KEY_ID = "notification-managed-test-v1";

let testDb: TestDatabase | null = null;
let storeAId: string;
let storeBId: string;
let userAId: string;
let userBId: string;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.TELEGRAM_CONNECTION_TOKEN_KEY = KEY.toString("base64");
  process.env.TELEGRAM_CONNECTION_TOKEN_KEY_ID = KEY_ID;

  testDb = await createTestDatabase("notification_bot_managed");
  const db = testDb.db;

  const [storeA] = await db
    .insert(store)
    .values({ name: "Managed Notify A", slug: "managed-notify-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Managed Notify B", slug: "managed-notify-b", status: "active" })
    .returning();
  const [userA] = await db
    .insert(appUser)
    .values({ email: "managed.notify.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "managed.notify.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  storeAId = storeA.id;
  storeBId = storeB.id;
  userAId = userA.id;
  userBId = userB.id;
});

afterAll(async () => {
  delete process.env.TELEGRAM_CONNECTION_TOKEN_KEY;
  delete process.env.TELEGRAM_CONNECTION_TOKEN_KEY_ID;
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db
    .update(appUser)
    .set({ sessionVersion: 0 })
    .where(inArray(appUser.id, [userAId, userBId]));
  await testDb.db.execute(sql`
    truncate table
      "merchant_notification_bot",
      "telegram_link_attempt",
      "telegram_connection"
    restart identity cascade
  `);
});

function db() {
  return testDb!.db;
}

function managerApi(
  overrides: Partial<TelegramBotApiClient> = {},
): TelegramBotApiClient {
  return {
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: {
        id: 9001,
        is_bot: true,
        first_name: "Rabet Manager",
        username: "RabetManagerBot",
      },
    })),
    getManagedBotToken: vi.fn(async () => ({
      ok: true as const,
      result: "800001:AA-managed-notification-token",
    })),
    setWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getWebhookInfo: vi.fn(async () => ({
      ok: true as const,
      result: { url: "" },
    })),
    deleteWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getUpdates: vi.fn(async () => ({ ok: true as const, result: [] })),
    ...overrides,
  } as TelegramBotApiClient;
}

function notificationBotApi(
  botId: number,
  username: string,
  updates: TelegramBotUpdate[],
  overrides: Partial<TelegramBotApiClient> = {},
): TelegramBotApiClient {
  return {
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: {
        id: botId,
        is_bot: true,
        first_name: "Managed Notify Bot",
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

function startMessage(
  updateId: number,
  userId: number,
  nonce: string,
  firstName = "Muse",
): TelegramBotUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: {
        id: userId,
        is_bot: false,
        first_name: firstName,
        username: "muse_owner",
      },
      chat: {
        id: userId,
        type: "private",
        first_name: firstName,
        username: "muse_owner",
      },
      date: Math.floor(Date.now() / 1000),
      text: `/start ${nonce}`,
    },
  };
}

async function merchantAccess(
  storeId: string,
  userId: string,
  email: string,
): Promise<MerchantAccess> {
  const scope = await readStoreScopeForFixture(db(), storeId);
  return {
    userId,
    email,
    sessionVersion: 0,
    role: "owner",
    store: {
      id: storeId,
      name: "Managed Notify",
      slug: storeId === storeAId ? "managed-notify-a" : "managed-notify-b",
      status: "active",
    },
    scope,
    readOnly: false,
  };
}

async function prepareNotificationProposal(input: {
  storeId: string;
  merchantUserId: string;
  telegramUserId: number;
  botId: number;
  botUsername: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const ensured = await ensureNotificationBotLinkAttempt(db(), {
    storeId: input.storeId,
    merchantUserId: input.merchantUserId,
    managerBotUsername: "RabetManagerBot",
    now,
  });

  if (ensured.status !== "created" && ensured.status !== "reused") {
    throw new Error(`unexpected ensure status ${ensured.status}`);
  }

  const bound = await bindLinkAttemptToTelegramUser(db(), {
    nonce: ensured.nonce,
    telegramUserId: input.telegramUserId,
    now,
  });
  expect(bound.status).toBe("bound");

  const result = await handleManagedBotEvent(
    db(),
    {
      creatorUserId: input.telegramUserId,
      botId: input.botId,
      botUsername: input.botUsername,
      botName: "Managed Notify Bot",
    },
    {
      managerApi: managerApi(),
      webhookOrigin: "https://app.example.test",
      transport: createFakeTelegramTransport(),
      now,
    },
  );

  expect(result.status).toBe("awaiting_bot_start");
  return { ensured, nonce: ensured.nonce };
}

describe.skipIf(!shouldRun)("managed notification bot onboarding", () => {
  it("sends notification-specific creation and confirmation copy", () => {
    const challenge = managedBotStartChallengeCopy({
      purpose: "notification_bot",
      botName: "Managed Notify Bot",
      botUsername: "ManagedNotifyBot",
      verificationUrl: "https://t.me/ManagedNotifyBot?start=nonce",
    });

    expect(challenge.text).toContain("إشعارات");
    expect(challenge.text.toLowerCase()).toContain("notification");
    expect(JSON.stringify(challenge.replyMarkup)).toContain(
      "https://t.me/ManagedNotifyBot?start=nonce",
    );

    const confirmation = managedNotificationBotConfirmationCopy({
      botName: "Managed Notify Bot",
      botUsername: "ManagedNotifyBot",
      origin: "https://app.example.test",
    });

    expect(confirmation.text).toContain("notification bot");
    expect(confirmation.replyMarkup.inline_keyboard[0]?.[0]?.url).toBe(
      "https://app.example.test/app/setup",
    );
  });

  it("binds a notification attempt from the manager /start and sends a notification creation link", async () => {
    const ensured = await ensureNotificationBotLinkAttempt(db(), {
      storeId: storeAId,
      merchantUserId: userAId,
      managerBotUsername: "RabetManagerBot",
    });

    expect(ensured.status).toBe("created");
    if (ensured.status !== "created") return;

    const transport = createFakeTelegramTransport();
    await handleManagerStartMessage(
      db(),
      transport,
      {
        message_id: 1,
        from: {
          id: 700001,
          is_bot: false,
          first_name: "Muse",
          username: "muse_owner",
        },
        chat: {
          id: 700001,
          type: "private",
          first_name: "Muse",
          username: "muse_owner",
        },
        date: Math.floor(Date.now() / 1000),
        text: `/start ${ensured.nonce}`,
      } as TelegramMessage,
    );

    expect(transport.sentMessages).toHaveLength(1);
    const sent = transport.sentMessages[0];
    expect(sent?.text.toLowerCase()).toContain("notification bot");
    expect(JSON.stringify(sent?.replyMarkup)).toContain("/newbot/");
    expect(JSON.stringify(sent?.replyMarkup)).toContain("_notify");

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.purpose).toBe("notification_bot");
    expect(attempt.telegramUserId).toBe(700001);
  });

  it("allows simultaneous store and notification attempts but fails a managed_bot event closed", async () => {
    const storeAttempt = await createTelegramLinkAttempt(db(), {
      storeId: storeAId,
      merchantUserId: userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const notificationAttempt = await ensureNotificationBotLinkAttempt(db(), {
      storeId: storeAId,
      merchantUserId: userAId,
      managerBotUsername: "RabetManagerBot",
    });

    expect(notificationAttempt.status).toBe("created");
    if (notificationAttempt.status !== "created") return;

    expect(
      (
        await bindLinkAttemptToTelegramUser(db(), {
          nonce: storeAttempt.nonce,
          telegramUserId: 700001,
        })
      ).status,
    ).toBe("bound");
    expect(
      (
        await bindLinkAttemptToTelegramUser(db(), {
          nonce: notificationAttempt.nonce,
          telegramUserId: 700001,
        })
      ).status,
    ).toBe("bound");

    const manager = managerApi();
    const result = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 700001,
        botId: 800010,
        botUsername: "AmbiguousNotifyBot",
        botName: "Ambiguous",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        transport: createFakeTelegramTransport(),
      },
    );

    expect(result.status).toBe("ambiguous");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const rows = await db()
      .select({
        purpose: telegramLinkAttempt.purpose,
        status: telegramLinkAttempt.status,
        failureCode: telegramLinkAttempt.failureCode,
      })
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, storeAId))
      .orderBy(telegramLinkAttempt.purpose);

    expect(rows).toEqual([
      {
        purpose: "notification_bot",
        status: "failed",
        failureCode: "ambiguous_event",
      },
      {
        purpose: "store_bot",
        status: "failed",
        failureCode: "ambiguous_event",
      },
    ]);

    const bots = await db().select().from(merchantNotificationBot);
    expect(bots).toHaveLength(0);
  });

  it("creates a verified notification bot, sends a test, and disconnects without a webhook", async () => {
    const { ensured, nonce } = await prepareNotificationProposal({
      storeId: storeAId,
      merchantUserId: userAId,
      telegramUserId: 700001,
      botId: 800001,
      botUsername: "ManagedNotifyBot",
    });

    const bot = notificationBotApi(800001, "ManagedNotifyBot", [
      startMessage(1, 700001, nonce),
    ]);
    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "800001:AA-managed-notification-token",
      })),
    });

    const verified = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => bot,
        transport: createFakeTelegramTransport(),
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(verified.status).toBe("verified");
    expect(bot.getUpdates).toHaveBeenCalled();
    expect(bot.setWebhook).not.toHaveBeenCalled();

    const [saved] = await db().select().from(merchantNotificationBot);
    expect(saved.storeId).toBe(storeAId);
    expect(saved.botId).toBe(800001);
    expect(saved.botUsername).toBe("ManagedNotifyBot");
    expect(saved.destinationChatId).toBe("700001");
    expect(saved.destinationChatTitle).toBe("Muse");
    expect(saved.verifiedAt).not.toBeNull();
    expect(
      decryptConnectionSecret(saved.tokenCiphertext, saved.tokenKeyId),
    ).toBe("800001:AA-managed-notification-token");

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.status).toBe("completed");
    expect(attempt.failureCode).toBeNull();
    expect(attempt.telegramBotId).toBe(800001);

    const access = await merchantAccess(storeAId, userAId, "managed.notify.a@example.test");
    const testTransport = createFakeTelegramTransport();
    const test = await sendMerchantNotificationBotTest(
      db(),
      access,
      { locale: "en" },
      { transport: testTransport },
    );

    expect(test.ok).toBe(true);
    expect(testTransport.sentMessages).toHaveLength(1);
    expect(testTransport.sentMessages[0]?.chatId).toBe("700001");

    const replayed = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => bot,
        transport: createFakeTelegramTransport(),
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(replayed.status).toBe("already_verified");
    expect(await db().select().from(merchantNotificationBot)).toHaveLength(1);

    const disconnected = await disconnectMerchantNotificationBot(db(), access);
    expect(disconnected.ok).toBe(true);
    expect(await db().select().from(merchantNotificationBot)).toHaveLength(0);
  });

  it("persists nothing and sends no confirmation when the session is revoked in flight", async () => {
    const { ensured, nonce } = await prepareNotificationProposal({
      storeId: storeAId,
      merchantUserId: userAId,
      telegramUserId: 700001,
      botId: 800004,
      botUsername: "RevokedSessionBot",
    });

    const manager = managerApi();
    const bot = notificationBotApi(800004, "RevokedSessionBot", [], {
      getUpdates: vi.fn(async () => {
        await db()
          .update(appUser)
          .set({ sessionVersion: 1 })
          .where(eq(appUser.id, userAId));
        return { ok: true as const, result: [startMessage(1, 700001, nonce)] };
      }),
    });
    const confirmationTransport = createFakeTelegramTransport();

    const result = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => bot,
        transport: confirmationTransport,
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(result.status).toBe("conflict");
    expect(await db().select().from(merchantNotificationBot)).toHaveLength(0);
    expect(confirmationTransport.sentMessages).toHaveLength(0);

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.status).toBe("provisioning");
  });

  it("lets a manual setup that completes in flight win over the stale managed attempt", async () => {
    const { ensured, nonce } = await prepareNotificationProposal({
      storeId: storeAId,
      merchantUserId: userAId,
      telegramUserId: 700001,
      botId: 800005,
      botUsername: "StaleManagedBot",
    });

    const access = await merchantAccess(
      storeAId,
      userAId,
      "managed.notify.a@example.test",
    );
    const manualApi = {
      getMe: vi.fn(async () => ({
        ok: true as const,
        result: {
          id: 900009,
          is_bot: true,
          first_name: "Manual Notify",
          username: "ManualNotifyBot",
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
      deleteWebhook: vi.fn(async () => ({
        ok: true as const,
        result: true as const,
      })),
      getUpdates: vi.fn(async () => ({ ok: true as const, result: [] })),
    } as TelegramBotApiClient;

    const manager = managerApi();
    const confirmationTransport = createFakeTelegramTransport();
    const bot = notificationBotApi(800005, "StaleManagedBot", [], {
      getUpdates: vi.fn(async () => {
        const manual = await connectMerchantNotificationBot(
          db(),
          access,
          { token: "900009:AA-manual-token-abcdefghijklmnop" },
          { api: manualApi },
        );
        expect(manual.ok).toBe(true);
        return { ok: true as const, result: [startMessage(1, 700001, nonce)] };
      }),
    });

    const result = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => bot,
        transport: confirmationTransport,
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(result.status).toBe("superseded");
    expect(confirmationTransport.sentMessages).toHaveLength(0);

    const [saved] = await db().select().from(merchantNotificationBot);
    expect(saved.botId).toBe(900009);
    expect(saved.botUsername).toBe("ManualNotifyBot");
    expect(saved.destinationChatId).toBeNull();
    expect(saved.pairingCodeHash).not.toBeNull();
    expect(
      decryptConnectionSecret(saved.tokenCiphertext, saved.tokenKeyId),
    ).toBe("900009:AA-manual-token-abcdefghijklmnop");

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.status).toBe("cancelled");
    expect(attempt.failureCode).toBe("superseded_by_manual");
  });

  it("rejects an expired attempt before fetching a token", async () => {
    const start = new Date(
      Date.now() - TELEGRAM_LINK_ATTEMPT_TTL_MS - 120_000,
    );
    const { ensured, nonce } = await prepareNotificationProposal({
      storeId: storeAId,
      merchantUserId: userAId,
      telegramUserId: 700001,
      botId: 800002,
      botUsername: "ExpiredNotifyBot",
      now: start,
    });

    const manager = managerApi();
    const bot = notificationBotApi(800002, "ExpiredNotifyBot", [
      startMessage(1, 700001, nonce),
    ]);
    const result = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => bot,
        transport: createFakeTelegramTransport(),
        webhookOrigin: "https://app.example.test",
        now: new Date(start.getTime() + TELEGRAM_LINK_ATTEMPT_TTL_MS + 60_000),
      },
    );

    expect(result.status).toBe("expired");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
    expect(await db().select().from(merchantNotificationBot)).toHaveLength(0);

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.status).toBe("expired");
  });

  it("does not complete from another account or from a bot bound to another store", async () => {
    const { ensured, nonce } = await prepareNotificationProposal({
      storeId: storeAId,
      merchantUserId: userAId,
      telegramUserId: 700001,
      botId: 800003,
      botUsername: "ForeignNotifyBot",
    });

    const manager = managerApi();
    const wrongAccountBot = notificationBotApi(800003, "ForeignNotifyBot", [
      startMessage(1, 700002, nonce, "Other"),
    ]);

    const wrongAccount = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => wrongAccountBot,
        transport: createFakeTelegramTransport(),
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(wrongAccount.status).toBe("pending");
    expect(await db().select().from(merchantNotificationBot)).toHaveLength(0);

    await db().insert(merchantNotificationBot).values({
      storeId: storeBId,
      botId: 800003,
      botUsername: "ForeignNotifyBot",
      tokenCiphertext: "other-store-ciphertext",
      tokenKeyId: KEY_ID,
      destinationChatId: "700002",
      destinationChatTitle: "Other",
      verifiedAt: new Date(),
    });

    const boundElsewhereBot = notificationBotApi(800003, "ForeignNotifyBot", [
      startMessage(2, 700001, nonce),
    ]);

    const boundElsewhere = await verifyManagedNotificationBotStart(
      db(),
      {
        storeId: storeAId,
        merchantUserId: userAId,
        sessionVersion: 0,
        attemptId: ensured.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => boundElsewhereBot,
        transport: createFakeTelegramTransport(),
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(boundElsewhere.status).toBe("bot_bound_elsewhere");
    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, ensured.attemptId));
    expect(attempt.status).toBe("failed");
    expect(attempt.failureCode).toBe("bot_bound_elsewhere");
  });
});
