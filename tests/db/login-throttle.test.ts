import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  consumeLoginAttempt,
  resetLoginThrottle,
} from "@/lib/auth/login-throttle";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

/**
 * The durable login limiter against real PostgreSQL.
 *
 * The auth HTTP suite proves both credential entry paths share the budget; this
 * file proves the SQL itself: the fixed window, the cap, the expiry path and
 * the single-row storage model.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("login_throttle");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;
  await testDb.db.execute(sql`DELETE FROM admin_login_throttle`);
});

function appDb() {
  return asAppDb(testDb!.db);
}

async function row() {
  const rows = await testDb!.db.execute<{
    attempt_count: number;
    window_started_at: string;
  }>(sql`
    SELECT attempt_count, window_started_at::text AS window_started_at
    FROM admin_login_throttle
    WHERE id = 1
  `);
  return rows[0];
}

describe.skipIf(!shouldRun)("admin login throttle", () => {
  it("allows exactly the configured budget, then denies", async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      const decision = await consumeLoginAttempt(appDb());
      expect(decision.allowed).toBe(true);
    }

    const denied = await consumeLoginAttempt(appDb());

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_WINDOW_SECONDS);
    expect((await row())?.attempt_count).toBe(LOGIN_MAX_ATTEMPTS + 1);
  });

  it("clears the budget after a successful verification", async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      await consumeLoginAttempt(appDb());
    }
    expect((await consumeLoginAttempt(appDb())).allowed).toBe(false);

    await resetLoginThrottle(appDb());

    expect((await row())?.attempt_count).toBe(0);
    expect((await consumeLoginAttempt(appDb())).allowed).toBe(true);
  });

  it("starts a fresh window once the fixed window expires", async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS + 1; i += 1) {
      await consumeLoginAttempt(appDb());
    }

    await testDb!.db.execute(sql`
      UPDATE admin_login_throttle
      SET window_started_at = now() - make_interval(secs => ${LOGIN_WINDOW_SECONDS + 1})
      WHERE id = 1
    `);

    const decision = await consumeLoginAttempt(appDb());

    expect(decision.allowed).toBe(true);
    expect((await row())?.attempt_count).toBe(1);
  });

  it("stores a single row regardless of how many attempts arrive", async () => {
    await Promise.all(
      Array.from({ length: LOGIN_MAX_ATTEMPTS * 4 }, () =>
        consumeLoginAttempt(appDb()),
      ),
    );

    const rows = await testDb!.db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM admin_login_throttle
    `);

    expect(rows[0]?.count).toBe(1);
  });

  it("enforces the singleton and non-negative count constraints in the schema", async () => {
    await expect(
      testDb!.db.execute(sql`
        INSERT INTO admin_login_throttle (id, attempt_count)
        VALUES (2, 0)
      `),
    ).rejects.toThrow();

    await expect(
      testDb!.db.execute(sql`
        INSERT INTO admin_login_throttle (id, attempt_count)
        VALUES (1, -1)
      `),
    ).rejects.toThrow();
  });
});
