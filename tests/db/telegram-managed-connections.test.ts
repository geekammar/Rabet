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
  bindLinkAttemptToTelegramUser,
  confirmTelegramConnection,
  createTelegramLinkAttempt,
  handleManagedBotEvent,
  readMerchantTelegramConnectionState,
  readReadyManagedConnection,
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

  let created: TelegramBotApiClient | null = null;
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
      createBotApi: () => {
        if (overrides.managedApi) {
          created = overrides.managedApi;
          return created;
        }

        created = botApi(botId, botUsername, overrides.managed);
        return created;
      },
    },
  );

  return { started, manager, managed: created, result };
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
        error: "setWebhook failed",
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

  it("does not persist a candidate when a token fetch returns after the attempt was superseded", async () => {
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

    const manager = managerApi({
      getManagedBotToken: vi.fn(() => token.promise),
    });

    let created: TelegramBotApiClient | null = null;
    const pending = handleManagedBotEvent(
      db(),
      {
        creatorUserId: 7471,
        botId: 6022,
        botUsername: "LateTokenBot",
        botName: "LateTokenBot",
      },
      {
        managerApi: manager,
        webhookOrigin: "https://app.example.test",
        createBotApi: () => {
          created = botApi(6022, "LateTokenBot");
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
    expect(result.status).toBe("superseded");
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

    const [connection] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(connection.status).toBe("awaiting_confirmation");
    expect(connection.botUsername).toBe("FlowStoreBot");
    expect(managed.setWebhook).not.toHaveBeenCalled();

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
    expect(first.status).toBe(500);

    const [retryableAttempt] = await db()
      .select()
      .from(telegramLinkAttempt)
      .where(eq(telegramLinkAttempt.id, started.attemptId));
    expect(retryableAttempt.status).toBe("pending");
    expect(retryableAttempt.failureCode).toBe("token_fetch_failed");
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

    const second = await handleManagerTelegramWebhookRequest(
      managerRequest(managedBotUpdate(14, 7411, 6511, "RetryableEventBot")),
      {
        db: db(),
        transport: createFakeTelegramTransport(),
        managerApi: successManager,
        managerBotId: 9001,
        managerToken: "123:manager",
        managerWebhookSecret: "manager-secret",
        webhookOrigin: "https://app.example.test",
        createBotApi: () => managed,
      },
    );
    expect(second.status).toBe(200);

    const [candidate] = await db()
      .select()
      .from(telegramConnection)
      .where(eq(telegramConnection.storeId, fixture.storeAId));
    expect(candidate.status).toBe("awaiting_confirmation");
    expect(candidate.botId).toBe(6511);
    expect(managed.setWebhook).not.toHaveBeenCalled();
  });

  it("does not link a managed bot event from an unbound Telegram actor", async () => {
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

    expect(response.status).toBe(200);
    expect(manager.getManagedBotToken).not.toHaveBeenCalled();
    expect(await db().select().from(telegramConnection)).toHaveLength(0);
  });
});
