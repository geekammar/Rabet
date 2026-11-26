import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  appUser,
  store,
  storeMembership,
} from "@/db/schema";
import type { TransactionDatabase } from "@/db/transaction-client";
import { saveMerchantTelegramSupport } from "@/lib/merchant/store-telegram-contact";
import {
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  readStoreScopeForFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
let testDb: TestDatabase | null = null;
let storeAId = "";
let storeBId = "";
let userAId = "";
let userBId = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_telegram_contact");

  const [storeA] = await testDb.db
    .insert(store)
    .values({
      name: "Support Store A",
      slug: "support-store-a",
      status: "active",
    })
    .returning();
  const [storeB] = await testDb.db
    .insert(store)
    .values({
      name: "Support Store B",
      slug: "support-store-b",
      status: "active",
    })
    .returning();
  const [userA] = await testDb.db
    .insert(appUser)
    .values({ email: "support.a@example.test" })
    .returning();
  const [userB] = await testDb.db
    .insert(appUser)
    .values({ email: "support.b@example.test" })
    .returning();

  await testDb.db.insert(storeMembership).values([
    { storeId: storeA.id, userId: userA.id, role: "owner", status: "active" },
    { storeId: storeB.id, userId: userB.id, role: "owner", status: "active" },
  ]);

  storeAId = storeA.id;
  storeBId = storeB.id;
  userAId = userA.id;
  userBId = userB.id;
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db
    .update(store)
    .set({ telegramSupportUsername: null, status: "active" });
  await testDb.db
    .update(storeMembership)
    .set({ status: "active" });
  await testDb.db.update(appUser).set({ status: "active", sessionVersion: 0 });
});

function db() {
  return testDb!.db;
}

async function merchantAccess(
  storeId: string,
  userId: string,
  readOnly = false,
) {
  return {
    userId,
    email: `${userId}@example.test`,
    sessionVersion: 0,
    role: "owner" as const,
    store: {
      id: storeId,
      name: "Support Store",
      slug: `support-${storeId}`,
      status: readOnly ? ("suspended" as const) : ("active" as const),
    },
    scope: await readStoreScopeForFixture(db(), storeId),
    readOnly,
  };
}

async function savedUsername(storeId: string) {
  const [row] = await db()
    .select({ username: store.telegramSupportUsername })
    .from(store)
    .where(eq(store.id, storeId));
  return row?.username ?? null;
}

describe.skipIf(!shouldRun)("merchant Telegram support contact", () => {
  it("normalizes an @username and an https t.me link into the bare username", async () => {
    const access = await merchantAccess(storeAId, userAId);

    const atUsername = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "  @StoreA_Support  " },
    );
    expect(atUsername).toEqual({ ok: true, username: "StoreA_Support" });
    expect(await savedUsername(storeAId)).toBe("StoreA_Support");

    const link = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "https://t.me/StoreA_Help/" },
    );
    expect(link).toEqual({ ok: true, username: "StoreA_Help" });
    expect(await savedUsername(storeAId)).toBe("StoreA_Help");
  });

  it("rejects invalid input without overwriting the saved value", async () => {
    const access = await merchantAccess(storeAId, userAId);

    await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "@StoreA_Support" },
    );

    for (const username of [
      "StoreA_Support",
      "@ab",
      "@1invalid",
      "@bad-name",
      "http://t.me/StoreA_Support",
      "https://t.me/StoreA_Support/extra",
      "https://example.com/StoreA_Support",
    ]) {
      const result = await saveMerchantTelegramSupport(
        db() as unknown as TransactionDatabase,
        access,
        { username },
      );
      expect(result).toEqual({ ok: false, error: "INVALID_USERNAME" });
    }

    expect(await savedUsername(storeAId)).toBe("StoreA_Support");
  });

  it("clears the contact when the merchant submits an empty value", async () => {
    const access = await merchantAccess(storeAId, userAId);

    await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "@StoreA_Support" },
    );

    const cleared = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "   " },
    );

    expect(cleared).toEqual({ ok: true, username: null });
    expect(await savedUsername(storeAId)).toBeNull();
  });

  it("denies a merchant whose membership was revoked after the page loaded", async () => {
    const access = await merchantAccess(storeAId, userAId);

    await db()
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.userId, userAId));

    const result = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "@StoreA_Support" },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await savedUsername(storeAId)).toBeNull();
  });

  it("denies a read-only suspended store even with a stale writable access object", async () => {
    const access = await merchantAccess(storeAId, userAId);

    await db()
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, storeAId));

    const result = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      access,
      { username: "@StoreA_Support" },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await savedUsername(storeAId)).toBeNull();

    const readOnlyAccess = await merchantAccess(storeAId, userAId, true);
    expect(
      await saveMerchantTelegramSupport(
        db() as unknown as TransactionDatabase,
        readOnlyAccess,
        { username: "@StoreA_Support" },
      ),
    ).toEqual({ ok: false, error: "DENIED" });
  });

  it("never writes another store's contact, even with a forged store scope", async () => {
    const accessA = await merchantAccess(storeAId, userAId);
    const accessB = await merchantAccess(storeBId, userBId);

    await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      accessA,
      { username: "@StoreA_Support" },
    );

    expect(await savedUsername(storeBId)).toBeNull();

    const forged = { ...accessA, scope: accessB.scope };
    const result = await saveMerchantTelegramSupport(
      db() as unknown as TransactionDatabase,
      forged,
      { username: "@StoreB_Support" },
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(await savedUsername(storeAId)).toBe("StoreA_Support");
    expect(await savedUsername(storeBId)).toBeNull();
  });

  it("enforces the normalized username format in the database", async () => {
    let error: unknown = null;

    try {
      await db()
        .update(store)
        .set({ telegramSupportUsername: "@not valid" })
        .where(eq(store.id, storeAId));
    } catch (thrown) {
      error = thrown;
    }

    expect(pgErrorCode(error)).toBe("23514");
    expect(await savedUsername(storeAId)).toBeNull();
  });
});
