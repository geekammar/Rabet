import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { appUser, store, storeMembership } from "@/db/schema";
import { verifyMerchantCredentials } from "@/lib/auth/merchant-credentials";
import {
  MERCHANT_SIGN_IN_GLOBAL_MAX_ATTEMPTS,
  merchantGlobalSignInKey,
} from "@/lib/auth/merchant-throttle";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "credentials-merchant-password-123";

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_credentials");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from admin_login_throttle`);
  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

async function seedMerchant(email: string) {
  const [admin] = await testDb!.db
    .insert(appUser)
    .values({
      email: `credentials-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();

  const issued = await issueMerchantInvitation(testDb!.db, {
    actorUserId: admin.id,
    storeName: `Credentials Store ${crypto.randomUUID()}`,
    storeSlug: `credentials-store-${crypto.randomUUID()}`,
    invitedEmail: email,
  });

  return acceptMerchantInvitation(testDb!.db, {
    token: issued.token,
    password: PASSWORD,
  });
}

function verify(email: unknown, password: unknown) {
  return verifyMerchantCredentials(email, password, { db: testDb!.db });
}

describe.skipIf(!shouldRun)("merchant credentials", () => {
  it("verifies the stored Argon2id hash for the correct merchant", async () => {
    const a = await seedMerchant("credentials.a@example.test");

    const identity = await verify("Credentials.A@Example.TEST", PASSWORD);

    expect(identity).toEqual({
      id: a.userId,
      email: "credentials.a@example.test",
      role: "merchant",
      sessionVersion: 0,
    });
  });

  it("rejects a wrong password, unknown email and malformed input generically", async () => {
    await seedMerchant("credentials.b@example.test");

    expect(await verify("credentials.b@example.test", "wrong-password-123")).toBeNull();
    expect(await verify("unknown@example.test", PASSWORD)).toBeNull();
    expect(await verify("not-an-email", PASSWORD)).toBeNull();
    expect(await verify("credentials.b@example.test", "x")).toBeNull();
  });

  it("rejects a disabled user even with the correct password", async () => {
    const a = await seedMerchant("credentials.disabled@example.test");

    await testDb!.db
      .update(appUser)
      .set({ status: "disabled" })
      .where(eq(appUser.id, a.userId));

    expect(await verify("credentials.disabled@example.test", PASSWORD)).toBeNull();
  });

  it("rejects revoked and zero active memberships, then recovers when restored", async () => {
    const a = await seedMerchant("credentials.membership@example.test");

    await testDb!.db
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.userId, a.userId));

    expect(await verify("credentials.membership@example.test", PASSWORD)).toBeNull();

    await testDb!.db.execute(sql`delete from store_membership`);
    expect(await verify("credentials.membership@example.test", PASSWORD)).toBeNull();

    await testDb!.db.insert(storeMembership).values({
      storeId: a.storeId,
      userId: a.userId,
      role: "owner",
      status: "active",
    });

    expect(await verify("credentials.membership@example.test", PASSWORD)).not.toBeNull();
  });

  it("rejects multiple active memberships", async () => {
    const a = await seedMerchant("credentials.multiple@example.test");
    const [secondStore] = await testDb!.db
      .insert(store)
      .values({
        name: "Second Credentials Store",
        slug: `second-credentials-${crypto.randomUUID()}`,
        status: "onboarding",
      })
      .returning();

    await testDb!.db.insert(storeMembership).values({
      storeId: secondStore.id,
      userId: a.userId,
      role: "owner",
      status: "active",
    });

    expect(await verify("credentials.multiple@example.test", PASSWORD)).toBeNull();
  });

  it("rejects an ineligible platform identity", async () => {
    const a = await seedMerchant("credentials.platform@example.test");

    await testDb!.db
      .update(appUser)
      .set({ platformRole: "super_admin" })
      .where(eq(appUser.id, a.userId));

    expect(await verify("credentials.platform@example.test", PASSWORD)).toBeNull();

    await testDb!.db
      .update(appUser)
      .set({ platformRole: "user" })
      .where(eq(appUser.id, a.userId));

    expect(await verify("credentials.platform@example.test", PASSWORD)).not.toBeNull();
  });

  it("issues a merchant session for a suspended store and leaves read-only handling to the resolver", async () => {
    const a = await seedMerchant("credentials.suspended@example.test");

    await testDb!.db
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));

    const identity = await verify("credentials.suspended@example.test", PASSWORD);
    expect(identity).toMatchObject({ id: a.userId, role: "merchant" });
  });

  it("does not create a fresh identity bucket when the coarse budget is denied", async () => {
    await testDb!.db.execute(sql`
      insert into merchant_auth_throttle (scope, key, attempt_count, window_started_at)
      values (
        'sign_in_global',
        ${merchantGlobalSignInKey()},
        ${MERCHANT_SIGN_IN_GLOBAL_MAX_ATTEMPTS + 1},
        now()
      )
    `);

    expect(await verify("credentials.coarse@example.test", PASSWORD)).toBeNull();

    const rows = await testDb!.db.execute<{ scope: string }>(sql`
      select scope from merchant_auth_throttle
    `);

    expect(rows.filter((row) => row.scope === "sign_in")).toEqual([]);
  });

  it("throttles one identity's attempts before Argon2 without affecting another", async () => {
    await seedMerchant("credentials.throttle.a@example.test");
    await seedMerchant("credentials.throttle.b@example.test");

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await verify("credentials.throttle.a@example.test", "wrong-password-123"),
      ).toBeNull();
    }

    expect(await verify("credentials.throttle.a@example.test", PASSWORD)).toBeNull();
    expect(await verify("credentials.throttle.b@example.test", PASSWORD)).not.toBeNull();

    const operatorRows = await testDb!.db.execute(
      sql`select count(*)::int as count from admin_login_throttle`,
    );
    expect(operatorRows[0]).toMatchObject({ count: 0 });
  });
});
