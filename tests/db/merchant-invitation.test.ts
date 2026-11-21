import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, sql } from "drizzle-orm";

import {
  appUser,
  merchantCredential,
  merchantInvitation,
  store,
  storeMembership,
} from "@/db/schema";
import {
  MERCHANT_INVITATION_PASSWORD_MESSAGE,
  MERCHANT_INVITATION_REJECTION_MESSAGE,
  MERCHANT_INVITATION_TTL_HOURS,
  MerchantInvitationError,
  acceptMerchantInvitation,
  issueMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import {
  createTestDatabase,
  hasTestCluster,
  installAcceptanceRollbackFixture,
  pgErrorCode,
  removeAcceptanceRollbackFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "merchant-password-123";

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_invitation");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`delete from merchant_invitation`);
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

function db() {
  return testDb!.db;
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function digest(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

async function insertIdentity(
  overrides: Partial<typeof appUser.$inferInsert> = {},
) {
  const [row] = await db()
    .insert(appUser)
    .values({
      email: `identity-${crypto.randomUUID()}@example.test`,
      ...overrides,
    })
    .returning();

  return row;
}

async function insertSuperAdmin(
  overrides: Partial<typeof appUser.$inferInsert> = {},
) {
  return insertIdentity({
    platformRole: "super_admin",
    ...overrides,
  });
}

async function insertStore(
  overrides: Partial<typeof store.$inferInsert> = {},
) {
  const [row] = await db()
    .insert(store)
    .values({
      name: "Fixture Store",
      slug: `fixture-store-${crypto.randomUUID()}`,
      ...overrides,
    })
    .returning();

  return row;
}

async function insertInvitation(args: {
  storeId: string;
  invitedEmail: string;
  token: string;
  invitedByUserId: string;
  expiresAt?: Date;
}) {
  const [row] = await db()
    .insert(merchantInvitation)
    .values({
      storeId: args.storeId,
      invitedEmail: args.invitedEmail.trim().toLowerCase(),
      tokenDigest: digest(args.token),
      expiresAt:
        args.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      invitedByUserId: args.invitedByUserId,
    })
    .returning();

  return row;
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

async function countRows(table: "app_user" | "merchant_credential" | "store_membership" | "merchant_invitation" | "store") {
  const rows = await db().execute<{ count: number }>(
    sql.raw(`select count(*)::int as count from ${table}`),
  );
  return rows[0].count;
}

async function countMerchantIdentities() {
  const rows = await db().execute<{ count: number }>(sql`
    select count(*)::int as count
    from app_user
    where platform_role = 'user'
  `);

  return rows[0].count;
}

async function insertCredential(userId: string, passwordHash: string) {
  await db().insert(merchantCredential).values({ userId, passwordHash });
}

async function expectNoChangesBefore(
  before: Record<string, number>,
) {
  expect(await countRows("app_user")).toBe(before.app_user);
  expect(await countRows("merchant_credential")).toBe(
    before.merchant_credential,
  );
  expect(await countRows("store_membership")).toBe(
    before.store_membership,
  );
  expect(await countRows("merchant_invitation")).toBe(
    before.merchant_invitation,
  );
}

async function snapshotCounts() {
  return {
    app_user: await countRows("app_user"),
    merchant_credential: await countRows("merchant_credential"),
    store_membership: await countRows("store_membership"),
    merchant_invitation: await countRows("merchant_invitation"),
    store: await countRows("store"),
  };
}

describe.skipIf(!shouldRun)("Phase 2A merchant invitations", () => {
  it("applies the additive schema and keeps the migration seed-free", async () => {
    const tables = await db().execute<{ name: string }>(sql`
      select table_name as name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('merchant_credential', 'merchant_invitation')
      order by table_name
    `);

    expect(tables.map((row) => row.name)).toEqual([
      "merchant_credential",
      "merchant_invitation",
    ]);

    const migration = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../drizzle/0008_merchant_invitations_and_credentials.sql",
      ),
      "utf8",
    );
    const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(createdTables.sort()).toEqual([
      "merchant_credential",
      "merchant_invitation",
    ]);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+["a-z_][a-z0-9_"]*\s+SET\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  it("only an active database Super Admin can issue an invitation", async () => {
    const regular = await insertIdentity();
    const disabledAdmin = await insertIdentity({
      status: "disabled",
      platformRole: "super_admin",
    });
    const actors = [
      regular.id,
      disabledAdmin.id,
      crypto.randomUUID(),
      "admin",
      "admin@example.test",
      undefined,
    ];

    for (const actorUserId of actors) {
      const error = await rejectionOf(
        issueMerchantInvitation(db(), {
          actorUserId,
          storeName: "Blocked Store",
          storeSlug: `blocked-${crypto.randomUUID()}`,
          invitedEmail: `blocked-${crypto.randomUUID()}@example.test`,
        }),
      );

      expect(error.code).toBe("FORBIDDEN");
    }

    expect(await countRows("store")).toBe(0);
    expect(await countRows("merchant_invitation")).toBe(0);

    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Authorized Store",
      storeSlug: `authorized-${crypto.randomUUID()}`,
      invitedEmail: "  Owner@Example.TEST ",
    });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.invitedEmail).toBe("owner@example.test");
    expect(await countRows("store")).toBe(1);
    expect(await countRows("merchant_invitation")).toBe(1);
  });

  it("only an active database Super Admin can revoke a pending invitation by id", async () => {
    const superAdmin = await insertSuperAdmin();
    const regular = await insertIdentity();
    const disabledAdmin = await insertIdentity({
      status: "disabled",
      platformRole: "super_admin",
    });
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Revocation Store",
      storeSlug: `revocation-${crypto.randomUUID()}`,
      invitedEmail: "revoke@example.test",
    });

    for (const actorUserId of [
      regular.id,
      disabledAdmin.id,
      crypto.randomUUID(),
      "admin",
      "admin@example.test",
    ]) {
      const error = await rejectionOf(
        revokeMerchantInvitation(db(), { actorUserId, invitationId: issued.invitationId }),
      );

      expect(error.code).toBe("FORBIDDEN");
    }

    const pending = await db()
      .select({ revokedAt: merchantInvitation.revokedAt })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(pending[0].revokedAt).toBeNull();

    const revoked = await revokeMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      invitationId: issued.invitationId,
    });

    expect(revoked.invitationId).toBe(issued.invitationId);
    expect(revoked.storeId).toBe(issued.storeId);

    const after = await db()
      .select({ revokedAt: merchantInvitation.revokedAt })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(after[0].revokedAt).not.toBeNull();

    const acceptError = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: issued.token,
        password: PASSWORD,
      }),
    );

    expect(acceptError.code).toBe("INVITATION_REJECTED");
    expect(acceptError.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);
  });

  it("does not revoke an accepted invitation or change its membership", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Accepted Revocation Store",
      storeSlug: `accepted-revoke-${crypto.randomUUID()}`,
      invitedEmail: "accepted.revoke@example.test",
    });
    const accepted = await acceptMerchantInvitation(db(), {
      token: issued.token,
      password: PASSWORD,
    });
    const before = await snapshotCounts();

    const error = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        invitationId: issued.invitationId,
      }),
    );

    expect(error.code).toBe("INVITATION_REJECTED");
    await expectNoChangesBefore(before);

    const invitation = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));
    const membership = await db()
      .select()
      .from(storeMembership)
      .where(eq(storeMembership.id, accepted.membershipId));

    expect(invitation[0].acceptedAt).not.toBeNull();
    expect(invitation[0].revokedAt).toBeNull();
    expect(membership[0]).toMatchObject({
      storeId: issued.storeId,
      userId: accepted.userId,
      role: "owner",
      status: "active",
    });
  });

  it("requires a valid invitation id for revocation", async () => {
    const superAdmin = await insertSuperAdmin();

    for (const invitationId of [undefined, null, "", "not-a-uuid", 42]) {
      const error = await rejectionOf(
        revokeMerchantInvitation(db(), {
          actorUserId: superAdmin.id,
          invitationId,
        }),
      );

      expect(error.code).toBe("INVALID_INPUT");
    }

    const missing = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        invitationId: crypto.randomUUID(),
      }),
    );

    expect(missing.code).toBe("INVITATION_REJECTED");
  });

  it("allows at most one terminal transition when accept and revoke race", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Accept Revoke Race Store",
      storeSlug: `accept-revoke-race-${crypto.randomUUID()}`,
      invitedEmail: "accept.revoke.race@example.test",
    });

    const settled = await Promise.allSettled([
      acceptMerchantInvitation(db(), {
        token: issued.token,
        password: PASSWORD,
      }),
      revokeMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        invitationId: issued.invitationId,
      }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );

    const invitation = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(
      Number(invitation[0].acceptedAt !== null) +
        Number(invitation[0].revokedAt !== null),
    ).toBe(1);

    if (invitation[0].acceptedAt !== null) {
      expect(invitation[0].revokedAt).toBeNull();
      expect(await countMerchantIdentities()).toBe(1);
      expect(await countRows("merchant_credential")).toBe(1);
      expect(await countRows("store_membership")).toBe(1);
    } else {
      expect(invitation[0].revokedAt).not.toBeNull();
      expect(await countMerchantIdentities()).toBe(0);
      expect(await countRows("merchant_credential")).toBe(0);
      expect(await countRows("store_membership")).toBe(0);
    }
  });

  it("returns the raw token once and stores only its digest", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Digest Store",
      storeSlug: `digest-${crypto.randomUUID()}`,
      invitedEmail: "digest@example.test",
    });

    const rows = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(rows).toHaveLength(1);
    expect(rows[0].tokenDigest).toBe(digest(issued.token));
    expect(rows[0].tokenDigest).not.toBe(issued.token);
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);

    const createdStore = await db()
      .select({ status: store.status, slug: store.slug })
      .from(store)
      .where(eq(store.id, issued.storeId));

    expect(createdStore[0]).toEqual({
      status: "onboarding",
      slug: issued.storeSlug,
    });
    expect(rows[0].invitedByUserId).toBe(superAdmin.id);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + MERCHANT_INVITATION_TTL_HOURS * 60 * 60 * 1000,
    );
    expect(await countRows("merchant_credential")).toBe(0);
  });

  it("rolls back the store when the invitation insert fails", async () => {
    const superAdmin = await insertSuperAdmin();
    const slug = `rollback-issue-${crypto.randomUUID()}`;

    await db().execute(sql`
      create or replace function reject_merchant_invitation_insert()
      returns trigger language plpgsql as $$
      begin
        raise exception 'invitation insert blocked';
      end;
      $$
    `);
    await db().execute(sql`
      create trigger reject_merchant_invitation_insert_trigger
      before insert on merchant_invitation
      for each row execute function reject_merchant_invitation_insert()
    `);

    try {
      const error = await rejectionOf(
        issueMerchantInvitation(db(), {
          actorUserId: superAdmin.id,
          storeName: "Rollback Store",
          storeSlug: slug,
          invitedEmail: "rollback@example.test",
        }),
      );

      expect(error.code).toBe("OPERATION_FAILED");
      expect(await countRows("store")).toBe(0);
      expect(await countRows("merchant_invitation")).toBe(0);
    } finally {
      await db().execute(
        sql`drop trigger if exists reject_merchant_invitation_insert_trigger on merchant_invitation`,
      );
      await db().execute(
        sql`drop function if exists reject_merchant_invitation_insert()`,
      );
    }
  });

  it("creates exactly one Argon2id credential and one active owner membership", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Happy Path Store",
      storeSlug: `happy-${crypto.randomUUID()}`,
      invitedEmail: "  Happy.Owner@Example.TEST ",
    });

    const accepted = await acceptMerchantInvitation(db(), {
      token: issued.token,
      password: PASSWORD,
    });

    expect(accepted.storeId).toBe(issued.storeId);
    expect(accepted.email).toBe("happy.owner@example.test");
    expect(JSON.stringify(accepted)).not.toContain(PASSWORD);
    expect(JSON.stringify(accepted)).not.toContain("argon2");

    const identities = await db()
      .select()
      .from(appUser)
      .where(eq(appUser.id, accepted.userId));

    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      email: "happy.owner@example.test",
      status: "active",
      platformRole: "user",
      sessionVersion: 0,
    });

    const credentials = await db()
      .select()
      .from(merchantCredential)
      .where(eq(merchantCredential.userId, accepted.userId));

    expect(credentials).toHaveLength(1);
    expect(credentials[0].passwordHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(credentials[0].passwordHash).not.toContain(PASSWORD);
    await expect(
      verify(credentials[0].passwordHash, PASSWORD),
    ).resolves.toBe(true);

    const memberships = await db()
      .select()
      .from(storeMembership)
      .where(eq(storeMembership.id, accepted.membershipId));

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      storeId: issued.storeId,
      userId: accepted.userId,
      role: "owner",
      status: "active",
    });

    const invitations = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(invitations[0].acceptedAt).not.toBeNull();
    expect(invitations[0].revokedAt).toBeNull();
    expect(await countMerchantIdentities()).toBe(1);
    expect(await countRows("merchant_credential")).toBe(1);
    expect(await countRows("store_membership")).toBe(1);
  });

  it("binds acceptance only to the store and email stored on the invitation", async () => {
    const superAdmin = await insertSuperAdmin();
    const storeAInvite = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Store A",
      storeSlug: `store-a-${crypto.randomUUID()}`,
      invitedEmail: "store-a-owner@example.test",
    });
    const storeBInvite = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Store B",
      storeSlug: `store-b-${crypto.randomUUID()}`,
      invitedEmail: "store-b-owner@example.test",
    });

    const accepted = await acceptMerchantInvitation(db(), {
      token: storeBInvite.token,
      password: PASSWORD,
      storeId: storeAInvite.storeId,
      email: storeAInvite.invitedEmail,
      invitedEmail: storeAInvite.invitedEmail,
    } as Parameters<typeof acceptMerchantInvitation>[1]);

    expect(accepted.storeId).toBe(storeBInvite.storeId);
    expect(accepted.email).toBe("store-b-owner@example.test");

    const identity = await db()
      .select({ email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, accepted.userId));

    expect(identity[0].email).toBe("store-b-owner@example.test");

    const membership = await db()
      .select({ storeId: storeMembership.storeId })
      .from(storeMembership)
      .where(eq(storeMembership.userId, accepted.userId));

    expect(membership.map((row) => row.storeId)).toEqual([
      storeBInvite.storeId,
    ]);

    const storeAInvitation = await db()
      .select({ acceptedAt: merchantInvitation.acceptedAt })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, storeAInvite.invitationId));

    expect(storeAInvitation[0].acceptedAt).toBeNull();
    expect(
      await db()
        .select({ id: appUser.id })
        .from(appUser)
        .where(sql`lower(${appUser.email}) = ${"store-a-owner@example.test"}`),
    ).toHaveLength(0);
  });

  it("refuses existing identities without changing their account, credential or membership", async () => {
    const superAdmin = await insertSuperAdmin();
    const existingPassword = "existing-password-123";
    const existingHash = await hash(existingPassword, {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const existing = await insertIdentity({
      email: "existing.owner@example.test",
    });
    await insertCredential(existing.id, existingHash);
    const existingStore = await insertStore();
    const [existingMembership] = await db()
      .insert(storeMembership)
      .values({
        storeId: existingStore.id,
        userId: existing.id,
        role: "owner",
        status: "active",
      })
      .returning();

    const before = await snapshotCounts();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Existing Identity Store",
      storeSlug: `existing-${crypto.randomUUID()}`,
      invitedEmail: "Existing.Owner@Example.TEST",
    });

    const error = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: issued.token,
        password: "new-password-123456",
      }),
    );

    expect(error.code).toBe("INVITATION_REJECTED");
    expect(error.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);
    await expectNoChangesBefore({
      ...before,
      store: before.store + 1,
      merchant_invitation: before.merchant_invitation + 1,
    });

    const identity = await db()
      .select()
      .from(appUser)
      .where(eq(appUser.id, existing.id));
    const credential = await db()
      .select()
      .from(merchantCredential)
      .where(eq(merchantCredential.userId, existing.id));
    const membership = await db()
      .select()
      .from(storeMembership)
      .where(eq(storeMembership.id, existingMembership.id));
    const invitation = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(identity[0]).toMatchObject({
      email: "existing.owner@example.test",
      status: "active",
      platformRole: "user",
    });
    expect(credential[0].passwordHash).toBe(existingHash);
    expect(membership[0]).toMatchObject({
      storeId: existingStore.id,
      status: "active",
      role: "owner",
    });
    expect(invitation[0].acceptedAt).toBeNull();
    expect(invitation[0].revokedAt).toBeNull();
  });

  it("does not attach a disabled or Super Admin identity to a merchant store", async () => {
    const superAdmin = await insertSuperAdmin();
    const disabled = await insertIdentity({
      email: "disabled.owner@example.test",
      status: "disabled",
    });
    const otherSuperAdmin = await insertSuperAdmin({
      email: "platform.owner@example.test",
    });

    for (const invitedEmail of [disabled.email, otherSuperAdmin.email]) {
      const issued = await issueMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        storeName: `Ineligible ${invitedEmail}`,
        storeSlug: `ineligible-${crypto.randomUUID()}`,
        invitedEmail,
      });

      const error = await rejectionOf(
        acceptMerchantInvitation(db(), {
          token: issued.token,
          password: PASSWORD,
        }),
      );

      expect(error.code).toBe("INVITATION_REJECTED");
    }

    const disabledAfter = await db()
      .select()
      .from(appUser)
      .where(eq(appUser.id, disabled.id));
    const superAdminAfter = await db()
      .select()
      .from(appUser)
      .where(eq(appUser.id, otherSuperAdmin.id));

    expect(disabledAfter[0].status).toBe("disabled");
    expect(disabledAfter[0].platformRole).toBe("user");
    expect(superAdminAfter[0].status).toBe("active");
    expect(superAdminAfter[0].platformRole).toBe("super_admin");
    expect(
      await db()
        .select()
        .from(merchantCredential)
        .where(
          sql`${merchantCredential.userId} in (${disabled.id}, ${otherSuperAdmin.id})`,
        ),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(storeMembership)
        .where(
          sql`${storeMembership.userId} in (${disabled.id}, ${otherSuperAdmin.id})`,
        ),
    ).toHaveLength(0);
  });

  it("rejects unknown, expired, revoked and consumed tokens with one safe message and no writes", async () => {
    const superAdmin = await insertSuperAdmin();
    const messages = new Set<string>();

    const unknown = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: newToken(),
        password: PASSWORD,
      }),
    );
    messages.add(unknown.message);

    const before = await snapshotCounts();
    const expired = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Expired Store",
      storeSlug: `expired-${crypto.randomUUID()}`,
      invitedEmail: "expired@example.test",
    });
    await db().execute(sql`
      update merchant_invitation
      set created_at = now() - interval '2 days',
          expires_at = now() - interval '1 day'
      where id = ${expired.invitationId}
    `);
    const expiredError = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: expired.token,
        password: PASSWORD,
      }),
    );
    messages.add(expiredError.message);
    await expectNoChangesBefore({
      ...before,
      store: before.store + 1,
      merchant_invitation: before.merchant_invitation + 1,
    });

    const revoked = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Revoked Store",
      storeSlug: `revoked-${crypto.randomUUID()}`,
      invitedEmail: "revoked@example.test",
    });
    await revokeMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      invitationId: revoked.invitationId,
    });
    const revokedError = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: revoked.token,
        password: PASSWORD,
      }),
    );
    messages.add(revokedError.message);

    const consumed = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Consumed Store",
      storeSlug: `consumed-${crypto.randomUUID()}`,
      invitedEmail: "consumed@example.test",
    });
    await acceptMerchantInvitation(db(), {
      token: consumed.token,
      password: PASSWORD,
    });
    const consumedBefore = await snapshotCounts();
    const consumedError = await rejectionOf(
      acceptMerchantInvitation(db(), {
        token: consumed.token,
        password: PASSWORD,
      }),
    );
    messages.add(consumedError.message);
    await expectNoChangesBefore(consumedBefore);

    expect(messages).toEqual(
      new Set([MERCHANT_INVITATION_REJECTION_MESSAGE]),
    );

    for (const invitationId of [
      expired.invitationId,
      revoked.invitationId,
      consumed.invitationId,
    ]) {
      const rows = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, invitationId));
      expect(rows[0].acceptedAt === null || invitationId === consumed.invitationId).toBe(
        true,
      );
    }
  });

  it("rolls back acceptance when expiry is reached at the terminal database update", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Terminal Expiry Acceptance Store",
      storeSlug: `terminal-expiry-accept-${crypto.randomUUID()}`,
      invitedEmail: "terminal.expiry.accept@example.test",
    });
    const target = `'${issued.invitationId}'::uuid`;

    await db().execute(sql.raw(`
      create or replace function expire_invitation_during_accept()
      returns trigger language plpgsql as $fn$
      begin
        update merchant_invitation
        set created_at = now() - interval '1 second',
            expires_at = now() + interval '1 microsecond'
        where id = ${target};
        perform pg_sleep(0.05);
        return new;
      end;
      $fn$;
    `));
    await db().execute(sql.raw(`
      create trigger expire_invitation_during_accept_trigger
      before insert on store_membership
      for each row execute function expire_invitation_during_accept();
    `));

    try {
      const error = await rejectionOf(
        acceptMerchantInvitation(db(), {
          token: issued.token,
          password: PASSWORD,
        }),
      );

      expect(error.code).toBe("INVITATION_REJECTED");
      expect(error.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);
      expect(await countMerchantIdentities()).toBe(0);
      expect(await countRows("merchant_credential")).toBe(0);
      expect(await countRows("store_membership")).toBe(0);

      const invitation = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, issued.invitationId));

      expect(invitation[0].acceptedAt).toBeNull();
      expect(invitation[0].revokedAt).toBeNull();
      expect(invitation[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await db().execute(
        sql`drop trigger if exists expire_invitation_during_accept_trigger on store_membership`,
      );
      await db().execute(
        sql`drop function if exists expire_invitation_during_accept()`,
      );
    }
  });

  it("does not revoke an expired invitation", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Expired Revocation Store",
      storeSlug: `expired-revoke-${crypto.randomUUID()}`,
      invitedEmail: "expired.revoke@example.test",
    });

    await db().execute(sql`
      update merchant_invitation
      set created_at = clock_timestamp() - interval '2 days',
          expires_at = clock_timestamp() - interval '1 day'
      where id = ${issued.invitationId}
    `);

    const error = await rejectionOf(
      revokeMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        invitationId: issued.invitationId,
      }),
    );

    expect(error.code).toBe("INVITATION_REJECTED");

    const invitation = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(invitation[0].acceptedAt).toBeNull();
    expect(invitation[0].revokedAt).toBeNull();
  });

  it("leaves the invitation usable after invalid credential input", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Credential Store",
      storeSlug: `credential-${crypto.randomUUID()}`,
      invitedEmail: "credential@example.test",
    });
    const before = await snapshotCounts();

    for (const password of ["", "short", "x".repeat(1025), 123, null, undefined]) {
      const error = await rejectionOf(
        acceptMerchantInvitation(db(), { token: issued.token, password }),
      );

      expect(error.code).toBe("INVALID_CREDENTIAL");
      expect(error.message).toBe(MERCHANT_INVITATION_PASSWORD_MESSAGE);
    }

    await expectNoChangesBefore(before);

    const accepted = await acceptMerchantInvitation(db(), {
      token: issued.token,
      password: PASSWORD,
    });

    expect(accepted.email).toBe("credential@example.test");
    expect(await countMerchantIdentities()).toBe(1);
    expect(await countRows("merchant_credential")).toBe(1);
  });

  it("rolls back identity, credential and membership when invitation consumption fails", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Rollback Acceptance Store",
      storeSlug: `rollback-accept-${crypto.randomUUID()}`,
      invitedEmail: "rollback.accept@example.test",
    });

    await installAcceptanceRollbackFixture(db());

    try {
      const error = await rejectionOf(
        acceptMerchantInvitation(db(), {
          token: issued.token,
          password: PASSWORD,
        }),
      );

      expect(error.code).toBe("INVITATION_REJECTED");
      expect(error.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);
      expect(await countMerchantIdentities()).toBe(0);
      expect(await countRows("merchant_credential")).toBe(0);
      expect(await countRows("store_membership")).toBe(0);

      const invitation = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, issued.invitationId));

      expect(invitation[0].acceptedAt).toBeNull();
    } finally {
      await removeAcceptanceRollbackFixture(db());
    }

    const accepted = await acceptMerchantInvitation(db(), {
      token: issued.token,
      password: PASSWORD,
    });

    expect(accepted.email).toBe("rollback.accept@example.test");
    expect(await countMerchantIdentities()).toBe(1);
    expect(await countRows("merchant_credential")).toBe(1);
    expect(await countRows("store_membership")).toBe(1);
  });

  it("serializes concurrent replay of the same token", async () => {
    const superAdmin = await insertSuperAdmin();
    const issued = await issueMerchantInvitation(db(), {
      actorUserId: superAdmin.id,
      storeName: "Replay Store",
      storeSlug: `replay-${crypto.randomUUID()}`,
      invitedEmail: "replay@example.test",
    });
    const attempts = [
      { password: "replay-password-one", token: issued.token },
      { password: "replay-password-two", token: issued.token },
    ];
    const settled = await Promise.allSettled(
      attempts.map((attempt) =>
        acceptMerchantInvitation(db(), {
          token: attempt.token,
          password: attempt.password,
        }),
      ),
    );
    const fulfilled = settled
      .map((result, index) => ({ result, index }))
      .filter(
        (entry): entry is { result: PromiseFulfilledResult<Awaited<ReturnType<typeof acceptMerchantInvitation>>>; index: number } =>
          entry.result.status === "fulfilled",
      );
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      (rejected[0] as PromiseRejectedResult).reason,
    ).toBeInstanceOf(MerchantInvitationError);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as MerchantInvitationError)
        .code,
    ).toBe("INVITATION_REJECTED");

    expect(await countMerchantIdentities()).toBe(1);
    expect(await countRows("merchant_credential")).toBe(1);
    expect(await countRows("store_membership")).toBe(1);

    const acceptedInvitations = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(acceptedInvitations[0].acceptedAt).not.toBeNull();

    const credential = await db()
      .select()
      .from(merchantCredential)
      .where(eq(merchantCredential.userId, fulfilled[0].result.value.userId));
    const winner = attempts[fulfilled[0].index];

    await expect(
      verify(credential[0].passwordHash, winner.password),
    ).resolves.toBe(true);
  });

  it("serializes different invitations for the same normalized email", async () => {
    const superAdmin = await insertSuperAdmin();
    const firstStore = await insertStore({ name: "Email Store One" });
    const secondStore = await insertStore({ name: "Email Store Two" });
    const firstToken = newToken();
    const secondToken = newToken();

    await insertInvitation({
      storeId: firstStore.id,
      invitedEmail: "  Same.Person@Example.TEST ",
      token: firstToken,
      invitedByUserId: superAdmin.id,
    });
    await insertInvitation({
      storeId: secondStore.id,
      invitedEmail: "same.person@example.test",
      token: secondToken,
      invitedByUserId: superAdmin.id,
    });

    const settled = await Promise.allSettled([
      acceptMerchantInvitation(db(), {
        token: firstToken,
        password: "first-email-password",
      }),
      acceptMerchantInvitation(db(), {
        token: secondToken,
        password: "second-email-password",
      }),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptMerchantInvitation>>> =>
        result.status === "fulfilled",
    );

    expect(fulfilled).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );

    const identities = await db()
      .select()
      .from(appUser)
      .where(sql`lower(${appUser.email}) = ${"same.person@example.test"}`);

    expect(identities).toHaveLength(1);
    expect(await countRows("merchant_credential")).toBe(1);
    expect(await countRows("store_membership")).toBe(1);

    const invitations = await db()
      .select()
      .from(merchantInvitation)
      .orderBy(merchantInvitation.createdAt);

    expect(invitations.filter((row) => row.acceptedAt !== null)).toHaveLength(1);
    expect(invitations.filter((row) => row.acceptedAt === null)).toHaveLength(1);
    expect(fulfilled[0].value.storeId).toBe(
      invitations.find((row) => row.acceptedAt !== null)?.storeId,
    );
  });

  it("serializes competing invitations for one store and leaves one active owner", async () => {
    const superAdmin = await insertSuperAdmin();
    const targetStore = await insertStore({ name: "One Owner Store" });
    const firstToken = newToken();
    const secondToken = newToken();

    await insertInvitation({
      storeId: targetStore.id,
      invitedEmail: "first.owner@example.test",
      token: firstToken,
      invitedByUserId: superAdmin.id,
    });
    await insertInvitation({
      storeId: targetStore.id,
      invitedEmail: "second.owner@example.test",
      token: secondToken,
      invitedByUserId: superAdmin.id,
    });

    const settled = await Promise.allSettled([
      acceptMerchantInvitation(db(), {
        token: firstToken,
        password: "first-store-password",
      }),
      acceptMerchantInvitation(db(), {
        token: secondToken,
        password: "second-store-password",
      }),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptMerchantInvitation>>> =>
        result.status === "fulfilled",
    );

    expect(fulfilled).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );

    const memberships = await db()
      .select()
      .from(storeMembership)
      .where(
        and(
          eq(storeMembership.storeId, targetStore.id),
          eq(storeMembership.role, "owner"),
          eq(storeMembership.status, "active"),
        ),
      );

    expect(memberships).toHaveLength(1);
    expect(memberships[0].userId).toBe(fulfilled[0].value.userId);
    expect(await countMerchantIdentities()).toBe(1);
    expect(await countRows("merchant_credential")).toBe(1);

    const invitations = await db()
      .select()
      .from(merchantInvitation)
      .where(eq(merchantInvitation.storeId, targetStore.id));

    expect(invitations.filter((row) => row.acceptedAt !== null)).toHaveLength(1);
    expect(invitations.filter((row) => row.acceptedAt === null)).toHaveLength(1);
  });

  it("enforces the additive schema checks and uniqueness rules", async () => {
    const superAdmin = await insertSuperAdmin();
    const fixtureStore = await insertStore();
    const validToken = newToken();
    const base = {
      storeId: fixtureStore.id,
      invitedEmail: "lowercase@example.test",
      tokenDigest: digest(validToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      invitedByUserId: superAdmin.id,
    };

    const insertFailure = async (
      values: Partial<typeof merchantInvitation.$inferInsert>,
      code: string,
    ) => {
      let caught: unknown;

      try {
        await db().insert(merchantInvitation).values({ ...base, ...values });
      } catch (error) {
        caught = error;
      }

      expect(pgErrorCode(caught)).toBe(code);
    };

    await insertFailure({ invitedEmail: "Upper@Example.test" }, "23514");
    await insertFailure({ tokenDigest: "not-a-digest" }, "23514");
    await insertFailure(
      { expiresAt: new Date(Date.now() - 60 * 1000) },
      "23514",
    );
    await insertFailure(
      {
        acceptedAt: new Date(),
        revokedAt: new Date(),
      },
      "23514",
    );

    await db().insert(merchantInvitation).values(base);

    await insertFailure({}, "23505");

    let invalidCredential: unknown;

    try {
      await db().insert(merchantCredential).values({
        userId: superAdmin.id,
        passwordHash: "plaintext-not-allowed",
      });
    } catch (error) {
      invalidCredential = error;
    }

    expect(pgErrorCode(invalidCredential)).toBe("23514");

    await insertCredential(superAdmin.id, "$argon2id$v=19$fixture");

    let duplicateCredential: unknown;

    try {
      await insertCredential(superAdmin.id, "$argon2id$v=19$fixture-2");
    } catch (error) {
      duplicateCredential = error;
    }

    expect(pgErrorCode(duplicateCredential)).toBe("23505");
  });

  it("has no unauthorized production caller", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../../src");
    const files = readdirSync(sourceRoot, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => /\.(ts|tsx)$/.test(entry))
      .map((entry) => path.join(sourceRoot, entry));
    const servicePath = path.join(
      sourceRoot,
      "lib/merchant-invitation/service.ts",
    );
    const marker =
      /merchant-invitation|issueMerchantInvitation|acceptMerchantInvitation|revokeMerchantInvitation/;
    const allowed = new Set([
      servicePath,
      path.join(sourceRoot, "app/api/merchant-invitations/accept/route.ts"),
      path.join(sourceRoot, "app/api/merchant-invitations/preview/route.ts"),
      path.join(sourceRoot, "components/merchant/invitation-acceptance.tsx"),
      path.join(sourceRoot, "components/merchant/invitation-brand.tsx"),
      path.join(sourceRoot, "app/invite/page.tsx"),
      path.join(sourceRoot, "lib/merchant-invitation/branding.ts"),
      path.join(sourceRoot, "lib/auth/merchant-throttle.ts"),
      path.join(sourceRoot, "lib/merchant-invitation/guard.ts"),
      path.join(sourceRoot, "lib/merchant-invitation/platform-admin.ts"),
      path.join(sourceRoot, "app/actions/platform-invitations.ts"),
      path.join(sourceRoot, "app/platform/invitations/page.tsx"),
    ]);
    const offenders = files.filter((file) => {
      if (allowed.has(file)) return false;
      if (file.includes(`${path.sep}__tests__${path.sep}`)) return false;
      return marker.test(readFileSync(file, "utf8"));
    });

    expect(offenders).toEqual([]);
    expect(
      readFileSync(path.join(sourceRoot, "lib/data/index.ts"), "utf8"),
    ).not.toMatch(/merchant-invitation/);
    expect(readFileSync(servicePath, "utf8")).not.toMatch(/console\./);
  });
});
