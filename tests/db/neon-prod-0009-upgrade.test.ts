import crypto from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "@/db/schema";
import * as actions from "../../scripts/neon-prod-actions.mjs";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import { hasTestCluster, testClusterUrl } from "./helpers";

const shouldRun = hasTestCluster();
const repo = process.cwd();
const committed = wizard.computeMigrationHashes(repo);
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$IVqmOMF8kb6Oey9CzBxW6g$W1ORGaoNecXUIAAxF5tB3m6gcbC3d/3Wl/TnTfYI/M0";

type Baseline = {
  databaseName: string;
  databaseUrl: string;
  prefixDir: string;
  pool: ReturnType<typeof postgres> | null;
};

let baseUrl: string | null = null;
let healthy: Baseline | null = null;
let broken: Baseline | null = null;

function throwawayName(label: string) {
  const random = globalThis.crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, byte) => acc + byte.toString(36).padStart(2, "0"), "");

  return `rabet_prod_upgrade_${label}_${process.pid}_${random}`.toLowerCase();
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

async function createDatabase(label: string): Promise<{ name: string; url: string }> {
  const name = throwawayName(label);
  const admin = postgres(baseUrl!, { max: 1 });

  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const parsed = new URL(baseUrl!);
  parsed.pathname = `/${name}`;

  return { name, url: parsed.toString() };
}

async function seedBaseline(pool: ReturnType<typeof postgres>) {
  const suffix = crypto.randomUUID();
  const [admin] = await pool`
    insert into app_user (email, platform_role)
    values (${`prod-upgrade-admin-${suffix}@example.test`}, 'super_admin')
    returning id
  `;
  const [merchant] = await pool`
    insert into app_user (email)
    values (${`prod.upgrade.merchant.${suffix}@example.test`})
    returning id
  `;

  await pool`
    insert into merchant_credential (user_id, password_hash)
    values (${merchant.id}, ${DUMMY_PASSWORD_HASH})
  `;

  const [acceptedStore] = await pool`
    insert into store (name, slug, status)
    values (
      'Production Upgrade Accepted Store',
      ${`prod-upgrade-accepted-${suffix}`},
      'onboarding'
    )
    returning id
  `;
  const [pendingStore] = await pool`
    insert into store (name, slug, status)
    values (
      'Production Upgrade Pending Store',
      ${`prod-upgrade-pending-${suffix}`},
      'onboarding'
    )
    returning id
  `;

  const acceptedDigest = crypto.randomBytes(32).toString("hex");
  const pendingDigest = crypto.randomBytes(32).toString("hex");
  const revokedDigest = crypto.randomBytes(32).toString("hex");

  await pool`
    insert into merchant_invitation (
      store_id, invited_email, token_digest, expires_at,
      invited_by_user_id, accepted_at
    )
    values (
      ${acceptedStore.id},
      'prod.upgrade.accepted@example.test',
      ${acceptedDigest},
      now() + interval '7 days',
      ${admin.id},
      now()
    )
  `;
  await pool`
    insert into merchant_invitation (
      store_id, invited_email, token_digest, expires_at,
      invited_by_user_id
    )
    values (
      ${pendingStore.id},
      'prod.upgrade.pending@example.test',
      ${pendingDigest},
      now() + interval '7 days',
      ${admin.id}
    )
  `;
  await pool`
    insert into merchant_invitation (
      store_id, invited_email, token_digest, expires_at,
      invited_by_user_id, revoked_at
    )
    values (
      ${pendingStore.id},
      'prod.upgrade.revoked@example.test',
      ${revokedDigest},
      now() + interval '7 days',
      ${admin.id},
      now()
    )
  `;
  await pool`
    insert into store_membership (store_id, user_id, role, status)
    values (${acceptedStore.id}, ${merchant.id}, 'owner', 'active')
  `;
  await pool`
    insert into merchant_auth_throttle (
      scope, key, attempt_count, window_started_at
    )
    values (
      'sign_in_global',
      ${crypto.randomBytes(32).toString("hex")},
      1,
      now()
    )
  `;

  return {
    acceptedDigest,
    pendingDigest,
    revokedDigest,
    adminId: admin.id,
    merchantId: merchant.id,
  };
}

async function createBaseline(label: string): Promise<Baseline> {
  const { name, url } = await createDatabase(label);
  const prefixDir = mkdtempSync(path.join(os.tmpdir(), `rabet-0009-prefix-`));

  try {
    cpSync(path.join(repo, "drizzle"), prefixDir, { recursive: true });

    const journalPath = path.join(prefixDir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    writeFileSync(
      journalPath,
      `${JSON.stringify(
        { ...journal, entries: journal.entries.slice(0, 10) },
        null,
        2,
      )}\n`,
    );

    const pool = postgres(url, { max: 2 });
    const db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: prefixDir });
    await seedBaseline(pool);

    return { databaseName: name, databaseUrl: url, prefixDir, pool };
  } catch (error) {
    rmSync(prefixDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeBaseline(baseline: Baseline | null) {
  await baseline?.pool?.end();
  if (baseline?.prefixDir) {
    rmSync(baseline.prefixDir, { recursive: true, force: true });
  }
  if (baseUrl && baseline?.databaseName) {
    const admin = postgres(baseUrl, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${baseline.databaseName}`);
    } finally {
      await admin.end();
    }
  }
}

async function snapshot(baseline: Baseline) {
  const rows = await baseline.pool!`
    select
      (select count(*)::int from app_user) as users,
      (select count(*)::int from merchant_credential) as credentials,
      (select count(*)::int from merchant_invitation) as invitations,
      (select count(*)::int from merchant_invitation where accepted_at is not null) as accepted,
      (select count(*)::int from merchant_invitation where revoked_at is not null) as revoked,
      (select count(*)::int from merchant_invitation where accepted_at is null and revoked_at is null) as pending,
      (select count(*)::int from store_membership where status = 'active') as memberships,
      (select count(*)::int from store) as stores,
      (select count(*)::int from merchant_auth_throttle) as throttle_rows,
      (select password_hash from merchant_credential limit 1) as password_hash,
      (select token_digest from merchant_invitation where accepted_at is not null limit 1) as accepted_token_digest,
      (select token_digest from merchant_invitation where accepted_at is null and revoked_at is null limit 1) as pending_token_digest
  `;

  return rows[0];
}

async function ledger(baseline: Baseline) {
  return baseline.pool!`
    select hash, created_at::text as created_at
    from drizzle.__drizzle_migrations
    order by created_at
  `;
}

async function schemaState(baseline: Baseline) {
  const columns = await baseline.pool!`
    select column_name from information_schema.columns
    where table_schema = 'public'
      and table_name = 'merchant_invitation'
      and column_name = 'revoked_by_user_id'
  `;
  const constraints = await baseline.pool!`
    select conname from pg_constraint
    where conname = 'merchant_invitation_revoked_by_user_id_app_user_id_fk'
  `;

  return {
    revokerColumn: columns.length === 1,
    revokerFk: constraints.length === 1,
  };
}

function runOptions(baseline: Baseline, mode: string) {
  return {
    mode,
    confirm: actions.MIGRATE_CONFIRMATION,
    env: {
      ...process.env,
      GITHUB_ACTIONS: "false",
      [actions.PROD_URL_ENV]: baseline.databaseUrl,
      [actions.EXPECTED_HOST_ENV]: new URL(baseline.databaseUrl).hostname,
      [actions.EXPECTED_DB_NAME_ENV]: baseline.databaseName,
    },
    root: repo,
    expectedHost: new URL(baseline.databaseUrl).hostname,
    expectedDbName: baseline.databaseName,
    allowTestTarget: true,
  };
}

beforeAll(async () => {
  if (!shouldRun) return;

  baseUrl = testClusterUrl()!;
  healthy = await createBaseline("healthy");
  broken = await createBaseline("broken");
  await broken.pool!`drop index merchant_auth_throttle_window_idx`;
});

afterAll(async () => {
  await closeBaseline(healthy);
  await closeBaseline(broken);
  healthy = null;
  broken = null;
});

describe.skipIf(!shouldRun)("real production runner 0009 to 0010 upgrade", () => {
  it("inspect is read-only on a healthy 0009 baseline and validates the throttle objects", async () => {
    const baseline = healthy!;
    const { io, output } = testIo();
    const beforeSnapshot = await snapshot(baseline);
    const beforeLedger = await ledger(baseline);
    let commandCalled = false;

    const result = await actions.runProdActions({
      io,
      connect: (url) => actions.createProdPostgresSql(url),
      runCommand: async () => {
        commandCalled = true;
        return { code: 0 };
      },
      ...runOptions(baseline, "inspect"),
    });

    expect(result.ok, output()).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(commandCalled).toBe(false);
    expect(result.state?.pending).toEqual([
      "0010_wonderful_siren",
      "0011_careless_hulk",
      "0012_mushy_scream",
      "0013_cod_orders",
      "0014_sparkling_captain_stacy",
      "0015_cod_shipping_delivery_collection",
    ]);
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(await snapshot(baseline)).toEqual(beforeSnapshot);
    expect(await ledger(baseline)).toEqual(beforeLedger);
    expect((await schemaState(baseline)).revokerColumn).toBe(false);
    expect(output()).toContain("Validating prior release schema on target");
    expect(output()).toContain("0009_merchant_auth_throttle");
  });

  it("migrate applies only 0010, preserves existing rows, and records the new FK", async () => {
    const baseline = healthy!;
    const { io, output } = testIo();
    const beforeSnapshot = await snapshot(baseline);
    const beforeLedger = await ledger(baseline);
    const executedCommands: string[] = [];

    const result = await actions.runProdActions({
      io,
      connect: (url) => actions.createProdPostgresSql(url),
      runCommand: (options) => {
        executedCommands.push(`${options.command} ${options.args.join(" ")}`);
        return wizard.runCommandReal({ ...options, onOutput: () => {} });
      },
      ...runOptions(baseline, "migrate"),
    });

    expect(result.ok, output()).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(result.writes.migrationsApplied).toEqual([
      "0010_wonderful_siren",
      "0011_careless_hulk",
      "0012_mushy_scream",
      "0013_cod_orders",
      "0014_sparkling_captain_stacy",
      "0015_cod_shipping_delivery_collection",
    ]);
    expect(
      executedCommands.filter((command) => command.includes("db:migrate")),
    ).toHaveLength(1);
    expect(output()).toContain(
      "Verified healthy prior release (0009_merchant_auth_throttle)",
    );
    expect(output()).toContain(
      "Proceeding with migration to 0015_cod_shipping_delivery_collection",
    );

    const afterLedger = await ledger(baseline);
    expect(afterLedger).toHaveLength(16);
    expect(afterLedger.slice(0, beforeLedger.length)).toEqual(beforeLedger);
    expect(afterLedger[10].hash).toBe(
      committed.find((entry) => entry.tag === "0010_wonderful_siren")?.hash,
    );
    expect(afterLedger[11].hash).toBe(
      committed.find((entry) => entry.tag === "0011_careless_hulk")?.hash,
    );
    expect(afterLedger[12].hash).toBe(
      committed.find((entry) => entry.tag === "0012_mushy_scream")?.hash,
    );
    expect(afterLedger[13].hash).toBe(
      committed.find((entry) => entry.tag === "0013_cod_orders")?.hash,
    );
    expect(afterLedger[14].hash).toBe(
      committed.find((entry) => entry.tag === "0014_sparkling_captain_stacy")
        ?.hash,
    );
    expect(afterLedger[15].hash).toBe(
      committed.find(
        (entry) => entry.tag === "0015_cod_shipping_delivery_collection",
      )?.hash,
    );

    const afterSchema = await schemaState(baseline);
    expect(afterSchema).toEqual({ revokerColumn: true, revokerFk: true });
    expect(await snapshot(baseline)).toEqual(beforeSnapshot);
  });

  it("rerunning on the upgraded target is an honest already-configured no-op", async () => {
    const baseline = healthy!;
    const { io, output } = testIo();
    const beforeSnapshot = await snapshot(baseline);
    const beforeLedger = await ledger(baseline);
    const executedCommands: string[] = [];

    const result = await actions.runProdActions({
      io,
      connect: (url) => actions.createProdPostgresSql(url),
      runCommand: (options) => {
        executedCommands.push(`${options.command} ${options.args.join(" ")}`);
        return wizard.runCommandReal({ ...options, onOutput: () => {} });
      },
      ...runOptions(baseline, "migrate"),
    });

    expect(result.ok, output()).toBe(true);
    expect(result.outcome).toBe("already-configured");
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(
      executedCommands.filter((command) => command.includes("db:migrate")),
    ).toEqual([]);
    expect(await snapshot(baseline)).toEqual(beforeSnapshot);
    expect(await ledger(baseline)).toEqual(beforeLedger);
    expect(output()).toContain("already configured");
  });

  it("refuses a broken 0009 baseline before any migration write", async () => {
    const baseline = broken!;
    const { io, output } = testIo();
    const beforeSnapshot = await snapshot(baseline);
    const beforeLedger = await ledger(baseline);
    let commandCalled = false;

    const result = await actions.runProdActions({
      io,
      connect: (url) => actions.createProdPostgresSql(url),
      runCommand: async () => {
        commandCalled = true;
        return { code: 0 };
      },
      ...runOptions(baseline, "migrate"),
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(commandCalled).toBe(false);
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(output()).toContain(
      "does not match the verified prior release schema",
    );
    expect(await snapshot(baseline)).toEqual(beforeSnapshot);
    expect(await ledger(baseline)).toEqual(beforeLedger);
    expect((await schemaState(baseline)).revokerColumn).toBe(false);
  });
});
