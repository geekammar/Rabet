import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import {
  appUser,
  category,
  categoryTranslation,
  language,
  product,
  productTranslation,
  store,
  storeMembership,
  telegramConnection,
  telegramLinkAttempt,
  telegramManagedUpdate,
} from "@/db/schema";
import {
  decryptConnectionSecret,
  encryptConnectionSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "@/lib/telegram/connection-secrets";
import type { TelegramBotApiClient } from "@/lib/telegram/manager-api";
import {
  MANAGED_BOT_RETURN_BUTTON_TEXT,
  bindLinkAttemptToTelegramUser,
  confirmTelegramConnection,
  createTelegramLinkAttempt,
  ensureTelegramLinkAttempt,
  handleManagedBotEvent,
  readMerchantTelegramConnectionState,
  readReadyManagedConnection,
  recoverManagedTelegramCandidate,
  verifyManagedBotStart,
} from "@/lib/telegram/manager-provisioning";
import { handleManagedTelegramWebhookRequest } from "@/lib/telegram/managed-webhook";
import { handleManagerTelegramWebhookRequest } from "@/lib/telegram/manager-webhook";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { readStoreScopeForFixture, asAppDb, createTestDatabase, hasTestCluster, nextOrder, type TestDatabase } from "./helpers";

const shouldRun = hasTestCluster();
const KEY = crypto.randomBytes(32);
const KEY_ID = "managed-test-v1";

let testDb: TestDatabase | null = null;

type Fixture = {
  storeAId: string;
  storeBId: string;
  userAId: string;
  userBId: string;
  categoryAId: string;
  categoryAChildId: string;
  categoryAInactiveId: string;
  categoryBId: string;
  productAOneId: string;
  productATwoId: string;
  productADraftId: string;
  productADeletedId: string;
  productAHiddenId: string;
  productBId: string;
};

let fixture: Fixture;

beforeAll(async () => {
  if (!shouldRun) return;

  process.env.TELEGRAM_CONNECTION_TOKEN_KEY = KEY.toString("base64");
  process.env.TELEGRAM_CONNECTION_TOKEN_KEY_ID = KEY_ID;

  testDb = await createTestDatabase("telegram_managed_connections");
  const db = testDb.db;

  const [english] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  const [arabic] = await db
    .insert(language)
    .values({ code: "ar", label: "Arabic", textDirection: "rtl", isEnabled: true })
    .returning();

  const [storeA] = await db
    .insert(store)
    .values({ name: "Managed Store A", slug: "managed-store-a", status: "active" })
    .returning();
  const [storeB] = await db
    .insert(store)
    .values({ name: "Managed Store B", slug: "managed-store-b", status: "active" })
    .returning();

  const [userA] = await db
    .insert(appUser)
    .values({ email: "managed.a@example.test" })
    .returning();
  const [userB] = await db
    .insert(appUser)
    .values({ email: "managed.b@example.test" })
    .returning();

  await db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  const [categoryA] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "managed-store-a-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryAChild] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      parentId: categoryA.id,
      slug: "managed-store-a-child",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();
  const [categoryAInactive] = await db
    .insert(category)
    .values({
      storeId: storeA.id,
      slug: "managed-store-a-inactive",
      sortOrder: nextOrder(),
      isActive: false,
    })
    .returning();
  const [categoryB] = await db
    .insert(category)
    .values({
      storeId: storeB.id,
      slug: "managed-store-b-root",
      sortOrder: nextOrder(),
      isActive: true,
    })
    .returning();

  await db.insert(categoryTranslation).values([
    { categoryId: categoryA.id, languageId: english.id, name: "A Root" },
    { categoryId: categoryAChild.id, languageId: english.id, name: "A Child" },
    { categoryId: categoryB.id, languageId: english.id, name: "B Root" },
  ]);

  const [productAOne] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryAChild.id,
      slug: "a-one",
      price: "11.00",
      isActive: true,
      sortOrder: 10,
    })
    .returning();
  const [productATwo] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "a-two",
      price: "12.00",
      isActive: true,
      sortOrder: 20,
    })
    .returning();
  const [productADraft] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "a-draft",
      price: "13.00",
      isActive: false,
      sortOrder: 30,
    })
    .returning();
  const [productADeleted] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryA.id,
      slug: "a-deleted",
      price: "14.00",
      isActive: true,
      deletedAt: new Date(),
      sortOrder: 40,
    })
    .returning();
  const [productAHidden] = await db
    .insert(product)
    .values({
      storeId: storeA.id,
      categoryId: categoryAInactive.id,
      slug: "a-hidden",
      price: "15.00",
      isActive: true,
      sortOrder: 50,
    })
    .returning();
  const [productB] = await db
    .insert(product)
    .values({
      storeId: storeB.id,
      categoryId: categoryB.id,
      slug: "b-only",
      price: "21.00",
      isActive: true,
      sortOrder: 10,
    })
    .returning();

  await db.insert(productTranslation).values(
    [
      [productAOne, "A One"],
      [productATwo, "A Two"],
      [productADraft, "A Draft"],
      [productADeleted, "A Deleted"],
      [productAHidden, "A Hidden"],
      [productB, "B Only"],
    ].flatMap(([row, name]) => [
      {
        productId: (row as { id: string }).id,
        languageId: english.id,
        name: String(name),
        description: `${name} description`,
      },
      {
        productId: (row as { id: string }).id,
        languageId: arabic.id,
        name: `${name} AR`,
      },
    ]),
  );

  fixture = {
    storeAId: storeA.id,
    storeBId: storeB.id,
    userAId: userA.id,
    userBId: userB.id,
    categoryAId: categoryA.id,
    categoryAChildId: categoryAChild.id,
    categoryAInactiveId: categoryAInactive.id,
    categoryBId: categoryB.id,
    productAOneId: productAOne.id,
    productATwoId: productATwo.id,
    productADraftId: productADraft.id,
    productADeletedId: productADeleted.id,
    productAHiddenId: productAHidden.id,
    productBId: productB.id,
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
    truncate table
      "telegram_managed_update",
      "telegram_link_attempt",
      "telegram_connection"
    restart identity cascade
  `);
});

function db() {
  return testDb!.db;
}

function appDb() {
  return asAppDb(testDb!.db);
}

async function scope(storeId: string) {
  return readStoreScopeForFixture(testDb!.db, storeId);
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
      result: "123456:AA-managed-token",
    })),
    setWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getWebhookInfo: vi.fn(async ({ url }: { url?: string } = {}) => ({
      ok: true as const,
      result: { url: url ?? "https://app.example.test/api/telegram/webhook/managed/x" },
    })),
    deleteWebhook: vi.fn(async () => ({ ok: true as const, result: true as const })),
    getUpdates: vi.fn(async () => ({ ok: true as const, result: [] })),
    ...overrides,
  } as TelegramBotApiClient;
}

type TrackedBotApi = TelegramBotApiClient & {
  getWebhookUrl(): string;
  getWebhookSecret(): string;
};

function botApi(
  botId: number,
  username: string,
  overrides: Partial<TelegramBotApiClient> = {},
): TrackedBotApi {
  let lastWebhookUrl = "";
  let lastWebhookSecret = "";

  const api: TrackedBotApi = {
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: { id: botId, is_bot: true, first_name: username, username },
    })),
    getManagedBotToken: vi.fn(async () => ({
      ok: false as const,
      error: "not used",
    })),
    setWebhook: vi.fn(async (input: { url: string; secretToken: string }) => {
      lastWebhookUrl = input.url;
      lastWebhookSecret = input.secretToken;
      return { ok: true as const, result: true as const };
    }),
    getWebhookInfo: vi.fn(async () => ({
      ok: true as const,
      result: { url: lastWebhookUrl },
    })),
    deleteWebhook: vi.fn(async () => {
      lastWebhookUrl = "";
      lastWebhookSecret = "";
      return { ok: true as const, result: true as const };
    }),
    getUpdates: vi.fn(async () => ({ ok: true as const, result: [] })),
    getWebhookUrl: () => lastWebhookUrl,
    getWebhookSecret: () => lastWebhookSecret,
    ...overrides,
  } as TrackedBotApi;

  return api;
}

async function provision(
  storeId: string,
  merchantUserId: string,
  telegramUserId: number,
  botId: number,
  botUsername: string,
  overrides: {
    manager?: Partial<TelegramBotApiClient>;
    managed?: Partial<TelegramBotApiClient>;
    managedApi?: TelegramBotApiClient;
  } = {},
) {
  const started = await createTelegramLinkAttempt(db(), {
    storeId,
    merchantUserId,
    managerBotUsername: "RabetManagerBot",
  });

  const bound = await bindLinkAttemptToTelegramUser(db(), {
    nonce: started.nonce,
    telegramUserId,
  });

  expect(bound.status).toBe("bound");

  const manager = managerApi({
    getManagedBotToken: vi.fn(async () => ({
      ok: true as const,
      result: `${botId}:AA-managed-token`,
    })),
    ...overrides.manager,
  });

  const created =
    overrides.managedApi ?? botApi(botId, botUsername, overrides.managed);

  const result = await handleManagedBotEvent(
    db(),
    {
      creatorUserId: telegramUserId,
      botId,
      botUsername,
      botName: botUsername,
    },
    {
      managerApi: manager,
      webhookOrigin: "https://app.example.test",
    },
  );

  let finalResult = result;
  let verification: Awaited<ReturnType<typeof verifyManagedBotStart>> | null =
    null;

  if (result.status === "awaiting_bot_start") {
    const verificationApi: TelegramBotApiClient = {
      ...created,
      getWebhookInfo: vi.fn(async () => ({
        ok: true as const,
        result: { url: "" },
      })),
      getUpdates: vi.fn(async () => ({
        ok: true as const,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              from: {
                id: telegramUserId,
                is_bot: false,
                first_name: "Merchant",
              },
              chat: { id: telegramUserId, type: "private" },
              date: 1,
              text: `/start ${started.nonce}`,
            },
          },
        ],
      })),
    };

    verification = await verifyManagedBotStart(
      db(),
      {
        storeId,
        merchantUserId,
        attemptId: result.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => verificationApi,
        webhookOrigin: "https://app.example.test",
      },
    );

    if (
      verification.status === "verified" ||
      verification.status === "already_verified"
    ) {
      finalResult = {
        status: "awaiting_confirmation",
        attemptId: verification.attemptId,
        connectionId: verification.connectionId,
        botUsername: verification.botUsername,
      } as typeof result;
    }
  }

  return {
    started,
    manager,
    managed: created,
    result: finalResult,
    verification,
    initialResult: result,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function webhookRequest(body: unknown, secret?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== undefined) {
    headers.set("x-telegram-bot-api-secret-token", secret);
  }
  return new Request("https://app.example.test/api/telegram/webhook/managed/x", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function seedReadyConnection(input: {
  storeId: string;
  botId: number;
  botUsername: string;
  secret: string;
}) {
  const id = crypto.randomUUID();
  const encrypted = encryptConnectionSecret(`${input.botId}:AA-managed-token`);

  await db().insert(telegramConnection).values({
    id,
    storeId: input.storeId,
    botId: input.botId,
    botUsername: input.botUsername,
    botName: input.botUsername,
    tokenCiphertext: encrypted.ciphertext,
    tokenKeyId: encrypted.keyId,
    webhookSecretHash: hashWebhookSecret(input.secret),
    webhookUrl: `https://app.example.test/api/telegram/webhook/managed/${id}`,
    status: "ready",
    verifiedAt: new Date(),
  });

  return id;
}

describe.skipIf(!shouldRun)("managed Telegram bot connections", () => {
  it("creates one active store-scoped attempt, encrypts the nonce, and replaces an older attempt", async () => {
    const first = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const second = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    expect(second.attemptId).not.toBe(first.attemptId);

    const rows = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeAId));

    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.id === first.attemptId)?.status,
    ).toBe("cancelled");
    expect(
      rows.find((row) => row.id === second.attemptId)?.status,
    ).toBe("pending");
    expect(rows[1].nonceCiphertext).not.toContain(first.nonce);
    expect(rows[1].nonceCiphertext).not.toContain(second.nonce);

    const supersededNonce = await bindLinkAttemptToTelegramUser(db(), {
      nonce: first.nonce,
      telegramUserId: 7000,
    });
    expect(supersededNonce.status).toBe("expired");

    const stateA = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(stateA.state).toBe("waiting");
    if (stateA.state === "waiting") {
      expect(stateA.deepLink).toContain("RabetManagerBot");
      expect(stateA.deepLink).toContain("start=");
      expect(stateA.telegramBound).toBe(false);
    }

    const stateB = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeBId),
      merchantUserId: fixture.userBId,
    });
    expect(stateB).toEqual({ state: "not_connected" });
  });

  it("binds one Telegram actor, treats replay as idempotent, rejects a different actor and expires late attempts", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    const first = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7001,
    });
    expect(first.status).toBe("bound");

    const replay = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7001,
    });
    expect(replay.status).toBe("already_bound");

    const otherActor = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7002,
    });
    expect(otherActor.status).toBe("mismatch");

    const [row] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(row.telegramUserId).toBe(7001);

    const expired = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
      now: new Date(Date.now() - 60 * 60 * 1000),
    });

    const expiredBind = await bindLinkAttemptToTelegramUser(db(), {
      nonce: expired.nonce,
      telegramUserId: 7003,
    });
    expect(expiredBind.status).toBe("expired");
  });

  it("prepares a candidate without touching the webhook, then activates only after merchant confirmation", async () => {
    const { result, managed } = await provision(
      fixture.storeAId,
      fixture.userAId,
      7101,
      6001,
      "AStoreBot",
    );

    expect(result.status).toBe("awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") return;

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, result.connectionId));

    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botId).toBe(6001);
    expect(connection.botUsername).toBe("AStoreBot");
    expect(connection.tokenCiphertext).not.toContain("6001:AA-managed-token");
    expect(connection.webhookSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.webhookUrl).toContain(result.connectionId);
    expect(
      decryptConnectionSecret(connection.tokenCiphertext, connection.tokenKeyId),
    ).toBe("6001:AA-managed-token");

    // The verified manager event must not register or remove a webhook.
    expect(managed?.setWebhook).not.toHaveBeenCalled();
    expect(managed?.getWebhookInfo).not.toHaveBeenCalled();
    expect(managed?.deleteWebhook).not.toHaveBeenCalled();

    const stateA = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(stateA.state).toBe("confirm");
    if (stateA.state === "confirm") {
      expect(stateA.botUsername).toBe("AStoreBot");
      expect(stateA.lastError).toBeNull();
    }

    const stateB = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeBId),
      merchantUserId: fixture.userBId,
    });
    expect(stateB).toEqual({ state: "not_connected" });

    const denied = await confirmTelegramConnection(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      connectionId: result.connectionId,
    });
    expect(denied.status).toBe("not_found");
    expect(managed?.setWebhook).not.toHaveBeenCalled();

    const confirmed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: result.connectionId,
      },
      { createBotApi: () => managed! },
    );
    expect(confirmed.status).toBe("ready");

    expect(managed?.setWebhook).toHaveBeenCalledTimes(1);
    expect(managed?.getWebhookInfo).toHaveBeenCalledTimes(2);

    const [activated] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, result.connectionId));

    expect(activated.status).toBe("ready");
    expect(activated.webhookUrl).toBe(managed!.getWebhookUrl());
    expect(activated.webhookUrl).toContain(
      `/api/telegram/webhook/managed/${result.connectionId}`,
    );
    expect(new URL(activated.webhookUrl).searchParams.has("v")).toBe(true);
    expect(activated.webhookSecretHash).toBe(
      hashWebhookSecret(managed!.getWebhookSecret()),
    );

    const connected = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(connected.state).toBe("connected");
    if (connected.state === "connected") {
      expect(connected.botUsername).toBe("AStoreBot");
      expect(connected.openUrl).toBe("https://t.me/AStoreBot");
    }

    const routedTransport = createFakeTelegramTransport();
    const routed = await handleManagedTelegramWebhookRequest(
      webhookRequest(
        {
          update_id: 4242,
          message: {
            message_id: 4242,
            from: { id: 7101, is_bot: false, first_name: "Customer" },
            chat: { id: 7101, type: "private" },
            date: 1,
            text: "/start",
          },
        },
        managed!.getWebhookSecret(),
      ),
      result.connectionId,
      { db: appDb(), transport: routedTransport },
    );
    expect(routed.status).toBe(200);
    expect(routedTransport.sentMessages).toHaveLength(1);
    expect(routedTransport.sentMessages[0].text).toContain("Managed Store A");

    const repeated = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: result.connectionId,
      },
      { createBotApi: () => managed! },
    );
    expect(repeated.status).toBe("already_ready");
    expect(managed?.setWebhook).toHaveBeenCalledTimes(1);

    const duplicate = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7101,
        botId: 6001,
        botUsername: "AStoreBot",
        botName: "AStoreBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(duplicate.status).toBe("already_provisioned");

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connections).toHaveLength(1);
  });

  it("rejects a bot already connected to another store before fetching its token", async () => {
    const seeded = await seedReadyConnection({
      storeId: fixture.storeBId,
      botId: 6002,
      botUsername: "BStoreBot",
      secret: "b-secret",
    });
    expect(seeded).toBeTruthy();

    const { result, manager } = await provision(
      fixture.storeAId,
      fixture.userAId,
      7201,
      6002,
      "BStoreBot",
    );

    expect(result).toMatchObject({
      status: "bot_bound_elsewhere",
    });
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const attempts = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeAId));
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].failureCode).toBe("bot_bound_elsewhere");
  });

  it("links sequential distinct bots created by the same Telegram account for two stores", async () => {
    const creatorUserId = 7701;
    const preparedA = await provision(
      fixture.storeAId,
      fixture.userAId,
      creatorUserId,
      6101,
      "SequentialAStoreBot",
    );
    expect(preparedA.result.status).toBe("awaiting_confirmation");
    if (preparedA.result.status !== "awaiting_confirmation") return;

    const confirmedA = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: preparedA.result.connectionId,
      },
      { createBotApi: () => preparedA.managed! },
    );
    expect(confirmedA.status).toBe("ready");

    // The same Telegram account now creates a distinct bot for store B.
    const preparedB = await provision(
      fixture.storeBId,
      fixture.userBId,
      creatorUserId,
      6102,
      "SequentialBStoreBot",
    );

    // The regression: this must be a Store B candidate, not ambiguous.
    expect(preparedB.result.status).toBe("awaiting_confirmation");
    if (preparedB.result.status !== "awaiting_confirmation") return;

    const [pendingB] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, preparedB.result.connectionId));
    expect(pendingB.storeId).toBe(fixture.storeBId);
    expect(pendingB.status).toBe("awaiting_confirmation");
    expect(pendingB.botId).toBe(6102);

    const [stillA] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, preparedA.result.connectionId));
    expect(stillA.storeId).toBe(fixture.storeAId);
    expect(stillA.status).toBe("ready");
    expect(stillA.botId).toBe(6101);

    const confirmedB = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        connectionId: preparedB.result.connectionId,
      },
      { createBotApi: () => preparedB.managed! },
    );
    expect(confirmedB.status).toBe("ready");

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      botId: 6102,
      botUsername: "SequentialBStoreBot",
      status: "ready",
    });

    const attempts = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeBId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("completed");
    expect(attempts[0].telegramBotId).toBe(6102);
  });

  it("does not offer an unrelated managed bot from the same account as Store B's candidate", async () => {
    const creatorUserId = 7731;
    const preparedA = await provision(
      fixture.storeAId,
      fixture.userAId,
      creatorUserId,
      6131,
      "CorrelationAStoreBot",
    );
    expect(preparedA.result.status).toBe("awaiting_confirmation");
    if (preparedA.result.status !== "awaiting_confirmation") return;

    const confirmedA = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: preparedA.result.connectionId,
      },
      { createBotApi: () => preparedA.managed! },
    );
    expect(confirmedA.status).toBe("ready");

    // Store B's attempt is bound to the same Telegram account. A generic
    // managed_bot update from that account must not become B's candidate
    // because it carries no evidence that it belongs to this attempt.
    const startedB = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundB = await bindLinkAttemptToTelegramUser(db(), {
      nonce: startedB.nonce,
      telegramUserId: creatorUserId,
    });
    expect(boundB.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6132:AA-unrelated-token",
      })),
    });
    const unrelated = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6132,
        botUsername: "UnrelatedStoreBot",
        botName: "UnrelatedStoreBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6132, "UnrelatedStoreBot"),
      },
    );

    expect(unrelated.status).not.toBe("awaiting_confirmation");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const bConnections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(bConnections).toHaveLength(0);

    const [bAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeBId));
    expect(bAttempt.connectionId).toBeNull();
    expect(bAttempt.status).not.toBe("awaiting_confirmation");

    const [aConnection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(aConnection.status).toBe("ready");
    expect(aConnection.botId).toBe(6131);
  });

  it("ignores an unrelated bot while Store B is pending and verifies only B's challenged bot", async () => {
    const creatorUserId = 7741;
    const preparedA = await provision(
      fixture.storeAId,
      fixture.userAId,
      creatorUserId,
      6141,
      "ActiveAStoreBot",
    );
    expect(preparedA.result.status).toBe("awaiting_confirmation");
    if (preparedA.result.status !== "awaiting_confirmation") return;

    const confirmedA = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: preparedA.result.connectionId,
      },
      { createBotApi: () => preparedA.managed! },
    );
    expect(confirmedA.status).toBe("ready");

    const startedB = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundB = await bindLinkAttemptToTelegramUser(db(), {
      nonce: startedB.nonce,
      telegramUserId: creatorUserId,
    });
    expect(boundB.status).toBe("bound");

    const intended = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6142,
        botUsername: "IntendedBStoreBot",
        botName: "IntendedBStoreBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(intended.status).toBe("awaiting_bot_start");

    const unrelated = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6143,
        botUsername: "UnexpectedBStoreBot",
        botName: "UnexpectedBStoreBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(unrelated.status).toBe("ambiguous");

    const [stillProposed] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeBId));
    expect(stillProposed.status).toBe("provisioning");
    expect(stillProposed.failureCode).toBe("awaiting_bot_start");
    expect(stillProposed.telegramBotId).toBe(6142);
    expect(stillProposed.telegramBotUsername).toBe("IntendedBStoreBot");

    const stateB = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeBId),
      merchantUserId: fixture.userBId,
    });
    expect(stateB.state).toBe("preparing");
    if (stateB.state === "preparing") {
      expect(stateB.botUsername).toBe("IntendedBStoreBot");
      expect(stateB.verificationUrl).toContain(startedB.nonce);
    }

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6142:AA-intended-token",
      })),
    });
    const managed = botApi(6142, "IntendedBStoreBot");
    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        attemptId: intended.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: {
                    id: creatorUserId,
                    is_bot: false,
                    first_name: "Merchant",
                  },
                  chat: { id: creatorUserId, type: "private" },
                  date: 1,
                  text: `/start ${startedB.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") return;

    const [candidateB] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(candidateB).toMatchObject({
      botId: 6142,
      botUsername: "IntendedBStoreBot",
      status: "awaiting_confirmation",
    });

    const [stillReadyA] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(stillReadyA).toMatchObject({
      botId: 6141,
      status: "ready",
    });

    const confirmedB = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        connectionId: verified.connectionId,
      },
      { createBotApi: () => managed },
    );
    expect(confirmedB.status).toBe("ready");
  });

  it("accepts only the exact unexpired bot start nonce from the bound account", async () => {
    const creatorUserId = 7751;
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: creatorUserId,
    });
    expect(bound.status).toBe("bound");

    const proposal = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6144,
        botUsername: "NonceCheckStoreBot",
        botName: "NonceCheckStoreBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(proposal.status).toBe("awaiting_bot_start");
    if (proposal.status !== "awaiting_bot_start") return;

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6144:AA-nonce-token",
      })),
    });
    const managed = botApi(6144, "NonceCheckStoreBot");

    function verificationApi(updates: unknown[]) {
      return {
        ...managed,
        getWebhookInfo: vi.fn(async () => ({
          ok: true as const,
          result: { url: "" },
        })),
        getUpdates: vi.fn(async () => ({
          ok: true as const,
          result: updates,
        })),
      } as TelegramBotApiClient;
    }

    const wrongNonce = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        attemptId: proposal.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () =>
          verificationApi([
            {
              update_id: 1,
              message: {
                message_id: 1,
                from: {
                  id: creatorUserId,
                  is_bot: false,
                  first_name: "Merchant",
                },
                chat: { id: creatorUserId, type: "private" },
                date: 1,
                text: "/start stale-from-another-attempt",
              },
            },
            {
              update_id: 2,
              message: {
                message_id: 2,
                from: {
                  id: creatorUserId,
                  is_bot: false,
                  first_name: "Merchant",
                },
                chat: { id: creatorUserId, type: "private" },
                date: 1,
                text: "/start",
              },
            },
          ]),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(wrongNonce.status).toBe("pending");
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const otherAccount = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        attemptId: proposal.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () =>
          verificationApi([
            {
              update_id: 3,
              message: {
                message_id: 3,
                from: { id: 9999, is_bot: false, first_name: "Other" },
                chat: { id: 9999, type: "private" },
                date: 1,
                text: `/start ${started.nonce}`,
              },
            },
          ]),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(otherAccount.status).toBe("pending");
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const exact = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        attemptId: proposal.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () =>
          verificationApi([
            {
              update_id: 4,
              message: {
                message_id: 4,
                from: {
                  id: creatorUserId,
                  is_bot: false,
                  first_name: "Merchant",
                },
                chat: { id: creatorUserId, type: "private" },
                date: 1,
                text: `/start ${started.nonce}`,
              },
            },
            {
              update_id: 5,
              message: {
                message_id: 5,
                from: {
                  id: creatorUserId,
                  is_bot: false,
                  first_name: "Merchant",
                },
                chat: { id: creatorUserId, type: "private" },
                date: 1,
                text: `/start ${started.nonce}`,
              },
            },
          ]),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(exact.status).toBe("verified");

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      botId: 6144,
      status: "awaiting_confirmation",
    });
  });

  it("keeps a delayed replay of Store A's bot ambiguous while Store B is active", async () => {
    const creatorUserId = 7711;
    const preparedA = await provision(
      fixture.storeAId,
      fixture.userAId,
      creatorUserId,
      6111,
      "ReplayAStoreBot",
    );
    expect(preparedA.result.status).toBe("awaiting_confirmation");
    if (preparedA.result.status !== "awaiting_confirmation") return;

    const confirmedA = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: preparedA.result.connectionId,
      },
      { createBotApi: () => preparedA.managed! },
    );
    expect(confirmedA.status).toBe("ready");

    const startedB = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundB = await bindLinkAttemptToTelegramUser(db(), {
      nonce: startedB.nonce,
      telegramUserId: creatorUserId,
    });
    expect(boundB.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6111:AA-replayed-token",
      })),
    });
    const replay = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6111,
        botUsername: "ReplayAStoreBot",
        botName: "ReplayAStoreBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        createBotApi: () => preparedA.managed!,
      },
    );

    expect(replay.status).toBe("ambiguous");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const [bAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeBId));
    expect(bAttempt.status).toBe("pending");
    expect(bAttempt.connectionId).toBeNull();
    expect(bAttempt.telegramBotId).toBeNull();

    const bConnections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(bConnections).toHaveLength(0);

    const [aConnection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(aConnection.status).toBe("ready");
    expect(aConnection.botId).toBe(6111);
  });

  it("keeps Store B ambiguous when another recent attempt has no recorded bot id", async () => {
    const creatorUserId = 7721;
    const startedA = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundA = await bindLinkAttemptToTelegramUser(db(), {
      nonce: startedA.nonce,
      telegramUserId: creatorUserId,
    });
    expect(boundA.status).toBe("bound");

    await db()
      .update(telegramLinkAttempt)
      .set({ status: "failed", failureCode: "synthetic_unknown_evidence" })
      .where(eq(telegramLinkAttempt.id, startedA.attemptId));

    const startedB = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundB = await bindLinkAttemptToTelegramUser(db(), {
      nonce: startedB.nonce,
      telegramUserId: creatorUserId,
    });
    expect(boundB.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6121:AA-ambiguous-token",
      })),
    });
    const result = await handleManagedBotEvent(
      db(),
      {
        creatorUserId,
        botId: 6121,
        botUsername: "AmbiguousEvidenceBot",
        botName: "AmbiguousEvidenceBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6121, "AmbiguousEvidenceBot"),
      },
    );

    expect(result.status).toBe("ambiguous");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const bConnections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeBId));
    expect(bConnections).toHaveLength(0);
  });

  it("keeps a retryable activation failure on the same bot and recovers on retry", async () => {
    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7301,
      6003,
      "RetryStoreBot",
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const failingApi = botApi(6003, "RetryStoreBot", {
      setWebhook: vi.fn(async () => ({
        ok: false as const,
        error: "setWebhook explicitly rejected",
        errorKind: "api_error" as const,
        httpStatus: 400,
      })),
    });

    const failed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => failingApi },
    );

    expect(failed).toMatchObject({
      status: "retryable",
      reason: "webhook_registration_failed",
    });

    const retryState = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(retryState.state).toBe("confirm");
    if (retryState.state === "confirm") {
      expect(retryState.lastError).toBe("webhook_registration_failed");
    }

    const [afterFailure] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(afterFailure.status).toBe("awaiting_confirmation");

    const retried = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => prepared.managed! },
    );

    expect(retried.status).toBe("ready");
    expect(prepared.managed?.setWebhook).toHaveBeenCalledTimes(1);

    const ready = await db()
      .select()
      .from(telegramConnection)
      .where(
        and(
          eq(telegramConnection.storeId, fixture.storeAId),
          eq(telegramConnection.status, "ready"),
        ),
      );
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(prepared.result.connectionId);
    expect(ready[0].webhookUrl).toBe(prepared.managed!.getWebhookUrl());
  });

  it("revokes an unconfirmed connection when the merchant starts over, then allows one new confirmation", async () => {
    const first = await provision(
      fixture.storeAId,
      fixture.userAId,
      7351,
      6010,
      "FirstPendingBot",
    );

    expect(first.result.status).toBe("awaiting_confirmation");

    const restarted = await provision(
      fixture.storeAId,
      fixture.userAId,
      7352,
      6011,
      "SecondPendingBot",
    );

    expect(restarted.result.status).toBe("awaiting_confirmation");
    if (restarted.result.status !== "awaiting_confirmation") return;

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));

    expect(connections).toHaveLength(2);
    expect(
      connections.find((row) => row.botId === 6010)?.status,
    ).toBe("revoked");
    expect(
      connections.find((row) => row.botId === 6011)?.status,
    ).toBe("awaiting_confirmation");

    const confirmed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: restarted.result.connectionId,
      },
      { createBotApi: () => restarted.managed! },
    );
    expect(confirmed.status).toBe("ready");

    const after = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(after.filter((row) => row.status === "ready")).toHaveLength(1);
  });

  it("reconnects the same bot and store with one identity and replaces the active webhook only after confirmation", async () => {
    const first = await provision(
      fixture.storeAId,
      fixture.userAId,
      7451,
      6020,
      "ReconnectStoreBot",
    );

    expect(first.result.status).toBe("awaiting_confirmation");
    if (first.result.status !== "awaiting_confirmation") return;

    const managed = first.managed as TrackedBotApi;

    const firstConfirmation = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: first.result.connectionId,
      },
      { createBotApi: () => managed },
    );
    expect(firstConfirmation.status).toBe("ready");

    const firstUrl = managed.getWebhookUrl();
    const firstSecret = managed.getWebhookSecret();
    expect(firstUrl).toContain(`/managed/${first.result.connectionId}`);
    expect(managed.setWebhook).toHaveBeenCalledTimes(1);

    const second = await provision(
      fixture.storeAId,
      fixture.userAId,
      7451,
      6020,
      "ReconnectStoreBot",
      { managedApi: managed },
    );

    expect(second.result.status).toBe("awaiting_confirmation");
    if (second.result.status !== "awaiting_confirmation") return;
    expect(second.result.connectionId).toBe(first.result.connectionId);
    expect(managed.setWebhook).toHaveBeenCalledTimes(1);

    const [reconnecting] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, first.result.connectionId));
    expect(reconnecting.status).toBe("awaiting_confirmation");
    expect(reconnecting.webhookUrl).toBe(firstUrl);

    const secondConfirmation = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: first.result.connectionId,
      },
      { createBotApi: () => managed },
    );
    expect(secondConfirmation.status).toBe("ready");
    expect(managed.setWebhook).toHaveBeenCalledTimes(2);

    const secondUrl = managed.getWebhookUrl();
    const secondSecret = managed.getWebhookSecret();
    expect(secondUrl).not.toBe(firstUrl);
    expect(secondUrl).toContain(`/managed/${first.result.connectionId}`);
    expect(secondSecret).not.toBe(firstSecret);

    const [ready] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, first.result.connectionId));
    expect(ready.status).toBe("ready");
    expect(ready.webhookUrl).toBe(secondUrl);
    expect(ready.webhookSecretHash).toBe(hashWebhookSecret(secondSecret));
    expect(verifyWebhookSecret(firstSecret, ready.webhookSecretHash)).toBe(
      false,
    );
    expect(verifyWebhookSecret(secondSecret, ready.webhookSecretHash)).toBe(
      true,
    );
  });

  it("fails closed on a foreign webhook without mutating or deleting it", async () => {
    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7461,
      6021,
      "ForeignWebhookBot",
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const foreignUrl = "https://unrelated.example.test/hooks/foreign";
    const foreignApi = botApi(6021, "ForeignWebhookBot", {
      getWebhookInfo: vi.fn(async () => ({
        ok: true as const,
        result: { url: foreignUrl },
      })),
    });

    const result = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => foreignApi },
    );

    expect(result.status).toBe("foreign_webhook");
    expect(foreignApi.setWebhook).not.toHaveBeenCalled();
    expect(foreignApi.deleteWebhook).not.toHaveBeenCalled();
    const foreignInfo = await foreignApi.getWebhookInfo();
    expect(foreignInfo).toMatchObject({ result: { url: foreignUrl } });

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(connection.status).toBe("needs_review");
    expect(connection.webhookUrl).not.toBe(foreignUrl);

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(
        eq(
          telegramLinkAttempt.id,
          prepared.started.attemptId,
        ),
      );
    expect(attempt.status).toBe("failed");
    expect(attempt.failureCode).toBe("foreign_webhook");
  });

  it("does not persist a candidate when a verification token fetch returns after the attempt was superseded", async () => {
    const token = deferred<{ ok: true; result: string }>();
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7471,
    });
    expect(bound.status).toBe("bound");

    const proposal = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7471,
        botId: 6022,
        botUsername: "LateTokenBot",
        botName: "LateTokenBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(proposal.status).toBe("awaiting_bot_start");

    const manager = managerApi({
      getManagedBotToken: vi.fn(() => token.promise),
    });

    let created: TelegramBotApiClient | null = null;
    const pending = verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        createBotApi: () => {
          created = botApi(6022, "LateTokenBot", {
            getWebhookInfo: vi.fn(async () => ({
              ok: true as const,
              result: { url: "" },
            })),
            getUpdates: vi.fn(async () => ({
              ok: true as const,
              result: [
                {
                  update_id: 1,
                  message: {
                    message_id: 1,
                    from: { id: 7471, is_bot: false, first_name: "Merchant" },
                    chat: { id: 7471, type: "private" },
                    date: 1,
                    text: `/start ${started.nonce}`,
                  },
                },
              ],
            })),
          });
          return created;
        },
      },
    );

    await vi.waitFor(() => {
      expect(manager.getManagedBotToken).toHaveBeenCalledTimes(1);
    });

    await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    token.resolve({ ok: true, result: "6022:AA-managed-token" });

    const result = await pending;
    expect(result.status).toBe("conflict");
    expect(created?.setWebhook).not.toHaveBeenCalled();

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connections).toHaveLength(0);
  });

  it("does not activate a cancelled attempt when webhook registration returns late and never deletes the webhook it set", async () => {
    const setWebhook = deferred<{ ok: true; result: true }>();
    let currentWebhookUrl = "";
    const managed = botApi(6023, "LateActivationBot");
    managed.setWebhook = vi.fn((input: { url: string }) => {
      currentWebhookUrl = input.url;
      return setWebhook.promise;
    });
    managed.getWebhookInfo = vi.fn(async () => ({
      ok: true as const,
      result: { url: currentWebhookUrl },
    }));
    managed.deleteWebhook = vi.fn(async () => {
      currentWebhookUrl = "";
      return { ok: true as const, result: true as const };
    });

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7481,
      6023,
      "LateActivationBot",
      { managedApi: managed },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const pending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => managed },
    );

    await vi.waitFor(() => {
      expect(managed.setWebhook).toHaveBeenCalledTimes(1);
    });

    await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    // The fake stores the activation URL only after the call resolves.
    setWebhook.resolve({ ok: true, result: true });

    const result = await pending;
    expect(result.status).toBe("superseded");

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(connection.status).not.toBe("ready");
    expect(currentWebhookUrl).toContain("?v=");
    expect(managed.deleteWebhook).not.toHaveBeenCalled();
  });

  it("does not activate an expired attempt when webhook registration returns late", async () => {
    const setWebhook = deferred<{ ok: true; result: true }>();
    let currentWebhookUrl = "";
    const managed = botApi(6024, "ExpiredActivationBot");
    managed.setWebhook = vi.fn((input: { url: string }) => {
      currentWebhookUrl = input.url;
      return setWebhook.promise;
    });
    managed.getWebhookInfo = vi.fn(async () => ({
      ok: true as const,
      result: { url: currentWebhookUrl },
    }));
    managed.deleteWebhook = vi.fn(async () => {
      currentWebhookUrl = "";
      return { ok: true as const, result: true as const };
    });

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7491,
      6024,
      "ExpiredActivationBot",
      { managedApi: managed },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const pending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => managed },
    );

    await vi.waitFor(() => {
      expect(managed.setWebhook).toHaveBeenCalledTimes(1);
    });

    await db()
      .update(telegramLinkAttempt)
      .set({ expiresAt: new Date(Date.now() + 10) })
      .where(eq(telegramLinkAttempt.id, prepared.started.attemptId));

    await new Promise((resolve) => setTimeout(resolve, 50));
    setWebhook.resolve({ ok: true, result: true });

    const result = await pending;
    expect(result.status).toBe("expired");

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(connection.status).toBe("revoked");
    expect(currentWebhookUrl).toContain("?v=");
    expect(managed.deleteWebhook).not.toHaveBeenCalled();
  });

  it("prevents an older activation from mutating or releasing a newer successful same-bot activation", async () => {
    const oldApi = botApi(6030, "StaleActivationBot");
    const oldInfo = deferred<{ ok: true; result: { url: string } }>();
    oldApi.getWebhookInfo = vi.fn(() => oldInfo.promise);

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7531,
      6030,
      "StaleActivationBot",
      { managedApi: oldApi },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const oldPending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => oldApi },
    );

    await vi.waitFor(() => {
      expect(oldApi.getWebhookInfo).toHaveBeenCalledTimes(1);
    });

    const newApi = botApi(6030, "StaleActivationBot");
    const replacement = await provision(
      fixture.storeAId,
      fixture.userAId,
      7531,
      6030,
      "StaleActivationBot",
      { managedApi: newApi },
    );

    expect(replacement.result.status).toBe("awaiting_confirmation");
    if (replacement.result.status !== "awaiting_confirmation") return;

    const busy = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: replacement.result.connectionId,
      },
      { createBotApi: () => newApi },
    );
    expect(busy.status).toBe("conflict");

    await db()
      .update(telegramConnection)
      .set({ webhookOperationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramConnection.id, replacement.result.connectionId));

    const newConfirmation = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: replacement.result.connectionId,
      },
      { createBotApi: () => newApi },
    );
    expect(newConfirmation.status).toBe("ready");

    oldInfo.resolve({ ok: true, result: { url: "" } });
    const stale = await oldPending;
    expect(stale.status === "retryable" || stale.status === "superseded").toBe(
      true,
    );
    expect(oldApi.setWebhook).not.toHaveBeenCalled();

    const [winner] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, replacement.result.connectionId));
    expect(winner.status).toBe("ready");
    expect(winner.webhookUrl).toBe(newApi.getWebhookUrl());
    expect(winner.webhookSecretHash).toBe(
      hashWebhookSecret(newApi.getWebhookSecret()),
    );
    expect(winner.webhookOperationId).toBeNull();

    const [staleAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, prepared.started.attemptId));
    expect(staleAttempt.status).toBe("cancelled");
  });

  it("prevents a stale terminal decision from changing a newer ready connection", async () => {
    const oldApi = botApi(6032, "ForeignRaceBot");
    const oldInfo = deferred<{
      ok: true;
      result: { url: string };
    }>();
    oldApi.getWebhookInfo = vi.fn(() => oldInfo.promise);

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7541,
      6032,
      "ForeignRaceBot",
      { managedApi: oldApi },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const oldPending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => oldApi },
    );

    await vi.waitFor(() => {
      expect(oldApi.getWebhookInfo).toHaveBeenCalledTimes(1);
    });

    const newApi = botApi(6032, "ForeignRaceBot");
    const replacement = await provision(
      fixture.storeAId,
      fixture.userAId,
      7541,
      6032,
      "ForeignRaceBot",
      { managedApi: newApi },
    );
    expect(replacement.result.status).toBe("awaiting_confirmation");
    if (replacement.result.status !== "awaiting_confirmation") return;

    const busy = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: replacement.result.connectionId,
      },
      { createBotApi: () => newApi },
    );
    expect(busy.status).toBe("conflict");

    await db()
      .update(telegramConnection)
      .set({ webhookOperationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramConnection.id, replacement.result.connectionId));

    const newConfirmation = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: replacement.result.connectionId,
      },
      { createBotApi: () => newApi },
    );
    expect(newConfirmation.status).toBe("ready");

    oldInfo.resolve({
      ok: true,
      result: { url: "https://foreign.example.test/test-hook" },
    });
    const stale = await oldPending;
    expect(stale.status).toBe("foreign_webhook");
    expect(oldApi.setWebhook).not.toHaveBeenCalled();
    expect(oldApi.deleteWebhook).not.toHaveBeenCalled();

    const [winner] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, replacement.result.connectionId));
    expect(winner.status).toBe("ready");
    expect(winner.webhookUrl).toBe(newApi.getWebhookUrl());
    expect(winner.webhookSecretHash).toBe(
      hashWebhookSecret(newApi.getWebhookSecret()),
    );
  });

  it("recovers an abandoned activation claim after its lease expires", async () => {
    const oldApi = botApi(6033, "AbandonedClaimBot");
    const oldInfo = deferred<{ ok: true; result: { url: string } }>();
    oldApi.getWebhookInfo = vi.fn(() => oldInfo.promise);

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7551,
      6033,
      "AbandonedClaimBot",
      { managedApi: oldApi },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const oldPending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => oldApi },
    );

    await vi.waitFor(() => {
      expect(oldApi.getWebhookInfo).toHaveBeenCalledTimes(1);
    });

    await db()
      .update(telegramConnection)
      .set({ webhookOperationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramConnection.id, prepared.result.connectionId));

    const recoveryApi = botApi(6033, "AbandonedClaimBot");
    const recovered = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => recoveryApi },
    );

    expect(recovered.status).toBe("ready");

    oldInfo.resolve({ ok: true, result: { url: "" } });
    const stale = await oldPending;
    expect(stale.status === "retryable" || stale.status === "superseded").toBe(
      true,
    );
    expect(oldApi.setWebhook).not.toHaveBeenCalled();

    const [winner] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(winner.status).toBe("ready");
    expect(winner.webhookUrl).toBe(recoveryApi.getWebhookUrl());
    expect(winner.webhookSecretHash).toBe(
      hashWebhookSecret(recoveryApi.getWebhookSecret()),
    );
  });

  it("allows only one concurrent confirmation to mutate the webhook", async () => {
    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7561,
      6034,
      "ConcurrentConfirmBot",
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const apiOne = botApi(6034, "ConcurrentConfirmBot");
    const apiTwo = botApi(6034, "ConcurrentConfirmBot");
    const firstInfo = deferred<{ ok: true; result: { url: string } }>();
    let firstInspection = true;
    apiOne.getWebhookInfo = vi.fn(() => {
      if (firstInspection) {
        firstInspection = false;
        return firstInfo.promise;
      }

      return Promise.resolve({
        ok: true as const,
        result: { url: apiOne.getWebhookUrl() },
      });
    });

    const onePending = confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => apiOne },
    );

    await vi.waitFor(() => {
      expect(apiOne.getWebhookInfo).toHaveBeenCalledTimes(1);
    });

    const two = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => apiTwo },
    );
    expect(two.status).toBe("conflict");

    firstInfo.resolve({ ok: true, result: { url: "" } });
    const one = await onePending;
    expect(one.status).toBe("ready");
    const totalSetWebhookCalls =
      (apiOne.setWebhook as ReturnType<typeof vi.fn>).mock.calls.length +
      (apiTwo.setWebhook as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(totalSetWebhookCalls).toBe(1);

    const [winner] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(winner.status).toBe("ready");
    expect(winner.webhookOperationId).toBeNull();
  });

  it("keeps an ambiguous setWebhook timeout in review, blocks same-bot retries, and leaves another store usable", async () => {
    const timedOutApi = botApi(6050, "UncertainTimeoutBot");
    let pendingUrl = "";
    let currentUrl = "";

    timedOutApi.setWebhook = vi.fn(
      async (input: { url: string; secretToken: string }) => {
        pendingUrl = input.url;
        return {
          ok: false as const,
          error: "Telegram request timed out",
          errorKind: "timeout" as const,
        };
      },
    );
    timedOutApi.getWebhookInfo = vi.fn(async () => ({
      ok: true as const,
      result: { url: currentUrl },
    }));

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7571,
      6050,
      "UncertainTimeoutBot",
      { managedApi: timedOutApi },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const result = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => timedOutApi },
    );

    expect(result.status).toBe("review");
    expect(timedOutApi.setWebhook).toHaveBeenCalledTimes(1);
    expect(timedOutApi.deleteWebhook).not.toHaveBeenCalled();

    const [reviewedConnection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(reviewedConnection.status).toBe("needs_review");

    const [reviewedAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, prepared.started.attemptId));
    expect(reviewedAttempt.status).toBe("failed");
    expect(reviewedAttempt.failureCode).toBe("webhook_outcome_unknown");

    const reviewState = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(reviewState).toEqual({
      state: "failed",
      reason: "webhook_outcome_unknown",
      retryable: false,
    });

    // Model the old request applying after its transport result was lost.
    currentUrl = pendingUrl;
    expect(currentUrl).toContain(`?v=${prepared.started.attemptId}`);

    const [stillReviewed] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(stillReviewed.status).toBe("needs_review");

    // Start Over / reconnect for the same bot is blocked without a mutation.
    const blockedApi = botApi(6050, "UncertainTimeoutBot");
    const blocked = await provision(
      fixture.storeAId,
      fixture.userAId,
      7571,
      6050,
      "UncertainTimeoutBot",
      { managedApi: blockedApi },
    );
    expect(blocked.result.status).toBe("bot_review");
    expect(blockedApi.setWebhook).not.toHaveBeenCalled();

    await db()
      .update(telegramConnection)
      .set({ webhookOperationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramConnection.id, prepared.result.connectionId));

    const stillBlocked = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => blockedApi },
    );
    expect(stillBlocked.status).toBe("conflict");
    expect(blockedApi.setWebhook).not.toHaveBeenCalled();

    // A different store/bot is unaffected.
    const otherApi = botApi(6051, "IndependentStoreBot");
    const otherPrepared = await provision(
      fixture.storeBId,
      fixture.userBId,
      7572,
      6051,
      "IndependentStoreBot",
      { managedApi: otherApi },
    );
    expect(otherPrepared.result.status).toBe("awaiting_confirmation");
    if (otherPrepared.result.status !== "awaiting_confirmation") return;

    const otherConfirmed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        connectionId: otherPrepared.result.connectionId,
      },
      { createBotApi: () => otherApi },
    );
    expect(otherConfirmed.status).toBe("ready");
    expect(otherApi.setWebhook).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful setWebhook response followed by failed verification in review", async () => {
    const api = botApi(6052, "VerificationUncertainBot");
    let call = 0;
    api.getWebhookInfo = vi.fn(async () => {
      call += 1;

      if (call === 1) {
        return { ok: true as const, result: { url: "" } };
      }

      return {
        ok: false as const,
        error: "verification unavailable",
        errorKind: "timeout" as const,
      };
    });

    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7581,
      6052,
      "VerificationUncertainBot",
      { managedApi: api },
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    const result = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
      },
      { createBotApi: () => api },
    );

    expect(result.status).toBe("review");
    expect(api.setWebhook).toHaveBeenCalledTimes(1);
    expect(api.deleteWebhook).not.toHaveBeenCalled();

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(connection.status).toBe("needs_review");
    expect(connection.webhookOperationId).not.toBeNull();

    const [attempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, prepared.started.attemptId));
    expect(attempt.status).toBe("failed");
    expect(attempt.failureCode).toBe("webhook_outcome_unknown");
  });

  it("rejects missing and invalid webhook secrets before claiming an update", async () => {
    const connectionId = await seedReadyConnection({
      storeId: fixture.storeAId,
      botId: 6101,
      botUsername: "SecretStoreBot",
      secret: "correct-secret",
    });
    const transport = createFakeTelegramTransport();

    const missing = await handleManagedTelegramWebhookRequest(
      webhookRequest({
        update_id: 100,
        message: {
          message_id: 1,
          from: { id: 1, is_bot: false, first_name: "Customer" },
          chat: { id: 1, type: "private" },
          date: 1,
          text: "/start",
        },
      }),
      connectionId,
      { db: appDb(), transport },
    );
    expect(missing.status).toBe(401);

    const invalid = await handleManagedTelegramWebhookRequest(
      webhookRequest(
        {
          update_id: 101,
          message: {
            message_id: 1,
            from: { id: 1, is_bot: false, first_name: "Customer" },
            chat: { id: 1, type: "private" },
            date: 1,
            text: "/start",
          },
        },
        "wrong-secret",
      ),
      connectionId,
      { db: appDb(), transport },
    );
    expect(invalid.status).toBe(401);

    expect(transport.sentMessages).toHaveLength(0);
    expect(await db().select().from(telegramManagedUpdate)).toHaveLength(0);

    const unknown = await handleManagedTelegramWebhookRequest(
      webhookRequest({ update_id: 102 }, "correct-secret"),
      crypto.randomUUID(),
      { db: appDb(), transport },
    );
    expect(unknown.status).toBe(404);
  });

  it("serves only the connected store catalog and isolates update dedup by bot id", async () => {
    const connectionA = await seedReadyConnection({
      storeId: fixture.storeAId,
      botId: 6201,
      botUsername: "CatalogAStoreBot",
      secret: "secret-a",
    });
    const connectionB = await seedReadyConnection({
      storeId: fixture.storeBId,
      botId: 6202,
      botUsername: "CatalogBStoreBot",
      secret: "secret-b",
    });
    const transportA = createFakeTelegramTransport();
    const transportB = createFakeTelegramTransport();

    const startUpdate = {
      update_id: 777,
      message: {
        message_id: 10,
        from: { id: 5001, is_bot: false, first_name: "Customer A" },
        chat: { id: 5001, type: "private" },
        date: 1,
        text: "/start",
      },
    };

    const a = await handleManagedTelegramWebhookRequest(
      webhookRequest(startUpdate, "secret-a"),
      connectionA,
      { db: appDb(), transport: transportA },
    );
    expect(a.status).toBe(200);

    const b = await handleManagedTelegramWebhookRequest(
      webhookRequest(startUpdate, "secret-b"),
      connectionB,
      { db: appDb(), transport: transportB },
    );
    expect(b.status).toBe(200);

    const textA = transportA.sentMessages
      .flatMap((message) => [
        message.text,
        ...(message.replyMarkup?.inline_keyboard.flat() ?? []).map(
          (button) => button.text,
        ),
      ])
      .join("\n");
    const textB = transportB.sentMessages
      .flatMap((message) => [
        message.text,
        ...(message.replyMarkup?.inline_keyboard.flat() ?? []).map(
          (button) => button.text,
        ),
      ])
      .join("\n");

    expect(textA).toContain("Managed Store A");
    expect(textA).toContain("A One");
    expect(textA).toContain("A Two");
    expect(textA).not.toContain("B Only");
    expect(textA).not.toContain("A Draft");
    expect(textA).not.toContain("A Deleted");
    expect(textA).not.toContain("A Hidden");

    expect(textB).toContain("Managed Store B");
    expect(textB).toContain("B Only");
    expect(textB).not.toContain("A One");
    expect(textB).not.toContain("A Two");

    const replay = await handleManagedTelegramWebhookRequest(
      webhookRequest(startUpdate, "secret-a"),
      connectionA,
      { db: appDb(), transport: transportA },
    );
    expect(await replay.json()).toEqual({
      ok: true,
      status: "already_processed",
    });
    expect(transportA.sentMessages).toHaveLength(1);

    const rows = await db().select().from(telegramManagedUpdate);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.botId).sort()).toEqual([6201, 6202]);
  });

  it("rejects a foreign product or category callback inside the verified store scope", async () => {
    const connectionA = await seedReadyConnection({
      storeId: fixture.storeAId,
      botId: 6301,
      botUsername: "ScopedAStoreBot",
      secret: "secret-a",
    });
    const connectionB = await seedReadyConnection({
      storeId: fixture.storeBId,
      botId: 6302,
      botUsername: "ScopedBStoreBot",
      secret: "secret-b",
    });
    const transportB = createFakeTelegramTransport();

    const callbackUpdate = (updateId: number, data: string) => ({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 5002, is_bot: false, first_name: "Customer B" },
        message: {
          message_id: 20,
          chat: { id: 5002, type: "private" },
          date: 1,
        },
        data,
      },
    });

    const foreignProduct = await handleManagedTelegramWebhookRequest(
      webhookRequest(callbackUpdate(801, `p:${fixture.productAOneId}`), "secret-b"),
      connectionB,
      { db: appDb(), transport: transportB },
    );
    expect(foreignProduct.status).toBe(200);
    const editedProduct = transportB.editedMessages.at(-1)?.text ?? "";
    expect(editedProduct).toContain("not available in this store");
    expect(editedProduct).not.toContain("A One");

    const foreignCategory = await handleManagedTelegramWebhookRequest(
      webhookRequest(callbackUpdate(802, `sc:${fixture.categoryAId}`), "secret-b"),
      connectionB,
      { db: appDb(), transport: transportB },
    );
    expect(foreignCategory.status).toBe(200);
    expect(transportB.editedMessages.at(-1)?.text).toContain(
      "not available in this store",
    );

    const draftProduct = await handleManagedTelegramWebhookRequest(
      webhookRequest(callbackUpdate(803, `p:${fixture.productADraftId}`), "secret-a"),
      connectionA,
      { db: appDb(), transport: createFakeTelegramTransport() },
    );
    expect(draftProduct.status).toBe(200);

    const transportA = createFakeTelegramTransport();
    const ownProduct = await handleManagedTelegramWebhookRequest(
      webhookRequest(callbackUpdate(804, `p:${fixture.productAOneId}`), "secret-a"),
      connectionA,
      { db: appDb(), transport: transportA },
    );
    expect(ownProduct.status).toBe(200);
    expect(transportA.editedMessages.at(-1)?.text).toContain("A One");
  });

  it("does not serve a suspended or inactive store and never reveals a connection id", async () => {
    const connectionA = await seedReadyConnection({
      storeId: fixture.storeAId,
      botId: 6401,
      botUsername: "InactiveAStoreBot",
      secret: "secret-a",
    });

    await db()
      .update(store)
      .set({ status: "onboarding" })
      .where(eq(store.id, fixture.storeAId));

    const response = await handleManagedTelegramWebhookRequest(
      webhookRequest({ update_id: 901 }, "secret-a"),
      connectionA,
      { db: appDb(), transport: createFakeTelegramTransport() },
    );
    expect(response.status).toBe(404);

    const resolved = await readReadyManagedConnection(appDb(), connectionA);
    expect(resolved).toBeNull();

    await db()
      .update(store)
      .set({ status: "active" })
      .where(eq(store.id, fixture.storeAId));
  });
});


describe.skipIf(!shouldRun)("managed bot start and recovery", () => {
  function managerRequest(body: unknown, secret = "manager-secret"): Request {
    return new Request("https://app.example.test/api/telegram/manager/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(body),
    });
  }

  function managedBotUpdate(
    updateId: number,
    creatorUserId: number,
    botId: number,
    username: string,
  ) {
    return {
      update_id: updateId,
      managed_bot: {
        user: { id: creatorUserId, is_bot: false, first_name: "Merchant" },
        bot: {
          id: botId,
          is_bot: true,
          first_name: username,
          username,
        },
      },
    };
  }

  it("reuses the live attempt and protects a verified candidate from a stale Create tap", async () => {
    const first = await ensureTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    const second = await ensureTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    expect(second.status).toBe("reused");
    if (second.status !== "reused") return;
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.nonce).toBe(first.nonce);

    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: first.nonce,
      telegramUserId: 7501,
    });
    expect(bound.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6101:AA-managed-token",
      })),
    });
    const managed = botApi(6101, "IdempotentBot");

    const proposal = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7501,
        botId: 6101,
        botUsername: "IdempotentBot",
        botName: "IdempotentBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(proposal.status).toBe("awaiting_bot_start");
    if (proposal.status !== "awaiting_bot_start") return;

    const preparing = await ensureTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    expect(preparing.status).toBe("preparing");
    if (preparing.status !== "preparing") return;
    expect(preparing.botUsername).toBe("IdempotentBot");
    expect(preparing.verificationUrl).toContain(first.nonce);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: proposal.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7501, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7501, type: "private" },
                  date: 1,
                  text: `/start ${first.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") return;

    const candidate = await ensureTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    expect(candidate.status).toBe("candidate");
    if (candidate.status !== "candidate") return;
    expect(candidate.connectionId).toBe(verified.connectionId);
    expect(candidate.botUsername).toBe("IdempotentBot");

    const attempts = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.storeId, fixture.storeAId));
    expect(attempts).toHaveLength(1);

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
  });

  it("recovers a verified bot after a stale creation superseded its attempt", async () => {
    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7511,
      6111,
      "RecoveredBot",
    );

    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    const [revoked] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.id, prepared.result.connectionId));
    expect(revoked.status).toBe("revoked");

    const recoverable = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(recoverable.state).toBe("recoverable");
    if (recoverable.state !== "recoverable") return;
    expect(recoverable.botUsername).toBe("RecoveredBot");
    expect(recoverable.connectionId).toBe(prepared.result.connectionId);

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6111:AA-managed-token",
      })),
    });
    const managed = botApi(6111, "RecoveredBot");

    const recovered = await recoverManagedTelegramCandidate(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: prepared.result.connectionId,
        attemptId: prepared.result.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => managed,
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") return;
    expect(recovered.botUsername).toBe("RecoveredBot");
    expect(manager.getManagedBotToken).toHaveBeenCalledWith(6111);

    const confirmState = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(confirmState.state).toBe("confirm");
    if (confirmState.state !== "confirm") return;
    expect(confirmState.connectionId).toBe(prepared.result.connectionId);
    expect(confirmState.botName).toBe("RecoveredBot");

    const confirmed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: recovered.connectionId,
      },
      { createBotApi: () => managed },
    );
    expect(confirmed.status).toBe("ready");

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connections).toHaveLength(1);
    expect(connections[0].botId).toBe(6111);
    expect(connections[0].status).toBe("ready");

    const stateB = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeBId),
      merchantUserId: fixture.userBId,
    });
    expect(stateB).toEqual({ state: "not_connected" });
  });

  it("does not recover a bot through another store's connection", async () => {
    const prepared = await provision(
      fixture.storeAId,
      fixture.userAId,
      7521,
      6121,
      "OwnedByA",
    );
    expect(prepared.result.status).toBe("awaiting_confirmation");
    if (prepared.result.status !== "awaiting_confirmation") return;

    await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6121:AA-managed-token",
      })),
    });

    const recovered = await recoverManagedTelegramCandidate(
      db(),
      {
        storeId: fixture.storeBId,
        merchantUserId: fixture.userBId,
        connectionId: prepared.result.connectionId,
        attemptId: prepared.result.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => botApi(6121, "OwnedByA"),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(recovered.status).toBe("not_found");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
  });

  it("does not promote a late managed_bot event after expiry into recovery evidence", async () => {
    const startedAt = new Date(Date.now() - 20 * 60 * 1000);
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
      now: startedAt,
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7531,
      now: startedAt,
    });
    expect(bound.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6131:AA-managed-token",
      })),
    });

    const late = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(60, 7531, 6131, "LateBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6131, "LateBot"),
      },
    );
    expect(late.status).toBe(200);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const [expiredAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(expiredAttempt.status).toBe("expired");
    expect(expiredAttempt.failureCode).toBe("created_after_expiry");
    expect(expiredAttempt.telegramBotId).toBeNull();
    expect(expiredAttempt.telegramBotUsername).toBeNull();

    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const state = await readMerchantTelegramConnectionState(appDb(), {
      scope: await scope(fixture.storeAId),
      merchantUserId: fixture.userAId,
    });
    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.reason).toBe("expired");
    }

    const recovered = await recoverManagedTelegramCandidate(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => botApi(6131, "LateBot"),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(recovered.status).toBe("not_found");
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
  });

  it("expires an unverified proposal and retries with one verified connection", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7532,
    });
    expect(bound.status).toBe("bound");

    const firstProposal = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7532,
        botId: 6132,
        botUsername: "ExpiredProposalBot",
        botName: "ExpiredProposalBot",
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(firstProposal.status).toBe("awaiting_bot_start");

    await db()
      .update(telegramLinkAttempt)
      .set({
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1000),
      })
      .where(eq(telegramLinkAttempt.id, started.attemptId));

    const expiredVerify = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: managerApi(),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(expiredVerify.status).toBe("expired");
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const retried = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const rebound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: retried.nonce,
      telegramUserId: 7532,
    });
    expect(rebound.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6133:AA-managed-token",
      })),
    });
    const managed = botApi(6133, "RetriedProposalBot");

    const secondProposal = await handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7532,
        botId: 6133,
        botUsername: "RetriedProposalBot",
        botName: "RetriedProposalBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(secondProposal.status).toBe("awaiting_bot_start");
    if (secondProposal.status !== "awaiting_bot_start") return;

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: secondProposal.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7532, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7532, type: "private" },
                  date: 1,
                  text: `/start ${retried.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") return;

    const confirmed = await confirmTelegramConnection(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        connectionId: verified.connectionId,
      },
      { createBotApi: () => managed },
    );
    expect(confirmed.status).toBe("ready");

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      botId: 6133,
      botUsername: "RetriedProposalBot",
      status: "ready",
    });
  });
});

describe.skipIf(!shouldRun)("manager bot webhook", () => {
  function managerRequest(body: unknown, secret = "manager-secret"): Request {
    return new Request("https://app.example.test/api/telegram/manager/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(body),
    });
  }

  function startUpdate(updateId: number, nonce: string, userId = 7401) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: userId, is_bot: false, first_name: "Merchant" },
        chat: { id: userId, type: "private" },
        date: 1,
        text: `/start ${nonce}`,
      },
    };
  }

  function managedBotUpdate(
    updateId: number,
    creatorUserId: number,
    botId: number,
    username: string,
  ) {
    return {
      update_id: updateId,
      managed_bot: {
        user: { id: creatorUserId, is_bot: false, first_name: "Merchant" },
        bot: {
          id: botId,
          is_bot: true,
          first_name: username,
          username,
        },
      },
    };
  }

  it("authenticates the manager endpoint and never claims before authentication", async () => {
    const transport = createFakeTelegramTransport();
    const unauthorized = await handleManagerTelegramWebhookRequest(
      managerRequest(startUpdate(1, "nonce"), "wrong-secret"),
      {
        db: db(),
        transport,
        managerApi: managerApi(),
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(await db().select().from(telegramManagedUpdate)).toHaveLength(0);

    const missingConfig = await handleManagerTelegramWebhookRequest(
      managerRequest(startUpdate(2, "nonce")),
      { db: db(), transport, managerApi: managerApi(), managerBotId: 9001 },
    );
    expect(missingConfig.status).toBe(503);
    expect(await db().select().from(telegramManagedUpdate)).toHaveLength(0);
  });

  it("binds the Telegram creator from /start and provisions only after the manager event", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const transport = createFakeTelegramTransport();
    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6501:AA-managed-token",
      })),
    });
    let webhookUrl = "";
    const managed = botApi(6501, "FlowStoreBot", {
      setWebhook: vi.fn(async (input: { url: string }) => {
        webhookUrl = input.url;
        return { ok: true as const, result: true as const };
      }),
      getWebhookInfo: vi.fn(async () => ({
        ok: true as const,
        result: { url: webhookUrl },
      })),
    });

    const start = await handleManagerTelegramWebhookRequest(
      managerRequest(startUpdate(10, started.nonce, 7401)),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );

    expect(start.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(1);
    const button = transport.sentMessages[0].replyMarkup?.inline_keyboard[0][0];
    expect(button?.url).toContain("https://t.me/newbot/RabetManagerBot/");
    expect(button?.url).not.toContain(started.nonce);

    const [boundAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(boundAttempt.telegramUserId).toBe(7401);

    const replay = await handleManagerTelegramWebhookRequest(
      managerRequest(startUpdate(10, started.nonce, 7401)),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(await replay.json()).toEqual({
      ok: true,
      status: "already_processed",
    });
    expect(transport.sentMessages).toHaveLength(1);

    const event = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(11, 7401, 6501, "FlowStoreBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(event.status).toBe(200);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const [proposal] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(proposal.status).toBe("provisioning");
    expect(proposal.failureCode).toBe("awaiting_bot_start");
    expect(proposal.telegramBotId).toBe(6501);
    expect(proposal.telegramBotUsername).toBe("FlowStoreBot");
    expect(proposal.connectionId).toBeNull();

    expect(
      await db()
        .select()
        .from(telegramConnection)
        .where(eq(telegramConnection.storeId, fixture.storeAId)),
    ).toHaveLength(0);
    expect(transport.sentMessages).toHaveLength(2);
    const challenge =
      transport.sentMessages[1].replyMarkup?.inline_keyboard[0][0];
    expect(challenge?.url).toContain("https://t.me/FlowStoreBot?start=");
    expect(challenge?.url).toContain(started.nonce);

    const duplicateEvent = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(12, 7401, 6501, "FlowStoreBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(duplicateEvent.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(2);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7401, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7401, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    expect(manager.getManagedBotToken).toHaveBeenCalledWith(6501);

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botUsername).toBe("FlowStoreBot");
    expect(managed.setWebhook).not.toHaveBeenCalled();

    const connections = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connections).toHaveLength(1);
  });

  it("keeps a transient token failure retryable without requiring a new bot", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7411,
    });
    expect(bound.status).toBe("bound");

    const failingManager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: false as const,
        error: "temporary Telegram failure",
      })),
    });

    const first = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(13, 7411, 6511, "RetryableEventBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: failingManager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(first.status).toBe(200);

    const retryable = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: failingManager,
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(retryable).toMatchObject({
      status: "retryable",
      reason: "token_fetch_failed",
    });

    const [retryableAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(retryableAttempt.status).toBe("provisioning");
    expect(retryableAttempt.failureCode).toBe("awaiting_bot_start");
    expect(
      await db().select().from(telegramConnection),
    ).toHaveLength(0);

    const successManager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6511:AA-managed-token",
      })),
    });
    const managed = botApi(6511, "RetryableEventBot");

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: successManager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7411, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7411, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");

    const [candidate] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(candidate.status).toBe("awaiting_confirmation");
    expect(candidate.botId).toBe(6511);
    expect(managed.setWebhook).not.toHaveBeenCalled();
  });

  it("reclaims an abandoned provisioning claim instead of acknowledging it", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7541,
    });
    expect(bound.status).toBe("bound");

    await db()
      .update(telegramLinkAttempt)
      .set({
        status: "provisioning",
        telegramBotId: 6141,
        telegramBotUsername: "StaleBot",
        telegramBotName: "StaleBot",
        updatedAt: new Date(),
      })
      .where(eq(telegramLinkAttempt.id, started.attemptId));

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6141:AA-managed-token",
      })),
    });

    const first = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(70, 7541, 6141, "StaleBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6141, "StaleBot"),
      },
    );
    expect(first.status).toBe(500);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    await db().execute(
      sql`alter table "telegram_link_attempt" disable trigger "telegram_link_attempt_touch_updated_at"`,
    );
    await db()
      .update(telegramLinkAttempt)
      .set({ updatedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    await db().execute(
      sql`alter table "telegram_link_attempt" enable trigger "telegram_link_attempt_touch_updated_at"`,
    );

    const second = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(71, 7541, 6141, "StaleBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6141, "StaleBot"),
      },
    );
    expect(second.status).toBe(200);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();

    const [reclaimed] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(reclaimed.status).toBe("provisioning");
    expect(reclaimed.failureCode).toBe("awaiting_bot_start");
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...botApi(6141, "StaleBot"),
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7541, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7541, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    expect(manager.getManagedBotToken).toHaveBeenCalledWith(6141);

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botId).toBe(6141);
  });

  it("never auto-links a late event across stores for the same Telegram account", async () => {
    const earlierStoreA = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundA = await bindLinkAttemptToTelegramUser(db(), {
      nonce: earlierStoreA.nonce,
      telegramUserId: 7551,
    });
    expect(boundA.status).toBe("bound");
    await db()
      .update(telegramLinkAttempt)
      .set({ status: "cancelled", failureCode: "superseded" })
      .where(eq(telegramLinkAttempt.id, earlierStoreA.attemptId));

    const activeStoreB = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeBId,
      merchantUserId: fixture.userBId,
      managerBotUsername: "RabetManagerBot",
    });
    const boundB = await bindLinkAttemptToTelegramUser(db(), {
      nonce: activeStoreB.nonce,
      telegramUserId: 7551,
    });
    expect(boundB.status).toBe("bound");

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6151:AA-managed-token",
      })),
    });

    const response = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(80, 7551, 6151, "CrossStoreBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6151, "CrossStoreBot"),
      },
    );

    expect(response.status).toBe(200);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const [stillActive] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, activeStoreB.attemptId));
    expect(stillActive.status).toBe("pending");
  });

  it("does not link a managed bot event from an unbound Telegram actor and does not acknowledge it", async () => {
    const manager = managerApi();
    const response = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(20, 7999, 6601, "UnknownActorBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
      },
    );

    expect(response.status).toBe(500);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const [update] = await db().select().from(telegramManagedUpdate);
    expect(update.status).toBe("failed");
  });

  it("reconciles an event that arrived before the Telegram binding became visible", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6521:AA-managed-token",
      })),
    });
    const managed = botApi(6521, "EarlyEventBot");

    const early = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(30, 7421, 6521, "EarlyEventBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(early.status).toBe(500);
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const start = await handleManagerTelegramWebhookRequest(
      managerRequest(startUpdate(31, started.nonce, 7421)),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(start.status).toBe(200);

    const retry = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(30, 7421, 6521, "EarlyEventBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(retry.status).toBe(200);

    const [proposal] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(proposal.status).toBe("provisioning");
    expect(proposal.failureCode).toBe("awaiting_bot_start");
    expect(proposal.telegramBotId).toBe(6521);
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7421, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7421, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botId).toBe(6521);
    expect(managed.setWebhook).not.toHaveBeenCalled();
  });

  it("notifies the authorized Telegram chat once with the real bot identity and return button", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7431,
    });
    expect(bound.status).toBe("bound");

    const transport = createFakeTelegramTransport();
    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6531:AA-managed-token",
      })),
    });
    const managed = botApi(6531, "CustomNameBot", {
      getMe: vi.fn(async () => ({
        ok: true as const,
        result: {
          id: 6531,
          is_bot: true,
          first_name: "Custom Name Bot",
          username: "CustomNameBot",
        },
      })),
    });

    const first = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(40, 7431, 6531, "CustomNameBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(first.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(1);

    const challenge = transport.sentMessages[0];
    expect(challenge.chatId).toBe(7431);
    expect(challenge.text).toContain("@CustomNameBot");
    expect(challenge.replyMarkup?.inline_keyboard[0][0]?.url).toContain(
      "https://t.me/CustomNameBot?start=",
    );
    expect(challenge.replyMarkup?.inline_keyboard[0][0]?.url).toContain(
      started.nonce,
    );

    const duplicate = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(41, 7431, 6531, "CustomNameBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(duplicate.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(1);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        createBotApi: () => ({
          ...managed,
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7431, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7431, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        transport,
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    expect(transport.sentMessages).toHaveLength(2);

    const notification = transport.sentMessages[1];
    expect(notification.chatId).toBe(7431);
    expect(notification.text).toContain("Custom Name Bot");
    expect(notification.text).toContain("@CustomNameBot");
    expect(notification.replyMarkup?.inline_keyboard[0][0]?.text).toBe(
      MANAGED_BOT_RETURN_BUTTON_TEXT,
    );
    expect(
      notification.replyMarkup?.inline_keyboard[0][0]?.url,
    ).toBe("https://app.example.test/app/setup?telegram=created");

    const duplicateAfterVerify = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(42, 7431, 6531, "CustomNameBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(duplicateAfterVerify.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(2);
  });

  it("keeps a saved candidate when the confirmation notification fails", async () => {
    const started = await createTelegramLinkAttempt(db(), {
      storeId: fixture.storeAId,
      merchantUserId: fixture.userAId,
      managerBotUsername: "RabetManagerBot",
    });
    const bound = await bindLinkAttemptToTelegramUser(db(), {
      nonce: started.nonce,
      telegramUserId: 7441,
    });
    expect(bound.status).toBe("bound");

    const transport = createFakeTelegramTransport();
    transport.failSendWith = "bot was blocked by the user";
    transport.failSendKind = "blocked";

    const manager = managerApi({
      getManagedBotToken: vi.fn(async () => ({
        ok: true as const,
        result: "6541:AA-managed-token",
      })),
    });

    const response = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(50, 7441, 6541, "QuietBot")),
      {
        db: db(),
        transport,
        managerApi: manager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => botApi(6541, "QuietBot"),
      },
    );
    expect(response.status).toBe(200);
    expect(transport.sentMessages).toHaveLength(0);
    expect(await db().select().from(telegramConnection)).toHaveLength(0);

    const verified = await verifyManagedBotStart(
      db(),
      {
        storeId: fixture.storeAId,
        merchantUserId: fixture.userAId,
        attemptId: started.attemptId,
      },
      {
        managerApi: manager,
        transport,
        createBotApi: () => ({
          ...botApi(6541, "QuietBot"),
          getWebhookInfo: vi.fn(async () => ({
            ok: true as const,
            result: { url: "" },
          })),
          getUpdates: vi.fn(async () => ({
            ok: true as const,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 1,
                  from: { id: 7441, is_bot: false, first_name: "Merchant" },
                  chat: { id: 7441, type: "private" },
                  date: 1,
                  text: `/start ${started.nonce}`,
                },
              },
            ],
          })),
        }),
        webhookOrigin: "https://app.example.test",
      },
    );
    expect(verified.status).toBe("verified");
    expect(transport.sentMessages).toHaveLength(0);

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botUsername).toBe("QuietBot");
  });
});
