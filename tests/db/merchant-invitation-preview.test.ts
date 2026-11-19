import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import {
  appUser,
  merchantInvitation,
  storeMembership,
} from "@/db/schema";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
  MerchantInvitationError,
  previewMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { createTestDatabase, hasTestCluster, type TestDatabase } from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "preview-merchant-password-123";

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_invitation_preview");
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

async function superAdmin() {
  const [row] = await testDb!.db
    .insert(appUser)
    .values({
      email: `preview-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();
  return row;
}

async function issue(email = "preview.owner@example.test") {
  const actor = await superAdmin();
  const issued = await issueMerchantInvitation(testDb!.db, {
    actorUserId: actor.id,
    storeName: `Preview Store ${crypto.randomUUID()}`,
    storeSlug: `preview-store-${crypto.randomUUID()}`,
    invitedEmail: email,
  });

  return { ...issued, actorUserId: actor.id };
}

describe.skipIf(!shouldRun)("merchant invitation preview", () => {
  it("shows the invited email and store name without consuming the invitation", async () => {
    const issued = await issue();

    const first = await previewMerchantInvitation(testDb!.db, issued.token);
    const second = await previewMerchantInvitation(testDb!.db, issued.token);

    expect(first).toMatchObject({
      invitationId: issued.invitationId,
      storeId: issued.storeId,
      invitedEmail: "preview.owner@example.test",
    });
    expect(first?.storeName).toContain("Preview Store");
    expect(second).toEqual(first);

    const [row] = await testDb!.db
      .select({
        acceptedAt: merchantInvitation.acceptedAt,
        revokedAt: merchantInvitation.revokedAt,
      })
      .from(merchantInvitation)
      .where(eq(merchantInvitation.id, issued.invitationId));

    expect(row).toEqual({ acceptedAt: null, revokedAt: null });
  });

  it("returns the same null result for invalid, expired, revoked and consumed invitations", async () => {
    const issued = await issue();

    expect(await previewMerchantInvitation(testDb!.db, issued.token)).not.toBeNull();
    expect(await previewMerchantInvitation(testDb!.db, "not-a-token")).toBeNull();
    expect(
      await previewMerchantInvitation(
        testDb!.db,
        crypto.randomBytes(32).toString("base64url"),
      ),
    ).toBeNull();

    const expired = await issue("expired.owner@example.test");
    await testDb!.db.execute(sql`
      update merchant_invitation
      set created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      where id = ${expired.invitationId}
    `);
    expect(await previewMerchantInvitation(testDb!.db, expired.token)).toBeNull();

    const revoked = await issue("revoked.owner@example.test");
    await revokeMerchantInvitation(testDb!.db, {
      actorUserId: revoked.actorUserId,
      invitationId: revoked.invitationId,
    });
    expect(await previewMerchantInvitation(testDb!.db, revoked.token)).toBeNull();

    const consumed = await issue("consumed.owner@example.test");
    await acceptMerchantInvitation(testDb!.db, {
      token: consumed.token,
      password: PASSWORD,
    });
    expect(await previewMerchantInvitation(testDb!.db, consumed.token)).toBeNull();
  });

  it("rejects a second submission without creating a second membership", async () => {
    const issued = await issue("second.submit@example.test");

    const accepted = await acceptMerchantInvitation(testDb!.db, {
      token: issued.token,
      password: PASSWORD,
    });

    await expect(
      acceptMerchantInvitation(testDb!.db, {
        token: issued.token,
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(MerchantInvitationError);

    const memberships = await testDb!.db
      .select({ id: storeMembership.id })
      .from(storeMembership)
      .where(
        and(
          eq(storeMembership.userId, accepted.userId),
          eq(storeMembership.storeId, accepted.storeId),
        ),
      );

    expect(memberships).toHaveLength(1);
    expect(await previewMerchantInvitation(testDb!.db, issued.token)).toBeNull();
  });
});
