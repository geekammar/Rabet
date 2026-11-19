import crypto from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { appUser } from "@/db/schema";
import {
  acceptMerchantInvitation,
  issueMerchantInvitation,
} from "@/lib/merchant-invitation/service";
import * as actions from "../../scripts/neon-prod-actions.mjs";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import { hasTestCluster, testClusterUrl } from "./helpers";

const shouldRun = hasTestCluster();
const repo = process.cwd();
const PASSWORD = "prod-upgrade-merchant-password-123";

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

  const [adminUser] = await db
    .insert(appUser)
    .values({
      email: `prod-upgrade-admin-${crypto.randomUUID()}@example.test`,
      platformRole: "super_admin",
    })
    .returning();

  const accepted = await issueMerchantInvitation(db, {
    actorUserId: adminUser.id,
    storeName: "Production Upgrade Accepted Store",
    storeSlug: `prod-upgrade-accepted-${crypto.randomUUID()}`,
    invitedEmail: "prod.upgrade.merchant@example.test",
  });
  await acceptMerchantInvitation(db, {
    token: accepted.token,
    password: PASSWORD,
  });

  await issueMerchantInvitation(db, {
    actorUserId: adminUser.id,
    storeName: "Production Upgrade Pending Store",
    storeSlug: `prod-upgrade-pending-${crypto.randomUUID()}`,
    invitedEmail: "prod.upgrade.pending@example.test",
  });
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

describe.skipIf(!shouldRun)("real production runner 0008 to 0009 upgrade", () => {
  it(
    "validates 0008, applies only 0009, and preserves invitation and credential rows",
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
      ]);
      expect(output()).toContain(
        "Verified healthy prior release (0008_merchant_invitations_and_credentials)",
      );
      expect(output()).toContain(
        "Proceeding with migration to 0009_merchant_auth_throttle",
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

      const ledger = await setupPool!`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      expect(ledger[0].count).toBe(10);
    },
    120_000,
  );
});
