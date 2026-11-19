import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";

import {
  appUser,
  merchantCredential,
  merchantInvitation,
  store,
  storeMembership,
} from "@/db/schema";
import {
  createTransactionClient,
  type TransactionClient,
} from "@/db/transaction-client";
import {
  MERCHANT_INVITATION_REJECTION_MESSAGE,
  MerchantInvitationError,
  acceptMerchantInvitation,
  issueMerchantInvitation,
  revokeMerchantInvitation,
  type MerchantInvitationDb,
} from "@/lib/merchant-invitation/service";
import {
  createTestDatabase,
  hasTestCluster,
  installAcceptanceRollbackFixture,
  removeAcceptanceRollbackFixture,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "transaction-merchant-password-123";

let testDb: TestDatabase | null = null;
let transactionClient: TransactionClient | null = null;
let invitationDb: MerchantInvitationDb | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("merchant_invitation_transaction");

  const runtimeUrl = process.env.DATABASE_URL;

  // Poison the runtime variable so an accidental fallback cannot reach the
  // disposable database. The explicit URL must be the only configuration.
  process.env.DATABASE_URL =
    "postgresql://runtime-must-not-be-used:secret@127.0.0.1:1/runtime";

  try {
    transactionClient = createTransactionClient(testDb.url);
  } finally {
    if (runtimeUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = runtimeUrl;
    }
  }

  const expectedUrl = new URL(testDb.url);

  expect(transactionClient.db.$client.options.database).toBe(testDb.name);
  expect(transactionClient.db.$client.options.host).toEqual([
    expectedUrl.hostname,
  ]);

  invitationDb = transactionClient.db;
});

afterAll(async () => {
  await transactionClient?.close();
  transactionClient = null;
  invitationDb = null;

  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!invitationDb) return;

  await invitationDb.execute(sql`delete from merchant_invitation`);
  await invitationDb.execute(sql`delete from merchant_credential`);
  await invitationDb.execute(sql`delete from store_membership`);
  await invitationDb.execute(sql`delete from app_user`);
  await invitationDb.execute(sql`delete from store`);
});

function db(): MerchantInvitationDb {
  return invitationDb!;
}

async function insertSuperAdmin() {
  const [row] = await db()
    .insert(appUser)
    .values({
      email: `platform-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
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

describe.skipIf(!shouldRun)(
  "Merchant invitations through the real transaction client",
  () => {
    it("issues and accepts an invitation with persisted account, credential and active membership", async () => {
      const superAdmin = await insertSuperAdmin();
      const issued = await issueMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        storeName: "Transaction Client Store",
        storeSlug: `transaction-client-${crypto.randomUUID()}`,
        invitedEmail: "  Transaction.Owner@Example.TEST ",
      });

      const accepted = await acceptMerchantInvitation(db(), {
        token: issued.token,
        password: PASSWORD,
      });

      expect(accepted.storeId).toBe(issued.storeId);
      expect(accepted.email).toBe("transaction.owner@example.test");

      const identities = await db()
        .select()
        .from(appUser)
        .where(eq(appUser.id, accepted.userId));
      const credentials = await db()
        .select()
        .from(merchantCredential)
        .where(eq(merchantCredential.userId, accepted.userId));
      const memberships = await db()
        .select()
        .from(storeMembership)
        .where(eq(storeMembership.id, accepted.membershipId));
      const invitations = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, issued.invitationId));

      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({
        email: "transaction.owner@example.test",
        status: "active",
        platformRole: "user",
      });

      expect(credentials).toHaveLength(1);
      expect(credentials[0].passwordHash).toMatch(/^\$argon2id\$v=19\$/);
      await expect(
        verify(credentials[0].passwordHash, PASSWORD),
      ).resolves.toBe(true);

      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        storeId: issued.storeId,
        userId: accepted.userId,
        role: "owner",
        status: "active",
      });

      expect(invitations).toHaveLength(1);
      expect(invitations[0].acceptedAt).not.toBeNull();
      expect(invitations[0].revokedAt).toBeNull();

      const stores = await db()
        .select({ status: store.status, slug: store.slug })
        .from(store)
        .where(eq(store.id, issued.storeId));

      expect(stores[0]).toEqual({
        status: "onboarding",
        slug: issued.storeSlug,
      });
    });

    it("revokes a pending invitation by id and rejects its acceptance", async () => {
      const superAdmin = await insertSuperAdmin();
      const issued = await issueMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        storeName: "Transaction Revocation Store",
        storeSlug: `transaction-revocation-${crypto.randomUUID()}`,
        invitedEmail: "transaction.revoked@example.test",
      });

      const revoked = await revokeMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        invitationId: issued.invitationId,
      });

      expect(revoked.invitationId).toBe(issued.invitationId);
      expect(revoked.storeId).toBe(issued.storeId);

      const invitations = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, issued.invitationId));

      expect(invitations[0].acceptedAt).toBeNull();
      expect(invitations[0].revokedAt).not.toBeNull();

      const error = await rejectionOf(
        acceptMerchantInvitation(db(), {
          token: issued.token,
          password: PASSWORD,
        }),
      );

      expect(error.code).toBe("INVITATION_REJECTED");
      expect(error.message).toBe(MERCHANT_INVITATION_REJECTION_MESSAGE);

      const identities = await db()
        .select({ id: appUser.id })
        .from(appUser)
        .where(
          sql`lower(${appUser.email}) = ${"transaction.revoked@example.test"}`,
        );
      const credentials = await db()
        .select({ id: merchantCredential.id })
        .from(merchantCredential);
      const memberships = await db()
        .select({ id: storeMembership.id })
        .from(storeMembership);

      expect(identities).toEqual([]);
      expect(credentials).toEqual([]);
      expect(memberships).toEqual([]);
    });

    it("rolls back every acceptance write when the terminal update fails", async () => {
      const superAdmin = await insertSuperAdmin();
      const issued = await issueMerchantInvitation(db(), {
        actorUserId: superAdmin.id,
        storeName: "Transaction Rollback Store",
        storeSlug: `transaction-rollback-${crypto.randomUUID()}`,
        invitedEmail: "transaction.rollback@example.test",
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
      } finally {
        await removeAcceptanceRollbackFixture(db());
      }

      const identities = await db()
        .select({ id: appUser.id })
        .from(appUser)
        .where(
          sql`lower(${appUser.email}) = ${"transaction.rollback@example.test"}`,
        );
      const credentials = await db()
        .select({ id: merchantCredential.id })
        .from(merchantCredential);
      const memberships = await db()
        .select({ id: storeMembership.id })
        .from(storeMembership);
      const invitations = await db()
        .select()
        .from(merchantInvitation)
        .where(eq(merchantInvitation.id, issued.invitationId));

      expect(identities).toEqual([]);
      expect(credentials).toEqual([]);
      expect(memberships).toEqual([]);
      expect(invitations).toHaveLength(1);
      expect(invitations[0].acceptedAt).toBeNull();
      expect(invitations[0].revokedAt).toBeNull();

      const accepted = await acceptMerchantInvitation(db(), {
        token: issued.token,
        password: PASSWORD,
      });

      expect(accepted.storeId).toBe(issued.storeId);
      expect(accepted.email).toBe("transaction.rollback@example.test");
    });
  },
);
