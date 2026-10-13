/**
 * The GitHub Actions development-migration runner, proven against real
 * PostgreSQL.
 *
 * `tests/wizard/neon-dev-actions.test.ts` drives the runner's gates and flows
 * with mocks. This file proves the real thing on a real server: the real
 * wire-protocol driver, the real `npm run db:migrate` subprocess, the real
 * committed migration chain — run through the runner against throwaway
 * databases on the disposable cluster.
 *
 * Scenarios, one per owner-facing property:
 *
 *   - an empty development database is inspected read-only, then migrated;
 *   - an already-migrated database is inspected and re-migrated, changing
 *     nothing;
 *   - inspect mode performs no DDL and never calls db:migrate;
 *   - a host other than the pinned development endpoint is refused before any
 *     connection;
 *   - schema drift is refused instead of migrated;
 *   - a failing migration is never reported as success, and a connection
 *     string the subprocess prints is redacted.
 *
 * Never run against anything but the disposable cluster: this file creates and
 * drops databases. It reads `RABET_TEST_PG_URL` and never `DATABASE_URL`, and
 * it never contacts the real `Rabet_dev` — the pinned endpoint host and the
 * committed database name are both overridden to the throwaway target.
 *
 * Every throwaway database is created in `beforeAll` and dropped in `afterAll`,
 * matching the lifecycle the other database suites use: databases are never
 * created mid-test, because a sibling suite snapshots the cluster's database
 * list inside its own test.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { hasTestCluster, testClusterUrl } from "./helpers";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import * as actions from "../../scripts/neon-dev-actions.mjs";

const shouldRun = hasTestCluster();

/** The repository the runner ships in; the subprocesses run from here. */
const repo = process.cwd();

/** The throwaway cluster's base URL and host. */
const clusterUrl = testClusterUrl() ?? "";
const clusterHost = wizard.parsePgUrl(clusterUrl).host ?? "127.0.0.1";

/** A recorded subprocess invocation. */
type CommandCall = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/** The subprocess surface the runner accepts. */
type RunCommand = (opts: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}) => Promise<{ code: number; stdout?: string; stderr?: string }>;

/** A throwaway database on the cluster, with the URL the runner is pinned to. */
type Throwaway = {
  url: string;
  name: string;
  sql: ReturnType<typeof postgres>;
  close(): Promise<void>;
};

/**
 * The environment the runner sees: the ambient environment minus the variables
 * that would make this not a clean run:
 *
 * - `DATABASE_URL` — the runner must receive the target only through
 *   `NEON_DEV_DATABASE_URL`;
 * - `RABET_TEST_PG_URL` — the disposable cluster's variable, which the
 *   sanitized child environment never forwards;
 * - the `GITHUB_*` context variables — this suite exercises the runner's
 *   *database* behavior, and on CI it runs under a `pull_request` event, which
 *   the GitHub-context guard correctly refuses. Presenting a local context
 *   here is the honest model: a test run is not a workflow run. The guard
 *   itself — `workflow_dispatch` only, `main` only — is covered case by case by
 *   tests/wizard/neon-dev-actions.test.ts.
 */
function cleanEnv(url: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key === "DATABASE_URL") continue;
    if (key === "RABET_TEST_PG_URL") continue;
    if (key.startsWith("GITHUB_")) continue;

    env[key] = value;
  }

  env[actions.DEV_URL_ENV] = url;

  return env;
}

/** Pins the runner's expected identity to a throwaway database. */
function pinnedTo(url: string) {
  const parsed = wizard.parsePgUrl(url);

  return {
    expectedHost: parsed.host,
    expectedDbName: parsed.dbname,
  };
}

/**
 * Runs the runner with the real wire-protocol driver and the real subprocess
 * surface, capturing the output instead of streaming it so the test report
 * stays readable.
 */
async function runReal({
  url,
  mode = "inspect",
  confirm = "",
  runCommand,
  pin,
}: {
  url: string;
  mode?: string;
  confirm?: string;
  runCommand?: RunCommand;
  /** The identity the runner is pinned to; defaults to the URL itself. */
  pin?: { expectedHost: string; expectedDbName: string };
}) {
  const output: string[] = [];

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

  const result = await actions.runActions({
    io,
    connect: wizard.createPostgresSql,
    runCommand:
      runCommand ??
      ((opts) => {
        calls.push({ command: opts.command, args: opts.args, env: opts.env });

        return wizard.runCommandReal({ ...opts, onOutput: () => {} });
      }),
    mode,
    confirm,
    env: cleanEnv(url),
    root: repo,
    ...(pin ?? pinnedTo(url)),
  });

  return { result, output: output.join(""), calls };
}

/** Creates a brand-new EMPTY database — no migrations applied to it. */
async function createEmptyDatabase(label: string): Promise<Throwaway> {
  const safeLabel = label.replace(/[^a-z0-9]/gi, "_");
  const name = `rabet_actions_${safeLabel}_${process.pid}_${globalThis.crypto
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

/** The hashes Drizzle recorded, in the order the chain applies them. */
async function appliedHashes(sql: ReturnType<typeof postgres>) {
  try {
    const rows = await sql`select hash from drizzle.__drizzle_migrations order by created_at`;

    return rows.map((row) => String(row.hash));
  } catch (error) {
    // No drizzle schema yet means an empty database — nothing has been applied.
    if (/does not exist/i.test(String((error as Error).message))) return [];

    throw error;
  }
}

/** The public tables on the target, sorted. */
async function appTables(sql: ReturnType<typeof postgres>) {
  const rows = await sql`select table_name as name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name`;

  return rows.map((row) => String(row.name));
}

/** Applies the full committed chain to a throwaway database. */
async function applyChain(db: Throwaway) {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const path = await import("node:path");
  const pool = postgres(db.url, { max: 1 });

  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });
  } finally {
    await pool.end();
  }
}

/**
 * Returns the throwaway database to a completely empty state.
 *
 * Every scenario here needs a different starting state (empty, migrated,
 * drifted), but the file holds exactly ONE database for its whole run —
 * created in `beforeAll`, dropped in `afterAll` — so it never creates a
 * database mid-run, which is what the sibling suites' cluster snapshots would
 * observe. Rebuilding the schemas between scenarios is what makes that
 * possible.
 */
async function resetToEmpty(db: Throwaway) {
  await db.sql`drop schema if exists public cascade`;
  await db.sql`drop schema if exists drizzle cascade`;
  await db.sql`create schema public`;
}

// ---------------------------------------------------------------------------
// One throwaway database, created up front and dropped at the end. A database
// is never created while a sibling suite is mid-test.
// ---------------------------------------------------------------------------

let target: Throwaway | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  expect(clusterHost.length).toBeGreaterThan(0);

  target = await createEmptyDatabase("single");
});

afterAll(async () => {
  await target?.close();

  target = null;
});

/** The single throwaway database, reset to empty for the caller's scenario. */
async function emptyDatabase(): Promise<Throwaway> {
  if (!target) throw new Error("test: the throwaway database was not created");

  await resetToEmpty(target);

  return target;
}

// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun)("inspect mode on real PostgreSQL", () => {
  it("reports an empty database and both pending migrations, writing nothing", async () => {
    const db = await emptyDatabase();

    const before = await appTables(db.sql);

    expect(before).toEqual([]);

    const { result, output, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("empty");
    expect(result.state?.pending).toEqual(wizard.EXPECTED_MIGRATION_TAGS);
    expect(result.state?.unknownTables).toEqual([]);

    // Read-only: no migration command, and the database is untouched.
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(await appTables(db.sql)).toEqual([]);
    expect(await appliedHashes(db.sql)).toEqual([]);

    expect(output).toContain("PostgreSQL");
    expect(output).not.toContain(db.url);
  });

  it("recognizes an already-migrated database and lists nothing pending", async () => {
    const db = await emptyDatabase();

    await applyChain(db);

    const { result, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("configured");
    expect(result.state?.pending).toEqual([]);
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);

    expect(await appliedHashes(db.sql)).toEqual(
      wizard.computeMigrationHashes(repo).map((entry) => entry.hash),
    );
  });

  it("reports schema drift without writing anything", async () => {
    const db = await emptyDatabase();

    await applyChain(db);

    // An object the committed chain never creates.
    await db.sql`create table actions_drift_probe (id integer primary key)`;

    const { result, output, calls } = await runReal({ url: db.url });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.state?.unknownTables).toContain("actions_drift_probe");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(output).toContain("actions_drift_probe");

    // The drift table is still there — the runner did not drop anything.
    const rows = await db.sql`select count(*)::int as n from actions_drift_probe`;

    expect(Number(rows[0].n)).toBe(0);
  });
});

describe.skipIf(!shouldRun)("target identity is enforced on a real URL", () => {
  it("refuses a URL whose host is not the pinned endpoint, before connecting", async () => {
    const db = await emptyDatabase();

    // The URL is otherwise perfectly valid and the cluster is reachable; only
    // the host does not match the pinned identity.
    const otherHost = db.url.replace(/@[^/]+\//, "@localhost/");
    const pin = pinnedTo(db.url);

    expect(otherHost).not.toBe(db.url);
    expect(pin.expectedHost).not.toBe("localhost");

    const { result, calls } = await runReal({ url: otherHost, pin });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
  });

  it("refuses a URL whose database name is not the pinned database", async () => {
    const db = await emptyDatabase();

    const otherName = db.url.replace(/\/[^/]*$/, "/postgres");

    const { result } = await runReal({ url: otherName, pin: pinnedTo(db.url) });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
  });
});

describe.skipIf(!shouldRun)("migrate mode on real PostgreSQL", () => {
  it("applies the committed chain to an empty database and validates it", async () => {
    const db = await emptyDatabase();

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(result.writes.migrationsApplied).toEqual(wizard.EXPECTED_MIGRATION_TAGS);

    const migrateCalls = calls.filter((call) =>
      call.args.join(" ").includes("db:migrate"),
    );

    expect(migrateCalls).toHaveLength(1);

    // The child environment carries the verified URL as DATABASE_URL only.
    expect(migrateCalls[0].env?.DATABASE_URL).toBe(db.url);
    expect(
      Object.keys(migrateCalls[0].env ?? {}).filter((key) => /^NEON/i.test(key)),
    ).toHaveLength(0);
    expect(migrateCalls[0].env?.RABET_TEST_PG_URL).toBeUndefined();

    // The real objects landed and the history matches the committed files.
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

  it("re-runs against an up-to-date database and applies nothing", async () => {
    const db = await emptyDatabase();

    await applyChain(db);

    const marker = `RABET-ACTIONS-MARKER-${globalThis.crypto.randomUUID()}`;

    await db.sql`insert into "language" ("code", "label", "text_direction", "is_enabled")
                values ('zz', ${marker}, 'ltr', false)`;

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("already-configured");
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(await appliedHashes(db.sql)).toHaveLength(
      wizard.EXPECTED_MIGRATION_TAGS.length,
    );

    // Existing data survived untouched.
    const rows = await db.sql`select count(*)::int as n from "language" where "label" = ${marker}`;

    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses to migrate a drifted database", async () => {
    const db = await emptyDatabase();

    await applyChain(db);

    await db.sql`create table migrate_drift_probe (id integer primary key)`;

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
  });

  it("does not report success when the migration command fails, and redacts leaks", async () => {
    const db = await emptyDatabase();

    // A subprocess that fails and echoes a connection string, the way a driver
    // or CLI can. The runner must never relay it.
    const leak = `Error: connection failed: ${db.url}`;

    const calls: CommandCall[] = [];

    const fakeRunCommand: RunCommand = async (opts) => {
      calls.push({ command: opts.command, args: opts.args, env: opts.env });

      const script = opts.args.join(" ");

      if (script.includes("db:check")) return { code: 0, stdout: "", stderr: "" };
      if (script.includes("db:migrate")) {
        return { code: 1, stdout: leak, stderr: "" };
      }

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
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(1);

    // The URL the subprocess printed never reaches the runner's output.
    expect(output).not.toContain(db.url);
    expect(output).toContain("exited with code 1");

    // And the database is still empty — nothing was applied.
    expect(await appTables(db.sql)).toEqual([]);
  });

  it("refuses migrate mode without the confirmation phrase", async () => {
    const db = await emptyDatabase();

    const { result, calls } = await runReal({
      url: db.url,
      mode: "migrate",
      confirm: "nope",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")),
    ).toHaveLength(0);
    expect(await appTables(db.sql)).toEqual([]);
  });
});
