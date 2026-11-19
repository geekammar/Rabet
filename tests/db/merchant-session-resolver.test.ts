import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("@/auth-merchant", () => ({
  auth: vi.fn(async () => null),
}));

import {
  appUser,
  merchantCredential,
  store,
  storeMembership,
} from "@/db/schema";
import { resolveMerchantAccess } from "@/lib/auth/merchant-session";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { assertStoreScope } from "@/lib/data/store-scope";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "resolver-merchant-password-123";

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_session_resolver");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

async function seedMerchant(email: string, storeName: string) {
  const [admin] = await testDb!.db
    .insert(appUser)
    .values({
      email: `resolver-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();

  const issued = await issueMerchantInvitation(testDb!.db, {
    actorUserId: admin.id,
    storeName,
    storeSlug: `${storeName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID()}`,
    invitedEmail: email,
  });

  const accepted = await acceptMerchantInvitation(testDb!.db, {
    token: issued.token,
    password: PASSWORD,
  });

  return { ...accepted, storeSlug: issued.storeSlug };
}

function claims(userId: string, sessionVersion = 0) {
  return { userId, sessionVersion };
}

function db() {
  return testDb!.db;
}

describe.skipIf(!shouldRun)("merchant store resolver", () => {
  it("resolves A and B only to their own store from one active membership", async () => {
    const a = await seedMerchant("resolver.a@example.test", "Resolver Store A");
    const b = await seedMerchant("resolver.b@example.test", "Resolver Store B");

    const accessA = await resolveMerchantAccess(db(), claims(a.userId));
    const accessB = await resolveMerchantAccess(db(), claims(b.userId));

    expect(accessA?.store).toMatchObject({
      id: a.storeId,
      name: "Resolver Store A",
      status: "onboarding",
    });
    expect(accessB?.store).toMatchObject({
      id: b.storeId,
      name: "Resolver Store B",
      status: "onboarding",
    });

    expect(accessA?.store.id).not.toBe(accessB?.store.id);
    assertStoreScope(accessA?.scope);
    assertStoreScope(accessB?.scope);
    expect(accessA?.scope.storeId).toBe(a.storeId);
    expect(accessB?.scope.storeId).toBe(b.storeId);
  });

  it("ignores a store id carried alongside the session claims", async () => {
    const a = await seedMerchant("resolver.hint.a@example.test", "Hint Store A");
    const b = await seedMerchant("resolver.hint.b@example.test", "Hint Store B");

    const access = await resolveMerchantAccess(db(), {
      ...claims(a.userId),
      storeId: b.storeId,
    } as { userId: string; sessionVersion: number });

    expect(access?.store.id).toBe(a.storeId);
  });

  it("denies a revoked membership immediately", async () => {
    const a = await seedMerchant("resolver.revoked@example.test", "Revoked Store");
    const membership = await testDb!.db
      .select({ id: storeMembership.id })
      .from(storeMembership)
      .where(eq(storeMembership.userId, a.userId));

    expect(await resolveMerchantAccess(db(), claims(a.userId))).not.toBeNull();

    await testDb!.db
      .update(storeMembership)
      .set({ status: "revoked" })
      .where(eq(storeMembership.id, membership[0].id));

    expect(await resolveMerchantAccess(db(), claims(a.userId))).toBeNull();
  });

  it("denies a disabled user immediately", async () => {
    const a = await seedMerchant("resolver.disabled@example.test", "Disabled Store");

    await testDb!.db
      .update(appUser)
      .set({ status: "disabled" })
      .where(eq(appUser.id, a.userId));

    expect(await resolveMerchantAccess(db(), claims(a.userId))).toBeNull();
  });

  it("rejects a session whose session_version is stale", async () => {
    const a = await seedMerchant("resolver.version@example.test", "Version Store");

    await testDb!.db
      .update(appUser)
      .set({ sessionVersion: 1 })
      .where(eq(appUser.id, a.userId));

    expect(await resolveMerchantAccess(db(), claims(a.userId, 0))).toBeNull();
    expect(await resolveMerchantAccess(db(), claims(a.userId, 1))).not.toBeNull();
  });

  it("fails closed for zero and multiple active memberships", async () => {
    const a = await seedMerchant("resolver.multi.a@example.test", "Multi Store A");
    const b = await seedMerchant("resolver.multi.b@example.test", "Multi Store B");

    const [superAdmin] = await testDb!.db
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.platformRole, "super_admin"))
      .limit(1);

    expect(await resolveMerchantAccess(db(), claims(superAdmin.id))).toBeNull();

    await testDb!.db.insert(storeMembership).values({
      storeId: b.storeId,
      userId: a.userId,
      role: "owner",
      status: "active",
    });

    expect(await resolveMerchantAccess(db(), claims(a.userId))).toBeNull();
  });

  it("returns a read-only access result for a suspended store", async () => {
    const a = await seedMerchant("resolver.suspended@example.test", "Suspended Store");

    await testDb!.db
      .update(store)
      .set({ status: "suspended" })
      .where(eq(store.id, a.storeId));

    const access = await resolveMerchantAccess(db(), claims(a.userId));

    expect(access).toMatchObject({
      readOnly: true,
      store: { id: a.storeId, status: "suspended" },
    });
  });

  it("denies malformed, unknown and deleted identities", async () => {
    expect(
      await resolveMerchantAccess(db(), claims("not-a-uuid")),
    ).toBeNull();
    expect(
      await resolveMerchantAccess(
        db(),
        claims(crypto.randomUUID()),
      ),
    ).toBeNull();

    const a = await seedMerchant("resolver.deleted@example.test", "Deleted Store");
    await testDb!.db.delete(merchantCredential);
    await testDb!.db.delete(storeMembership);
    await testDb!.db.delete(appUser).where(eq(appUser.id, a.userId));

    expect(await resolveMerchantAccess(db(), claims(a.userId))).toBeNull();
  });
});
