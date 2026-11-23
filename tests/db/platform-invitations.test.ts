import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";

import {
  appUser,
  merchantCredential,
  merchantInvitation,
  store,
  storeMembership,
} from "@/db/schema";
import { verifyPlatformAdminCredentials } from "@/lib/auth/platform-credentials";
import { resolvePlatformAdminAccess } from "@/lib/auth/platform-access";
import {
  MERCHANT_INVITATION_REJECTION_MESSAGE,
  MerchantInvitationError,
  acceptMerchantInvitation,
  issueMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import {
  listPlatformInvitations,
  listPlatformStores,
} from "@/lib/merchant-invitation/platform-admin";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PLATFORM_PASSWORD = "platform-admin-password-123";
const MERCHANT_PASSWORD = "platform-merchant-password-123";
const HASH_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("platform_invitations");
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

function db() {
  return testDb!.db;
}

async function insertPlatformAdmin(
  overrides: Partial<typeof appUser.$inferInsert> = {},
  passwordHash?: string,
) {
  const [row] = await db()
    .insert(appUser)
    .values({
      email: `platform-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
      ...overrides,
    })
    .returning();

  if (passwordHash) {
    await db().insert(merchantCredential).values({
      userId: row.id,
      passwordHash,
    });
  }

  return row;
}

async function platformCredential() {
  return hash(PLATFORM_PASSWORD, HASH_OPTIONS);
}

async function rejectionOf(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(MerchantInvitationError);
    return error as MerchantInvitationError;
  }

  throw new Error("Expected the operation to be rejected.");
}

describe.skipIf(!shouldRun)("platform Super Admin authorization", () => {
  it("accepts only an active Super Admin with the correct password", async () => {
    const passwordHash = await platformCredential();
    const admin = await insertPlatformAdmin({}, passwordHash);
    const merchant = await insertPlatformAdmin(
      { platformRole: "user" },
      passwordHash,
    );
    const disabled = await insertPlatformAdmin(
      { status: "disabled" },
      passwordHash,
    );

    const identity = await verifyPlatformAdminCredentials(
      admin.email.toUpperCase(),
      PLATFORM_PASSWORD,
      { db: db() },
    );

    expect(identity).toEqual({
      id: admin.id,
      email: admin.email,
      role: "platform_admin",
      sessionVersion: admin.sessionVersion,
    });

    expect(
      await verifyPlatformAdminCredentials(
        merchant.email,
        PLATFORM_PASSWORD,
        { db: db() },
      ),
    ).toBeNull();
    expect(
      await verifyPlatformAdminCredentials(
        disabled.email,
        PLATFORM_PASSWORD,
        { db: db() },
      ),
    ).toBeNull();
    expect(
      await verifyPlatformAdminCredentials(admin.email, "wrong-password-123", {
        db: db(),
      }),
    ).toBeNull();
    expect(
      await verifyPlatformAdminCredentials("unknown@example.test", PLATFORM_PASSWORD, {
        db: db(),
      }),
    ).toBeNull();
    expect(
      await verifyPlatformAdminCredentials("not-an-email", PLATFORM_PASSWORD, {
        db: db(),
      }),
    ).toBeNull();
  });

  it("rejects a merchant identity that tries to claim a platform role session", async () => {
    const passwordHash = await platformCredential();
    const admin = await insertPlatformAdmin({}, passwordHash);
    const merchant = await insertPlatformAdmin(
      { platformRole: "user" },
      passwordHash,
    );

    const accepted = await resolvePlatformAdminAccess(db(), {
      user: {
        id: admin.id,
        role: "platform_admin",
        sessionVersion: admin.sessionVersion,
      },
    });
    expect(accepted).toEqual({
      id: admin.id,
      email: admin.email,
      role: "platform_admin",
      sessionVersion: admin.sessionVersion,
    });

    expect(
      await resolvePlatformAdminAccess(db(), {
        user: {
          id: merchant.id,
          role: "platform_admin",
          sessionVersion: merchant.sessionVersion,
        },
      }),
    ).toBeNull();

    expect(
      await resolvePlatformAdminAccess(db(), {
        user: {
          id: admin.id,
          role: "merchant",
          sessionVersion: admin.sessionVersion,
        },
      }),
    ).toBeNull();

    expect(
      await resolvePlatformAdminAccess(db(), {
        user: {
          id: admin.id,
          role: "platform_admin",
          sessionVersion: admin.sessionVersion + 1,
        },
      }),
    ).toBeNull();

    await db()
      .update(appUser)
      .set({ status: "disabled" })
      .where(eq(appUser.id, admin.id));

    expect(
      await resolvePlatformAdminAccess(db(), {
        user: {
          id: admin.id,
          role: "platform_admin",
          sessionVersion: admin.sessionVersion,
        },
      }),
    ).toBeNull();
  });
});

describe.skipIf(!shouldRun)("platform invitation issue, revoke and redeem", () => {
  it("records the issuing Super Admin and lists every invitation without a token", async () => {
    const admin = await insertPlatformAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Platform Issued Store",
      storeSlug: `platform-issued-${crypto.randomUUID()}`,
      invitedEmail: "platform.invited@example.test",
    });

    expect(issued.storeName).toBe("Platform Issued Store");
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await db()
      .select({
        invitedByUserId: merchantInvitation.invitedByUserId,
        tokenDigest: merchantInvitation.tokenDigest,
      })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(row[0].invitedByUserId).toBe(admin.id);
    expect(row[0].tokenDigest).not.toBe(issued.token);

    const listed = await listPlatformInvitations(db());
    const record = listed.find((entry) => entry.id === issued.invitationId);

    expect(record).toMatchObject({
      invitedEmail: "platform.invited@example.test",
      storeName: "Platform Issued Store",
      storeSlug: issued.storeSlug,
      storeStatus: "onboarding",
      status: "pending",
      issuedByEmail: admin.email,
      revokedByEmail: null,
    });
    expect(record).not.toHaveProperty("token");
    expect(record).not.toHaveProperty("tokenDigest");
  });

  it("records the revoking Super Admin and refuses expired, redeemed and revoked invitations", async () => {
    const admin = await insertPlatformAdmin();
    const pending = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Pending Revocation Store",
      storeSlug: `pending-revoke-${crypto.randomUUID()}`,
      invitedEmail: "pending.revoke@example.test",
    });

    const revoked = await revokeMerchantInvitation(db(), {
      actorUserId: admin.id,
      invitationId: pending.invitationId,
    });

    expect(revoked.revokedByUserId).toBe(admin.id);

    const revokedRow = await db()
      .select({
        revokedAt: merchantInvitation.revokedAt,
        revokedByUserId: merchantInvitation.revokedByUserId,
      })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, pending.invitationId));

    expect(revokedRow[0].revokedAt).not.toBeNull();
    expect(revokedRow[0].revokedByUserId).toBe(admin.id);

    const revokedList = await listPlatformInvitations(db());
    expect(
      revokedList.find((entry) => entry.id === pending.invitationId),
    ).toMatchObject({
      status: "revoked",
      revokedByEmail: admin.email,
    });

    const again = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: admin.id,
        invitationId: pending.invitationId,
      }),
    );
    expect(again.code).toBe("INVITATION_REJECTED");
    expect(again.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);

    const expired = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Expired Platform Store",
      storeSlug: `expired-platform-${crypto.randomUUID()}`,
      invitedEmail: "expired.platform@example.test",
    });
    await db().execute(sql`
      update merchant_invitation
      set created_at = clock_timestamp() - interval '2 days',
          expires_at = clock_timestamp() - interval '1 day'
      where id = ${expired.invitationId}
    `);

    const expiredError = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: admin.id,
        invitationId: expired.invitationId,
      }),
    );
    expect(expiredError.code).toBe("INVITATION_REJECTED");

    const expiredList = await listPlatformInvitations(db());
    expect(
      expiredList.find((entry) => entry.id === expired.invitationId)?.status,
    ).toBe("expired");
  });

  it("preserves the merchant redemption flow and marks the invitation redeemed", async () => {
    const admin = await insertPlatformAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Redeemed Platform Store",
      storeSlug: `redeemed-platform-${crypto.randomUUID()}`,
      invitedEmail: "redeemed.platform@example.test",
    });

    const accepted = await acceptMerchantInvitation(db(), {
      token: issued.token,
      password: MERCHANT_PASSWORD,
    });

    expect(accepted.storeId).toBe(issued.storeId);
    expect(accepted.email).toBe("redeemed.platform@example.test");

    const membership = await db()
      .select({
        role: storeMembership.role,
        status: storeMembership.status,
      })
      .from(storeMembership)
      .where(eq(storeMembership.id, accepted.membershipId));

    expect(membership[0]).toEqual({ role: "owner", status: "active" });

    const listed = await listPlatformInvitations(db());
    expect(listed.find((entry) => entry.id === issued.invitationId)).toMatchObject({
      status: "accepted",
      revokedByEmail: null,
    });

    const revokeError = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: admin.id,
        invitationId: issued.invitationId,
      }),
    );
    expect(revokeError.code).toBe("INVITATION_REJECTED");

    const replay = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: issued.token,
        password: MERCHANT_PASSWORD,
      }),
    );
    expect(replay.code).toBe("INVITATION_REJECTED");
  });

  it("denies issue and revoke to merchant, disabled and missing actors", async () => {
    const admin = await insertPlatformAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Protected Platform Store",
      storeSlug: `protected-platform-${crypto.randomUUID()}`,
      invitedEmail: "protected.platform@example.test",
    });
    const merchant = await insertPlatformAdmin({ platformRole: "user" });
    const disabled = await insertPlatformAdmin({ status: "disabled" });

    for (const actorUserId of [
      merchant.id,
      disabled.id,
      crypto.randomUUID(),
      "admin",
      "admin@example.test",
      undefined,
    ]) {
      const issueError = await rejectionOf(
        issueMerchantInvitation(db(), {
          actorUserId,
          storeName: "Denied Store",
          storeSlug: `denied-${crypto.randomUUID()}`,
          invitedEmail: "denied@example.test",
        }),
      );
      expect(issueError.code).toBe("FORBIDDEN");

      const revokeError = await rejectionOf(
        revokeMerchantInvitation(db(), {
          actorUserId,
          invitationId: issued.invitationId,
        }),
      );
      expect(revokeError.code).toBe("FORBIDDEN");
    }

    const row = await db()
      .select({
        revokedAt: merchantInvitation.revokedAt,
        revokedByUserId: merchantInvitation.revokedByUserId,
      })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(row[0]).toEqual({ revokedAt: null, revokedByUserId: null });
  });
});


describe.skipIf(!shouldRun)("platform store directory", () => {
  it("lists each store once with owner emails and latest invitation state", async () => {
    const admin = await insertPlatformAdmin();

    const [noInvitation] = await db()
      .insert(store)
      .values({
        name: "No Invitation Store",
        slug: `no-invitation-${crypto.randomUUID()}`,
        status: "onboarding",
      })
      .returning();

    const pending = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Unclaimed Store",
      storeSlug: `unclaimed-${crypto.randomUUID()}`,
      invitedEmail: "unclaimed.store@example.test",
    });

    const accepted = await issueMerchantInvitation(db(), {
      actorUserId: admin.id,
      storeName: "Accepted Store",
      storeSlug: `accepted-${crypto.randomUUID()}`,
      invitedEmail: "accepted.store@example.test",
    });

    await acceptMerchantInvitation(db(), {
      token: accepted.token,
      password: MERCHANT_PASSWORD,
    });

    // A second active membership and an older revoked invitation must not
    // duplicate the store row.
    const [secondOwner] = await db()
      .insert(appUser)
      .values({ email: `second-owner-${crypto.randomUUID()}@example.test` })
      .returning();

    await db().insert(storeMembership).values({
      storeId: accepted.storeId,
      userId: secondOwner.id,
      role: "owner",
      status: "active",
    });

    const [olderInvitation] = await db()
      .insert(merchantInvitation)
      .values({
        storeId: accepted.storeId,
        invitedEmail: "older.revoked@example.test",
        tokenDigest: crypto.randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        invitedByUserId: admin.id,
        revokedAt: new Date(),
        revokedByUserId: admin.id,
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();

    expect(olderInvitation.storeId).toBe(accepted.storeId);

    const listed = await listPlatformStores(db());
    const rows = listed.filter(
      (entry) =>
        entry.id === noInvitation.id ||
        entry.id === pending.storeId ||
        entry.id === accepted.storeId,
    );

    expect(rows).toHaveLength(3);

    const noInvitationRow = rows.find((entry) => entry.id === noInvitation.id);
    expect(noInvitationRow).toMatchObject({
      status: "onboarding",
      ownerEmails: [],
      latestInvitation: null,
    });

    const pendingRow = rows.find((entry) => entry.id === pending.storeId);
    expect(pendingRow?.ownerEmails).toEqual([]);
    expect(pendingRow?.latestInvitation).toMatchObject({
      invitedEmail: "unclaimed.store@example.test",
      status: "pending",
    });

    const acceptedRows = rows.filter((entry) => entry.id === accepted.storeId);
    expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0].latestInvitation).toMatchObject({
      invitedEmail: "accepted.store@example.test",
      status: "accepted",
    });
    expect(acceptedRows[0].ownerEmails).toHaveLength(2);
    expect(acceptedRows[0].ownerEmails).toEqual(
      expect.arrayContaining([
        "accepted.store@example.test",
        secondOwner.email,
      ]),
    );
  });
});
