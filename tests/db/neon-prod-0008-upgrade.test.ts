import crypto from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import * as schema from "@/db/schema";
import * as actions from "../../scripts/neon-prod-actions.mjs";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import { hasTestCluster, testClusterUrl } from "./helpers";

const shouldRun = hasTestCluster();
const repo = process.cwd();
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$IVqmOMF8kb6Oey9CzBxW6g$W1ORGaoNecXUIAAxF5tB3m6gcbC3d/3Wl/TnTfYI/M0";

let baseUrl: string | null = null;
let databaseName = "";
let databaseUrl = "";
let prefixDir = "";
let setupPool: ReturnType<typeof postgres> | null = null;

function throwawayName() {
  const random = globalThis.crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, byte) => acc + byte.toString(36).padStart(2, "0"), "");

  return `rabet_prod_upgrade_${process.pid}_${random}`.toLowerCase();
}

function testIo() {
  const lines: string[] = [];
  return {
    io: {
      line: (text = "") => lines.push(String(text)),
      note: (text = "") => lines.push(`  ${String(text)}`),
      header: (text = "") => lines.push(`\n${String(text)}`),
    },
    output: () => lines.join("\n"),
  };
}

beforeAll(async () => {
  if (!shouldRun) return;

  baseUrl = testClusterUrl()!;
  databaseName = throwawayName();

  const admin = postgres(baseUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  databaseUrl = parsed.toString();

  prefixDir = mkdtempSync(path.join(os.tmpdir(), "rabet-0008-prefix-"));
  cpSync(path.join(repo, "drizzle"), prefixDir, { recursive: true });

  const journalPath = path.join(prefixDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  writeFileSync(
    journalPath,
    `${JSON.stringify(
      { ...journal, entries: journal.entries.slice(0, 9) },
      null,
      2,
    )}\n`,
  );

  setupPool = postgres(databaseUrl, { max: 2 });
  const db = drizzle({ client: setupPool, schema });
  await migrate(db, { migrationsFolder: prefixDir });

  // Seed the literal 0008 baseline with raw SQL. The current invitation
  // service expects the later 0010 column, so it cannot be used to write a
  // baseline row before the upgrade under test.
  const [adminUser] = await db.execute<{ id: string }>(sql`
    insert into app_user (email, platform_role)
    values (${`prod-upgrade-admin-${crypto.randomUUID()}@example.test`}, 'super_admin')
    returning id
  `);
  const [merchantUser] = await db.execute<{ id: string }>(sql`
    insert into app_user (email)
    values ('prod.upgrade.merchant@example.test')
    returning id
  `);

  await db.execute(sql`
    insert into merchant_credential (user_id, password_hash)
    values (${merchantUser.id}, ${DUMMY_PASSWORD_HASH})
  `);

  const [acceptedStore] = await db.execute<{ id: string }>(sql`
    insert into store (name, slug, status)
    values (
      'Production Upgrade Accepted Store',
      ${`prod-upgrade-accepted-${crypto.randomUUID()}`},
      'onboarding'
    )
    returning id
  `);
  await db.execute(sql`
    insert into merchant_invitation (
      store_id, invited_email, token_digest, expires_at,
      invited_by_user_id, accepted_at
    )
    values (
      ${acceptedStore.id},
      'prod.upgrade.merchant@example.test',
      ${crypto.randomBytes(32).toString("hex")},
      now() + interval '7 days',
      ${adminUser.id},
      now()
    )
  `);
  await db.execute(sql`
    insert into store_membership (store_id, user_id, role, status)
    values (${acceptedStore.id}, ${merchantUser.id}, 'owner', 'active')
  `);

  const [pendingStore] = await db.execute<{ id: string }>(sql`
    insert into store (name, slug, status)
    values (
      'Production Upgrade Pending Store',
      ${`prod-upgrade-pending-${crypto.randomUUID()}`},
      'onboarding'
    )
    returning id
  `);
  await db.execute(sql`
    insert into merchant_invitation (
      store_id, invited_email, token_digest, expires_at,
      invited_by_user_id
    )
    values (
      ${pendingStore.id},
      'prod.upgrade.pending@example.test',
      ${crypto.randomBytes(32).toString("hex")},
      now() + interval '7 days',
      ${adminUser.id}
    )
  `);
});

afterAll(async () => {
  await setupPool?.end();

  if (prefixDir) {
    rmSync(prefixDir, { recursive: true, force: true });
  }

  if (baseUrl && databaseName) {
    const admin = postgres(baseUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    } finally {
      await admin.end();
    }
  }
});

describe.skipIf(!shouldRun)("real production runner 0008 to 0010 upgrade", () => {
  it(
    "validates 0008, applies 0009 and 0010, and preserves invitation and credential rows",
    async () => {
      const { io, output } = testIo();
      const before = await setupPool!`
        select
          (select count(*)::int from app_user) as users,
          (select count(*)::int from merchant_credential) as credentials,
          (select count(*)::int from merchant_invitation) as invitations,
          (select count(*)::int from merchant_invitation where accepted_at is not null) as accepted,
          (select count(*)::int from merchant_invitation where accepted_at is null) as pending,
          (select count(*)::int from store_membership where status = 'active') as memberships,
          (select password_hash from merchant_credential limit 1) as password_hash,
          (select token_digest from merchant_invitation where accepted_at is null limit 1) as pending_token_digest
      `;
      const throttleBefore = await setupPool!`
        select to_regclass('public.merchant_auth_throttle') as table_name
      `;

      expect(throttleBefore[0].table_name).toBeNull();

      const result = await actions.runProdActions({
        io,
        connect: (url) => actions.createProdPostgresSql(url),
        runCommand: (options) =>
          wizard.runCommandReal({ ...options, onOutput: () => {} }),
        mode: "migrate",
        confirm: actions.MIGRATE_CONFIRMATION,
        env: {
          ...process.env,
          GITHUB_ACTIONS: "false",
          [actions.PROD_URL_ENV]: databaseUrl,
          [actions.EXPECTED_HOST_ENV]: new URL(databaseUrl).hostname,
          [actions.EXPECTED_DB_NAME_ENV]: databaseName,
        },
        root: repo,
        expectedHost: new URL(databaseUrl).hostname,
        expectedDbName: databaseName,
        allowTestTarget: true,
      });

      expect(result.ok, output()).toBe(true);
      expect(result.outcome).toBe("migrated");
      expect(result.writes.migrationsApplied).toEqual([
        "0009_merchant_auth_throttle",
        "0010_wonderful_siren",
        "0011_careless_hulk",
        "0012_mushy_scream",
        "0013_cod_orders",
      ]);
      expect(output()).toContain(
        "Verified healthy prior release (0008_merchant_invitations_and_credentials)",
      );
      expect(output()).toContain(
        "Proceeding with migration to 0013_cod_orders",
      );

      const after = await setupPool!`
        select
          (select count(*)::int from app_user) as users,
          (select count(*)::int from merchant_credential) as credentials,
          (select count(*)::int from merchant_invitation) as invitations,
          (select count(*)::int from merchant_invitation where accepted_at is not null) as accepted,
          (select count(*)::int from merchant_invitation where accepted_at is null) as pending,
          (select count(*)::int from store_membership where status = 'active') as memberships,
          (select password_hash from merchant_credential limit 1) as password_hash,
          (select token_digest from merchant_invitation where accepted_at is null limit 1) as pending_token_digest
      `;

      expect(after[0]).toEqual(before[0]);

      const throttleAfter = await setupPool!`
        select to_regclass('public.merchant_auth_throttle') as table_name
      `;
      expect(throttleAfter[0].table_name).toBe("merchant_auth_throttle");

      const index = await setupPool!`
        select indexname from pg_indexes
        where schemaname = 'public'
          and indexname = 'merchant_auth_throttle_window_idx'
      `;
      expect(index).toHaveLength(1);

      const revokerColumn = await setupPool!`
        select column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = 'merchant_invitation'
          and column_name = 'revoked_by_user_id'
      `;
      expect(revokerColumn).toHaveLength(1);

      const ledger = await setupPool!`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      expect(ledger[0].count).toBe(14);
    },
    120_000,
  );
});
