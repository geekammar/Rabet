import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { appUser } from "@/db/schema";
import { verifyMerchantCredentials } from "@/lib/auth/merchant-credentials";
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
