/**
 * The GitHub Actions Production database runner, proven against real PostgreSQL.
 *
 * `tests/wizard/neon-prod-actions.test.ts` drives the runner's gates and flows
 * with test doubles. This file proves the real runner on a real PostgreSQL server:
 * - Real wire-protocol driver with finite timeouts;
 * - Real `npm run db:migrate` subprocess;
 * - Real committed migration chain against throwaway databases on the
 *   disposable service cluster;
 * - Strict target verification, read-only empty inspection, honest repeated no-op,
 *   drift refusal, query failure fail-closed behavior, and output redaction.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { hasTestCluster, testClusterUrl } from "./helpers";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import * as actions from "../../scripts/neon-prod-actions.mjs";

const shouldRun = hasTestCluster();
const repo = process.cwd();

const clusterUrl = testClusterUrl() ?? "";

type CommandCall = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type RunCommand = (opts: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}) => Promise<{ code: number; stdout?: string; stderr?: string }>;

type Throwaway = {
  url: string;
  name: string;
  sql: ReturnType<typeof postgres>;
  close(): Promise<void>;
};

function cleanEnv(
  url: string,
  pin: { expectedHost: string; expectedDbName: string },
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key === "DATABASE_URL") continue;
    if (key === "RABET_TEST_PG_URL") continue;
    if (key.startsWith("GITHUB_")) continue;

    env[key] = value;
  }

  env[actions.PROD_URL_ENV] = url;
  env[actions.EXPECTED_HOST_ENV] = pin.expectedHost;
  env[actions.EXPECTED_DB_NAME_ENV] = pin.expectedDbName;

  return env;
}

function pinnedTo(url: string) {
  const parsed = wizard.parsePgUrl(url);
  return {
    expectedHost: parsed.host,
    expectedDbName: parsed.dbname,
  };
}

async function runReal({
  url,
  mode = "inspect",
  confirm = "",
  runCommand,
  pin,
  allowTestTarget = true,
}: {
  url: string;
  mode?: string;
  confirm?: string;
  runCommand?: RunCommand;
  pin?: { expectedHost: string; expectedDbName: string };
  allowTestTarget?: boolean;
}) {
  const output: string[] = [];
  const targetPin = pin ?? pinnedTo(url);

  const io = {
    line(text = "") {
      output.push(`${String(text)}\n`);
    },
    note(text = "") {
      output.push(`  ${String(text)}\n`);
    },
    header(text = "") {
      output.push(`\n${String(text)}\n`);
    },
  };

  const calls: CommandCall[] = [];

  const result = await actions.runProdActions({
    io,
    connect: (connectUrl) => actions.createProdPostgresSql(connectUrl),
    runCommand:
      runCommand ??
      ((opts) => {
        calls.push({ command: opts.command, args: opts.args, env: opts.env });
        return wizard.runCommandReal({ ...opts, onOutput: () => {} });
      }),
    mode,
    confirm,
    env: cleanEnv(url, targetPin),
    root: repo,
    expectedHost: targetPin.expectedHost,
    expectedDbName: targetPin.expectedDbName,
    allowTestTarget,
  });

  return { result, output: output.join(""), calls };
}

async function createEmptyDatabase(label: string): Promise<Throwaway> {
  const safeLabel = label.replace(/[^a-z0-9]/gi, "_");
  const name = `rabet_actions_prod_${safeLabel}_${process.pid}_${globalThis.crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, byte) => acc + byte.toString(36).padStart(2, "0"), "")}`.toLowerCase();

  const admin = postgres(clusterUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = clusterUrl.replace(/\/[^/]*$/, `/${name}`);
  const sql = postgres(url, { max: 2 });

  return {
    url,
    name,
    sql,
    async close() {
      await sql.end();
      const dropper = postgres(clusterUrl, { max: 1 });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}

async function appTables(sql: ReturnType<typeof postgres>): Promise<string[]> {
  const rows = await sql<Array<{ name: string }>>`
    select table_name as name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `;
  return rows.map((r) => r.name);
}

async function appliedHashes(sql: ReturnType<typeof postgres>): Promise<string[]> {
  const regclass = await sql<Array<{ regclass: string | null }>>`
    select to_regclass('drizzle.__drizzle_migrations') as regclass
  `;
  if (!regclass[0]?.regclass) return [];

  const rows = await sql<Array<{ hash: string }>>`
    select hash from drizzle.__drizzle_migrations order by created_at
  `;
  return rows.map((r) => r.hash);
}

async function resetToEmpty(db: Throwaway): Promise<void> {
  await db.sql.unsafe(`
    drop schema if exists drizzle cascade;
    drop schema if exists public cascade;
    create schema public;
  `);
}

async function applyChain(db: Throwaway): Promise<void> {
  const childEnv = wizard.buildChildEnv(db.url, process.env);
  const result = await wizard.runCommandReal({
    command: "npm",
    args: ["run", "db:migrate"],
    cwd: repo,
    env: childEnv,
    onOutput: () => {},
  });

  if (result.code !== 0) {
    throw new Error(`applyChain failed (code ${result.code}): ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let target: Throwaway | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  target = await createEmptyDatabase("suite");
});

afterAll(async () => {
  if (target) {
    await target.close();
  }
  target = null;
});

async function emptyDatabase(): Promise<Throwaway> {
  if (!target) throw new Error("test: throwaway database was not created");
  await resetToEmpty(target);
  return target;
}

// ---------------------------------------------------------------------------
// Real PostgreSQL Test Cases
// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun)("production runner inspect mode on real PostgreSQL", () => {
  it("reports an empty database read-only, writing nothing", async () => {
    const db = await emptyDatabase();

    const before = await appTables(db.sql);
    expect(before).toEqual([]);

    const { result, output, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("empty");
    expect(result.state?.pending).toEqual(wizard.EXPECTED_MIGRATION_TAGS);
    expect(result.state?.unknownTables).toEqual([]);

    // Zero migration commands run
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(await appTables(db.sql)).toEqual([]);
    expect(await appliedHashes(db.sql)).toEqual([]);

    expect(output).toContain("PostgreSQL");
    expect(output).toContain("Read-only inspection complete");
  });

  it("recognizes an already-migrated database and reports 0 pending", async () => {
    const db = await emptyDatabase();
    await applyChain(db);

    const { result, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("configured");
    expect(result.state?.pending).toEqual([]);
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);

    expect(await appliedHashes(db.sql)).toEqual(
      wizard.computeMigrationHashes(repo).map((entry) => entry.hash),
    );
  });

  it("reports schema drift without modifying anything", async () => {
    const db = await emptyDatabase();
    await applyChain(db);

    await db.sql`create table prod_drift_probe (id integer primary key)`;

    const { result, output, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.state?.unknownTables).toContain("prod_drift_probe");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(output).toContain("prod_drift_probe");

    // Drift table remains intact
    const rows = await db.sql`select count(*)::int as n from prod_drift_probe`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it("fails inspect mode when complete ledger is missing a critical object", async () => {
    const db = await emptyDatabase();
    await applyChain(db);

    // Drop a critical index on the live complete database
    await db.sql`drop index if exists "category_sibling_sort_order_idx"`;

    const { result, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(calls.filter((c) => c.args.join(" ").includes("db:migrate"))).toHaveLength(0);

    const checks = Object.fromEntries(
      result.checks.map((check) => [check.name, check.passed]),
    );
    expect(checks.indexes).toBe(false);
  });

  it("fails inspect mode and reports manual-review when application table exists with empty ledger", async () => {
    const db = await emptyDatabase();
    await db.sql`create schema if not exists drizzle`;
    await db.sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    await db.sql`create table if not exists "language" (id text)`;

    const { result, output, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.state?.status).toBe("drift");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(output).toContain("unmanaged schema");

    // Table remains and ledger stays empty
    expect(await appTables(db.sql)).toEqual(["language"]);
    expect(await appliedHashes(db.sql)).toEqual([]);
  });
});

describe.skipIf(!shouldRun)("production runner target identity on real PostgreSQL", () => {
  it("refuses connection when expected target host mismatches", async () => {
    const db = await emptyDatabase();
    const parsed = wizard.parsePgUrl(db.url);

    const pin = {
      expectedHost: `wrong.${parsed.host}`,
      expectedDbName: parsed.dbname,
    };

    const { result, calls } = await runReal({ url: db.url, pin });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
  });

  it("refuses connection when expected database name mismatches", async () => {
    const db = await emptyDatabase();
    const parsed = wizard.parsePgUrl(db.url);

    const pin = {
      expectedHost: parsed.host,
      expectedDbName: "other_db_name",
    };

    const { result } = await runReal({ url: db.url, pin });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
  });

  it("refuses connection when expected database name case mismatches", async () => {
    const db = await emptyDatabase();
    const parsed = wizard.parsePgUrl(db.url);

    const pin = {
      expectedHost: parsed.host,
      expectedDbName: parsed.dbname.toUpperCase(),
    };

    const { result } = await runReal({ url: db.url, pin });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
  });

  it("refuses loopback host when allowTestTarget is false", async () => {
    const db = await emptyDatabase();

    const { result, output } = await runReal({
      url: db.url,
      allowTestTarget: false,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output).toContain("loopback or test host");
  });
});

describe.skipIf(!shouldRun)("production runner migrate mode on real PostgreSQL", () => {
  it("applies the committed migration chain to empty database and validates live", async () => {
    const db = await emptyDatabase();

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(result.writes.migrationsApplied).toEqual(wizard.EXPECTED_MIGRATION_TAGS);

    const migrateCalls = calls.filter((c) =>
      c.args.join(" ").includes("db:migrate"),
    );
    expect(migrateCalls).toHaveLength(1);
    expect(migrateCalls[0].env?.DATABASE_URL).toBe(db.url);

    // Objects verified on live database
    expect(await appTables(db.sql)).toEqual([...wizard.EXPECTED_TABLES].sort());
    expect(await appliedHashes(db.sql)).toEqual(
      wizard.computeMigrationHashes(repo).map((entry) => entry.hash),
    );

    const checks = Object.fromEntries(
      result.checks.map((check) => [check.name, check.passed]),
    );

    expect(checks.tables).toBe(true);
    expect(checks["migration-history"]).toBe(true);
    expect(checks.indexes).toBe(true);
    expect(checks.constraints).toBe(true);
    expect(checks["recursive-trees"]).toBe(true);
    expect(checks["batch-read-only"]).toBe(true);
  });

  it("executes an honest no-op on an up-to-date database and preserves data", async () => {
    const db = await emptyDatabase();
    await applyChain(db);

    const marker = `PROD-TEST-MARKER-${globalThis.crypto.randomUUID()}`;
    await db.sql`insert into "language" ("code", "label", "text_direction", "is_enabled")
                 values ('xx', ${marker}, 'ltr', false)`;

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("already-configured");
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);

    // Data preserved
    const rows = await db.sql`select count(*)::int as n from "language" where "label" = ${marker}`;
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses migrate mode when confirmation is missing or wrong", async () => {
    const db = await emptyDatabase();

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: "wrong_confirmation",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(await appTables(db.sql)).toEqual([]);
  });

  it("refuses to migrate a drifted database", async () => {
    const db = await emptyDatabase();
    await applyChain(db);

    await db.sql`create table prod_migrate_drift (id integer primary key)`;

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
  });

  it("redacts credentials and fails when migration subprocess fails", async () => {
    const db = await emptyDatabase();
    const leak = `Error: db:migrate failed on connection: ${db.url}`;

    const fakeRunCommand: RunCommand = async (opts) => {
      const script = opts.args.join(" ");
      if (script.includes("db:check")) return { code: 0, stdout: "", stderr: "" };
      if (script.includes("db:migrate")) return { code: 1, stdout: leak, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const { result, output } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      runCommand: fakeRunCommand,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output).not.toContain(db.url);
    expect(output).toContain("exited with code 1");
    expect(await appTables(db.sql)).toEqual([]);
  });

  it("refuses migrate mode when database is in a partial migration state", async () => {
    const db = await emptyDatabase();
    // Simulate partial state: insert ledger row for initial migration but not second migration
    await db.sql`create schema if not exists drizzle`;
    await db.sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    const hashes = wizard.computeMigrationHashes(repo);
    await db.sql`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${hashes[0].hash}, ${hashes[0].when})
    `;
    // Create at least one app table so it's not considered empty
    await db.sql`create table if not exists "language" (id text)`;

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(calls.filter((c) => c.args.join(" ").includes("db:migrate"))).toHaveLength(0);
  });

  it("refuses migrate mode when application table exists with empty ledger", async () => {
    const db = await emptyDatabase();
    await db.sql`create schema if not exists drizzle`;
    await db.sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    await db.sql`create table if not exists "language" (id text)`;

    const { result, output, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.state?.status).toBe("drift");
    expect(
      calls.filter((c) => c.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(output).toContain("unmanaged schema");

    // Table remains and ledger stays empty
    expect(await appTables(db.sql)).toEqual(["language"]);
    expect(await appliedHashes(db.sql)).toEqual([]);
  });
});
