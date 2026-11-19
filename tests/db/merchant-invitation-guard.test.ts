import crypto from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { appUser } from "@/db/schema";
import {
  consumeMerchantThrottle,
  INVITATION_GLOBAL_MAX_ATTEMPTS,
  merchantInvitationGlobalKey,
  merchantThrottleKey,
  THROTTLE_PRUNE_BATCH_SIZE,
} from "@/lib/auth/merchant-throttle";
import { guardInvitationRequest } from "@/lib/merchant-invitation/guard";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
  previewMerchantInvitation,
  revokeMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import { createTestDatabase, hasTestCluster, type TestDatabase } from "./helpers";

const shouldRun = hasTestCluster();
const PASSWORD = "guard-merchant-password-123";

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_invitation_guard");
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

function execute(statement: Parameters<TestDatabase["db"]["execute"]>[0]) {
  return testDb!.db.execute(statement);
}

async function superAdmin() {
  const [row] = await db()
    .insert(appUser)
    .values({
      email: `guard-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();
  return row;
}

async function issue(email = "guard.owner@example.test") {
  const actor = await superAdmin();
  const issued = await issueMerchantInvitation(db(), {
    actorUserId: actor.id,
    storeName: `Guard Store ${crypto.randomUUID()}`,
    storeSlug: `guard-store-${crypto.randomUUID()}`,
    invitedEmail: email,
  });
  return { ...issued, actorUserId: actor.id };
}

async function throttleRows() {
  return db().execute<{
    scope: string;
    key: string;
    attempt_count: number;
  }>(sql`
    select scope, key, attempt_count::int as attempt_count
    from merchant_auth_throttle
    order by scope, key
  `);
}

function guardPreview(token: string) {
  return guardInvitationRequest({
    execute,
    scope: "invitation_preview",
    token,
    inspect: () => previewMerchantInvitation(db(), token),
  });
}

describe.skipIf(!shouldRun)("public invitation request guard", () => {
  it("does not create per-token rows for unknown, expired, revoked or consumed tokens", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await guardPreview(crypto.randomBytes(32).toString("base64url"));
      expect(result.status).toBe("rejected");
    }

    const expired = await issue("guard.expired@example.test");
    await db().execute(sql`
      update merchant_invitation
      set created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      where id = ${expired.invitationId}
    `);
    expect((await guardPreview(expired.token)).status).toBe("rejected");

    const revoked = await issue("guard.revoked@example.test");
    await revokeMerchantInvitation(db(), {
      actorUserId: revoked.actorUserId,
      invitationId: revoked.invitationId,
    });
    expect((await guardPreview(revoked.token)).status).toBe("rejected");

    const consumed = await issue("guard.consumed@example.test");
    await acceptMerchantInvitation(db(), {
      token: consumed.token,
      password: PASSWORD,
    });
    expect((await guardPreview(consumed.token)).status).toBe("rejected");

    const rows = await throttleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "invitation_global",
      key: merchantInvitationGlobalKey(),
      attempt_count: 8,
    });
  });

  it("gives a recognized invitation its own per-token budget", async () => {
    const issued = await issue("guard.valid@example.test");

    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await guardPreview(issued.token);
      expect(result.status).toBe("allowed");
    }

    const denied = await guardPreview(issued.token);
    expect(denied.status).toBe("rate_limited");

    const rows = await throttleRows();
    const scoped = rows.find((row) => row.scope === "invitation_preview");
    const coarse = rows.find((row) => row.scope === "invitation_global");

    expect(scoped?.key).toBe(merchantThrottleKey(issued.token));
    expect(scoped?.attempt_count).toBe(11);
    expect(coarse?.key).toBe(merchantInvitationGlobalKey());
    expect(coarse?.attempt_count).toBe(11);
  });

  it("denies the coarse budget before lookup and creates no per-token row", async () => {
    const issued = await issue("guard.coarse@example.test");

    await db().execute(sql`
      insert into merchant_auth_throttle (scope, key, attempt_count, window_started_at)
      values (
        'invitation_global',
        ${merchantInvitationGlobalKey()},
        ${INVITATION_GLOBAL_MAX_ATTEMPTS + 1},
        now()
      )
    `);

    let inspected = 0;
    const result = await guardInvitationRequest({
      execute,
      scope: "invitation_accept",
      token: issued.token,
      inspect: async () => {
        inspected += 1;
        return previewMerchantInvitation(db(), issued.token);
      },
    });

    expect(result.status).toBe("rate_limited");
    expect(inspected).toBe(0);

    const rows = await throttleRows();
    expect(rows.filter((row) => row.scope === "invitation_accept")).toEqual([]);
  });

  it("fails closed when the limiter is unavailable", async () => {
    const issued = await issue("guard.unavailable@example.test");
    let inspected = 0;

    const result = await guardInvitationRequest({
      execute: async () => {
        throw new Error("limiter unavailable");
      },
      scope: "invitation_preview",
      token: issued.token,
      inspect: async () => {
        inspected += 1;
        return null;
      },
    });

    expect(result.status).toBe("unavailable");
    expect(inspected).toBe(0);
  });

  it("prunes expired throttle rows in a bounded batch", async () => {
    const staleCount = THROTTLE_PRUNE_BATCH_SIZE * 2;
    const values = Array.from({ length: staleCount }, (_, index) => {
      const key = merchantThrottleKey(`stale-${index}`);
      return sql`(${index % 2 === 0 ? "invitation_preview" : "invitation_accept"}, ${key}, 1, now() - interval '2 days')`;
    });

    await db().execute(sql`
      insert into merchant_auth_throttle (scope, key, attempt_count, window_started_at)
      values ${sql.join(values, sql`, `)}
    `);

    await consumeMerchantThrottle(execute, {
      scope: "invitation_global",
      key: merchantInvitationGlobalKey(),
    });

    const remaining = await db().execute<{ count: number }>(sql`
      select count(*)::int as count
      from merchant_auth_throttle
      where window_started_at <= now() - interval '1 day'
    `);

    expect(remaining[0].count).toBe(staleCount - THROTTLE_PRUNE_BATCH_SIZE);
  });
});
