import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { sql } from "drizzle-orm";

import {
  ADMIN_CONFIRM_ENV,
  ADMIN_EMAIL_ENV,
  ADMIN_HASH_ENV,
  BOOTSTRAP_CONFIRMATION,
  PlatformAdminBootstrapError,
  bootstrapPlatformAdmin,
} from "../../scripts/neon-prod-bootstrap-admin.mjs";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const TEST_PASSWORD = "production-bootstrap-password-123";
const HASH_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

let testDb: TestDatabase | null = null;
let passwordHash = "";

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("neon_prod_bootstrap_admin");
  passwordHash = await hash(TEST_PASSWORD, HASH_OPTIONS);
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(
    sql`drop trigger if exists fail_bootstrap_credential on merchant_credential`,
  );
  await testDb.db.execute(
    sql`drop function if exists fail_bootstrap_credential()`,
  );
  await testDb.db.execute(sql`delete from merchant_credential`);
  await testDb.db.execute(sql`delete from app_user`);
});

function db() {
  return testDb!.db;
}

function envFor(
  email: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const url = new URL(testDb!.url);

  return {
    NEON_PROD_DATABASE_URL: testDb!.url,
    NEON_PROD_EXPECTED_HOST: url.hostname,
    NEON_PROD_EXPECTED_DB_NAME: testDb!.name,
    [ADMIN_EMAIL_ENV]: email,
    [ADMIN_HASH_ENV]: passwordHash,
    [ADMIN_CONFIRM_ENV]: BOOTSTRAP_CONFIRMATION,
    ...overrides,
  };
}

function bootstrap(email: string, overrides: Record<string, string> = {}) {
  return bootstrapPlatformAdmin({
    env: envFor(email, overrides),
    requireGithubContext: false,
    allowTestTarget: true,
  });
}

async function accountRows(email: string) {
  return db().execute<{
    id: string;
    email: string;
    status: string;
    platform_role: string;
    session_version: number;
    password_hash: string | null;
  }>(sql`
    select
      u.id,
      u.email,
      u.status,
      u.platform_role,
      u.session_version,
      c.password_hash
    from app_user u
    left join merchant_credential c on c.user_id = u.id
    where lower(u.email) = ${email.toLowerCase()}
  `);
}

describe.skipIf(!shouldRun)("production platform admin bootstrap", () => {
  it("creates the named Super Admin and is an idempotent retry with the same hash", async () => {
    const email = "owner.bootstrap@example.test";

    const first = await bootstrap(email);

    expect(first).toMatchObject({
      outcome: "created",
      email,
      platformRole: "super_admin",
    });

    const rows = await accountRows(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email,
      status: "active",
      platform_role: "super_admin",
      password_hash: passwordHash,
    });

    const second = await bootstrap(email);

    expect(second).toMatchObject({
      outcome: "already_provisioned",
      userId: first.userId,
      email,
    });
    expect(await accountRows(email)).toHaveLength(1);
  });

  it("adds a credential to an existing active Super Admin without overwriting anything", async () => {
    const email = "owner.credential@example.test";

    await db().execute(sql`
      insert into app_user (email, status, platform_role)
      values (${email}, 'active', 'super_admin')
    `);

    const result = await bootstrap(email);

    expect(result.outcome).toBe("credential_added");
    const rows = await accountRows(email);
    expect(rows[0].password_hash).toBe(passwordHash);

    const retry = await bootstrap(email);
    expect(retry.outcome).toBe("already_provisioned");
  });

  it("refuses to promote an existing merchant account", async () => {
    const email = "merchant.collision@example.test";

    await db().execute(sql`
      insert into app_user (email, status, platform_role)
      values (${email}, 'active', 'user')
    `);

    await expect(bootstrap(email)).rejects.toMatchObject({
      code: "ROLE_COLLISION",
    });

    const rows = await accountRows(email);
    expect(rows[0]).toMatchObject({
      platform_role: "user",
      password_hash: null,
    });
  });

  it("refuses to overwrite an existing different credential", async () => {
    const email = "owner.different-hash@example.test";
    const differentHash = await hash("different-owner-password-123", HASH_OPTIONS);

    const [account] = await db().execute<{ id: string }>(sql`
      insert into app_user (email, status, platform_role)
      values (${email}, 'active', 'super_admin')
      returning id
    `);
    await db().execute(sql`
      insert into merchant_credential (user_id, password_hash)
      values (${account.id}, ${differentHash})
    `);

    await expect(bootstrap(email)).rejects.toMatchObject({
      code: "CREDENTIAL_COLLISION",
    });

    const rows = await accountRows(email);
    expect(rows[0].password_hash).toBe(differentHash);
  });

  it("refuses to reactivate or overwrite a disabled Super Admin", async () => {
    const email = "owner.disabled@example.test";

    await db().execute(sql`
      insert into app_user (email, status, platform_role)
      values (${email}, 'disabled', 'super_admin')
    `);

    await expect(bootstrap(email)).rejects.toMatchObject({
      code: "STATUS_COLLISION",
    });

    const rows = await accountRows(email);
    expect(rows[0]).toMatchObject({ status: "disabled", password_hash: null });
  });

  it("rolls back the app_user row when the credential insert fails, then retries safely", async () => {
    const email = "owner.rollback@example.test";

    await db().execute(sql`
      create or replace function fail_bootstrap_credential()
      returns trigger as $$
      begin
        raise exception 'forced bootstrap failure';
      end;
      $$ language plpgsql
    `);
    await db().execute(sql`
      create trigger fail_bootstrap_credential
      before insert on merchant_credential
      for each row
      execute function fail_bootstrap_credential()
    `);

    await expect(bootstrap(email)).rejects.toBeInstanceOf(
      PlatformAdminBootstrapError,
    );
    expect(await accountRows(email)).toHaveLength(0);

    await db().execute(
      sql`drop trigger if exists fail_bootstrap_credential on merchant_credential`,
    );
    await db().execute(
      sql`drop function if exists fail_bootstrap_credential()`,
    );

    const retry = await bootstrap(email);
    expect(retry.outcome).toBe("created");
    expect(await accountRows(email)).toHaveLength(1);
  });

  it("rejects a wrong target before opening a connection", async () => {
    let connected = false;
    const env = envFor("owner.wrong-target@example.test", {
      NEON_PROD_EXPECTED_DB_NAME: "not_the_test_database",
    });

    await expect(
      bootstrapPlatformAdmin({
        env,
        connect: () => {
          connected = true;
          throw new Error("must not connect");
        },
        requireGithubContext: false,
        allowTestTarget: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(connected).toBe(false);
    expect(await accountRows("owner.wrong-target@example.test")).toHaveLength(0);
  });
});
