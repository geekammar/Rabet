import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  consumeMerchantThrottle,
  INVITATION_ACCEPT_MAX_ATTEMPTS,
  MERCHANT_SIGN_IN_MAX_ATTEMPTS,
  merchantGlobalSignInKey,
  merchantThrottleKey,
  resetMerchantThrottle,
} from "@/lib/auth/merchant-throttle";
import { createTestDatabase, hasTestCluster, type TestDatabase } from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("merchant_auth_throttle");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`delete from merchant_auth_throttle`);
  await testDb.db.execute(sql`delete from admin_login_throttle`);
});

function executor() {
  return (statement: Parameters<TestDatabase["db"]["execute"]>[0]) =>
    testDb!.db.execute(statement);
}

describe.skipIf(!shouldRun)("merchant auth throttle", () => {
  it("enforces the per-token invitation acceptance budget and reports retry time", async () => {
    const key = merchantThrottleKey("invitation-token-fixture");

    for (let attempt = 1; attempt <= INVITATION_ACCEPT_MAX_ATTEMPTS; attempt++) {
      const decision = await consumeMerchantThrottle(executor(), {
        scope: "invitation_accept",
        key,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }

    const denied = await consumeMerchantThrottle(executor(), {
      scope: "invitation_accept",
      key,
    });

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps preview, acceptance and sign-in budgets independent", async () => {
    const key = merchantThrottleKey("shared-material");
    const decisions = await Promise.all(
      (["invitation_preview", "invitation_accept", "sign_in"] as const).map(
        (scope) => consumeMerchantThrottle(executor(), { scope, key }),
      ),
    );

    expect(decisions.every((decision) => decision.allowed)).toBe(true);

    const global = await consumeMerchantThrottle(executor(), {
      scope: "sign_in_global",
      key: merchantGlobalSignInKey(),
    });

    expect(global.allowed).toBe(true);
  });

  it("enforces the per-identity sign-in budget before Argon2", async () => {
    const key = merchantThrottleKey("merchant@example.test");

    for (let attempt = 1; attempt <= MERCHANT_SIGN_IN_MAX_ATTEMPTS; attempt++) {
      const decision = await consumeMerchantThrottle(executor(), {
        scope: "sign_in",
        key,
      });
      expect(decision.allowed).toBe(true);
    }

    const denied = await consumeMerchantThrottle(executor(), {
      scope: "sign_in",
      key,
    });
    expect(denied.allowed).toBe(false);

    await resetMerchantThrottle(executor(), { scope: "sign_in", key });

    const reset = await consumeMerchantThrottle(executor(), {
      scope: "sign_in",
      key,
    });
    expect(reset.allowed).toBe(true);
  });

  it("does not touch the operator singleton budget", async () => {
    await consumeMerchantThrottle(executor(), {
      scope: "sign_in",
      key: merchantThrottleKey("merchant@example.test"),
    });

    const operatorRows = await testDb!.db.execute(
      sql`select count(*)::int as count from admin_login_throttle`,
    );

    expect(operatorRows[0]).toMatchObject({ count: 0 });
  });

  it("rejects raw keys and unknown scopes at the database boundary", async () => {
    await expect(
      testDb!.db.execute(
        sql`insert into merchant_auth_throttle (scope, key) values ('sign_in', 'raw-email@example.test')`,
      ),
    ).rejects.toThrow();

    await expect(
      testDb!.db.execute(
        sql`insert into merchant_auth_throttle (scope, key) values ('unknown', ${merchantThrottleKey("x")})`,
      ),
    ).rejects.toThrow();
  });
});
