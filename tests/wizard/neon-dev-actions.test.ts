/**
 * Automated tests for the manual GitHub Actions development-migration runner
 * (scripts/neon-dev-actions.mjs).
 *
 * This file drives the runner's *gates and flows* with an injected IO,
 * database and subprocess surface — no network, no Neon account, no real
 * credentials. The SQL and the byte-for-byte history comparison those mocks
 * stand in for are proven against real PostgreSQL by
 * tests/db/neon-dev-actions.test.ts, which runs on the disposable cluster.
 *
 * What is under test here is what the owner cares about: the runner must
 * refuse anything that is not the pinned development target, must never write
 * without the explicit confirmation, must stay read-only in inspect mode, and
 * must never put a connection string in its output.
 */

import { describe, expect, it } from "vitest";

import * as actions from "../../scripts/neon-dev-actions.mjs";
import * as wizard from "../../scripts/setup-neon-dev.mjs";

const root = process.cwd();

/** The real committed chain, read from the repository the runner ships in. */
const committed = wizard.computeMigrationHashes(root);

expect(committed.length).toBe(wizard.EXPECTED_MIGRATION_TAGS.length);

/**
 * A fake endpoint host the committed-credential guard recognizes
 * (tests/wizard/no-committed-credentials.test.ts), so the mock suite can
 * exercise realistic-looking connection strings without ever appearing to
 * commit a real one. The runner is pinned to this host in every run below.
 */
const FIXTURE_HOST = "ep-cool-name-12345.us-east-2.aws.neon.tech";

/** A valid development URL against the pinned endpoint (host is a fixture). */
const GOOD_URL = `postgresql://rabet_owner:s3cret@${FIXTURE_HOST}/rabet_dev`;

/** A pooled endpoint, so the pooled-rejection path gets its own message. */
const POOLED_URL =
  "postgresql://rabet_owner:s3cret@ep-cool-pooler-12345.us-east-2.aws.neon.tech/rabet_dev";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Scenario = {
  dbName?: string;
  appTables: string[];
  applied: Array<{ id: string; hash: string; created_at: string }>;
  totalRows: number;
  indexes: string[];
  constraints: Array<{ name: string; type: string }>;
  treeFks: Array<{ name: string; table_name: string }>;
};

/** A fully configured development database (the state after a good setup). */
function configuredScenario(): Scenario {
  return {
    dbName: actions.EXPECTED_DEV_DB_NAME,
    appTables: [...wizard.EXPECTED_TABLES],
    applied: committed.map((entry, index) => ({
      id: String(index + 1),
      hash: entry.hash,
      created_at: String(entry.when),
    })),
    totalRows: 0,
    indexes: [...wizard.EXPECTED_INDEXES],
    constraints: wizard.CRITICAL_CONSTRAINTS.map((name) => ({ name, type: "c" })),
    treeFks: Object.entries(wizard.EXPECTED_TREE_FKS).map(([table, name]) => ({
      name,
      table_name: table,
    })),
  };
}

/** An empty, never-migrated development database. */
function emptyScenario(): Scenario {
  return {
    dbName: actions.EXPECTED_DEV_DB_NAME,
    appTables: [],
    applied: [],
    totalRows: 0,
    indexes: [],
    constraints: [],
    treeFks: [],
  };
}

/** Evolves the fake database the way a successful `npm run db:migrate` would. */
function applyMigrationsTo(scenario: Scenario) {
  scenario.appTables = [...wizard.EXPECTED_TABLES];
  scenario.applied = committed.map((entry, index) => ({
    id: String(index + 1),
    hash: entry.hash,
    created_at: String(entry.when),
  }));
  scenario.indexes = [...wizard.EXPECTED_INDEXES];
  scenario.constraints = wizard.CRITICAL_CONSTRAINTS.map((name) => ({
    name,
    type: "c",
  }));
  scenario.treeFks = Object.entries(wizard.EXPECTED_TREE_FKS).map(([table, name]) => ({
    name,
    table_name: table,
  }));
}

/**
 * An IO fake that deliberately does NOT redact, so a test can prove the runner
 * redacts itself. Everything the runner writes is recorded verbatim.
 */
function recordingIo() {
  const output: string[] = [];

  return {
    output,
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
}

/** The read-only database surface, driven by a mutable scenario. */
function makeConnect(scenario: Scenario) {
  return async () => {
    return {
      async query(text: string) {
        if (text === wizard.QUERIES.selectOne) return [{ result: 1 }];
        if (text === wizard.QUERIES.currentDatabase)
          return [{ name: scenario.dbName ?? actions.EXPECTED_DEV_DB_NAME }];
        if (text === wizard.QUERIES.pgVersion)
          return [{ version: "PostgreSQL 17.2 on x86_64-pc-linux-gnu" }];
        if (text === wizard.QUERIES.currentUser)
          return [{ name: "rabet_owner" }];
        if (text === wizard.QUERIES.appTables)
          return scenario.appTables.map((name) => ({ name }));
        if (text === wizard.QUERIES.drizzleMigrations) return [...scenario.applied];
        if (text === wizard.QUERIES.indexes)
          return scenario.indexes.map((name) => ({ name }));
        if (text === wizard.QUERIES.constraints) return [...scenario.constraints];
        if (text === wizard.QUERIES.treeFks) return [...scenario.treeFks];
        if (String(text).startsWith("/* rabet:rowcount */"))
          return [{ total: scenario.totalRows }];

        throw new Error(`test: unexpected query: ${String(text).slice(0, 60)}`);
      },

      async batch(statements: string[]) {
        const results = [];

        for (const statement of statements) {
          results.push(await this.query(statement));
        }

        return results;
      },

      async close() {
        // The HTTP driver holds no connection.
      },
    };
  };
}

type CommandCall = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/**
 * A subprocess surface that records every call. `migrateResult` decides what
 * `npm run db:migrate` returns; when it succeeds, the scenario is evolved the
 * way the real command would evolve the database.
 */
function recordingRunCommand(
  calls: CommandCall[],
  scenario: Scenario,
  migrateResult: {
    code: number;
    stdout?: string;
    stderr?: string;
    /** When false, a code-0 command leaves the database untouched. */
    evolve?: boolean;
  } = { code: 0 },
) {
  return async (opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  }) => {
    calls.push({ command: opts.command, args: opts.args, env: opts.env });

    const script = opts.args.join(" ");

    if (script.includes("db:check")) {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (script.includes("db:migrate")) {
      const evolve = migrateResult.evolve ?? migrateResult.code === 0;

      if (migrateResult.code === 0 && evolve) {
        applyMigrationsTo(scenario);
      }

      return migrateResult;
    }

    return { code: 0, stdout: "", stderr: "" };
  };
}

/** Runs the runner with the given scenario and mode. */
async function run({
  scenario,
  mode = "inspect",
  confirm = "",
  url = GOOD_URL,
  env = {},
  migrateResult,
  expectedHost = FIXTURE_HOST,
  expectedDbName,
}: {
  scenario: Scenario;
  mode?: string;
  confirm?: string;
  url?: string;
  env?: Record<string, string>;
  migrateResult?: {
    code: number;
    stdout?: string;
    stderr?: string;
    evolve?: boolean;
  };
  expectedHost?: string;
  expectedDbName?: string;
}) {
  const calls: CommandCall[] = [];
  const io = recordingIo();

  const result = await actions.runActions({
    io,
    connect: makeConnect(scenario),
    runCommand: recordingRunCommand(calls, scenario, migrateResult),
    mode,
    confirm,
    env: { [actions.DEV_URL_ENV]: url, ...env },
    root,
    expectedHost,
    expectedDbName,
  });

  return { result, output: io.output.join(""), calls };
}

const migrateCalls = (calls: CommandCall[]) =>
  calls.filter((call) => call.args.join(" ").includes("db:migrate"));

// ---------------------------------------------------------------------------
// The pinned development target
// ---------------------------------------------------------------------------

describe("target validation happens before any connection", () => {
  it("accepts the pinned direct endpoint with TLS added", () => {
    const result = actions.validateDevUrl(GOOD_URL, { expectedHost: FIXTURE_HOST });

    expect(result.ok).toBe(true);
    expect(result.url).toContain("sslmode=require");
    expect(result.target?.dbname).toBe(actions.EXPECTED_DEV_DB_NAME);
    expect(result.target?.tls).toBe("required");
  });

  it("refuses a host that is not the pinned development endpoint", async () => {
    // A different documented fixture host, so the string is otherwise valid
    // and reachable-looking — only the host does not match the pinned identity.
    const other =
      "postgresql://owner:secret@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev";

    const { result, output, calls } = await run({
      scenario: emptyScenario(),
      url: other,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
    expect(output).toContain("does not point at the approved Rabet development endpoint");
    expect(output).not.toContain("ep-cool-12345");
  });

  it("refuses Neon's pooled endpoint", async () => {
    const { result, output, calls } = await run({
      scenario: emptyScenario(),
      url: POOLED_URL,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
    expect(output).toContain("POOLED endpoint");
  });

  it("refuses a connection string that disables TLS", () => {
    const result = actions.validateDevUrl(`${GOOD_URL}?sslmode=disable`);

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("TLS"))).toBe(true);
  });

  it("refuses a database name that is not the development database", async () => {
    const url = GOOD_URL.replace("/rabet_dev", "/neondb");

    const { result, calls } = await run({ scenario: emptyScenario(), url });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("refuses a live database whose name differs from the string", async () => {
    // The string names rabet_dev; the connected database is something else.
    const scenario = emptyScenario();
    scenario.dbName = "neondb";

    const { result } = await run({ scenario });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
  });

  it("refuses a non-PostgreSQL connection string", () => {
    const result = actions.validateDevUrl("https://example.com/rabet_dev");

    expect(result.ok).toBe(false);
  });

  it("fails closed when the endpoint host changes", () => {
    // The committed constant moves; an unchanged secret must be refused until
    // the constant is updated in a reviewed commit.
    const result = actions.validateDevUrl(GOOD_URL, {
      expectedHost: "ep-new-endpoint.c-6.us-east-2.aws.neon.tech",
    });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

describe("the connection string comes from the environment only", () => {
  it("refuses to run when the secret is not configured", async () => {
    const calls: CommandCall[] = [];
    const io = recordingIo();

    const result = await actions.runActions({
      io,
      connect: makeConnect(emptyScenario()),
      runCommand: recordingRunCommand(calls, emptyScenario()),
      mode: "inspect",
      env: {},
      root,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("not-configured");
    expect(io.output.join("")).toContain(actions.DEV_URL_ENV);
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("never echoes the connection string, even in a failure path", async () => {
    const url = `postgresql://owner:sup3rs3cr3t@${FIXTURE_HOST}/rabet_dev`;

    const { output } = await run({ scenario: emptyScenario(), url });

    expect(output).not.toContain("sup3rs3cr3t");
    expect(output).not.toContain(url);
  });

  it("redacts a connection string a subprocess prints", async () => {
    // A failing drizzle-kit that echoes the URL it was given: the runner must
    // never relay it.
    const leak = `Error: could not connect to ${GOOD_URL}`;

    const { result, output } = await run({
      scenario: emptyScenario(),
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      migrateResult: { code: 1, stdout: leak },
    });

    expect(result.ok).toBe(false);
    expect(output).not.toContain("s3cret");
    expect(output).toContain("postgresql://");
  });
});

// ---------------------------------------------------------------------------
// Mode and confirmation
// ---------------------------------------------------------------------------

describe("mode and confirmation", () => {
  it("defaults to inspect when no mode is given", () => {
    expect(actions.parseMode("").mode).toBe("inspect");
    expect(actions.parseMode(undefined).mode).toBe("inspect");
  });

  it("rejects an unknown mode", () => {
    expect(actions.parseMode("drop").ok).toBe(false);
  });

  it("refuses migrate mode without the exact confirmation phrase", async () => {
    const { result, output, calls } = await run({
      scenario: emptyScenario(),
      mode: "migrate",
      confirm: "yes",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
    expect(output).toContain(actions.MIGRATE_CONFIRMATION);
  });

  it("refuses migrate mode with an empty confirmation", async () => {
    const { result, calls } = await run({
      scenario: emptyScenario(),
      mode: "migrate",
      confirm: "",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("accepts the exact confirmation phrase", () => {
    expect(actions.verifyConfirmation(actions.MIGRATE_CONFIRMATION)).toBe(true);
    expect(actions.verifyConfirmation(`  ${actions.MIGRATE_CONFIRMATION} `)).toBe(true);
    expect(actions.verifyConfirmation("migRate_RABET_DEV")).toBe(false);
    expect(actions.verifyConfirmation("MIGRATE_RABET_DEVA")).toBe(false);
    expect(actions.verifyConfirmation(undefined as unknown as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub context
// ---------------------------------------------------------------------------

describe("GitHub context restrictions", () => {
  it("allows a local run off GitHub", () => {
    expect(actions.validateGithubContext({}).ok).toBe(true);
  });

  it("requires the workflow_dispatch event on GitHub", () => {
    const result = actions.validateGithubContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("workflow_dispatch"))).toBe(true);
  });

  it("requires the main ref on GitHub", () => {
    const result = actions.validateGithubContext({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/feat/something",
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("refs/heads/main"))).toBe(true);
  });

  it("allows a manual run from main on GitHub", () => {
    expect(
      actions.validateGithubContext({
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      }).ok,
    ).toBe(true);
  });

  it("refuses a push-triggered run before any connection", async () => {
    const { result, calls } = await run({
      scenario: emptyScenario(),
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(migrateCalls(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inspect mode — strictly read-only
// ---------------------------------------------------------------------------

describe("inspect mode is strictly read-only", () => {
  it("reports an empty database and both pending migrations", async () => {
    const { result, output, calls } = await run({
      scenario: emptyScenario(),
      mode: "inspect",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("empty");
    expect(result.state?.pending).toEqual(wizard.EXPECTED_MIGRATION_TAGS);
    expect(migrateCalls(calls)).toHaveLength(0);
    expect(output).toContain("read-only");
    expect(output).toContain("no DDL");
  });

  it("reports a configured database with nothing pending", async () => {
    const { result, calls } = await run({
      scenario: configuredScenario(),
      mode: "inspect",
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(result.state?.status).toBe("configured");
    expect(result.state?.pending).toEqual([]);
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("reports the PostgreSQL version and masked target metadata", async () => {
    const { output } = await run({ scenario: configuredScenario() });

    expect(output).toContain("PostgreSQL");
    expect(output).toContain(actions.EXPECTED_DEV_DB_NAME);
    expect(output).toContain("neon.tech");
    // The endpoint is masked — the full host never reaches the log.
    expect(output).not.toContain(FIXTURE_HOST);
  });

  it("reports drift without writing", async () => {
    const scenario = configuredScenario();
    scenario.appTables.push("unexpected_table");

    const { result, calls } = await run({ scenario, mode: "inspect" });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.state?.unknownTables).toContain("unexpected_table");
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("never runs db:check or db:migrate", async () => {
    const { calls } = await run({ scenario: configuredScenario(), mode: "inspect" });

    expect(calls.filter((c) => c.args.join(" ").includes("db:migrate"))).toHaveLength(0);
    expect(calls.filter((c) => c.args.join(" ").includes("db:check"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Migrate mode
// ---------------------------------------------------------------------------

describe("migrate mode applies the chain only after every gate passes", () => {
  it("migrates an empty database and validates the result", async () => {
    const scenario = emptyScenario();
    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(result.writes.migrationsApplied).toEqual(wizard.EXPECTED_MIGRATION_TAGS);
    expect(migrateCalls(calls)).toHaveLength(1);

    // The child environment carries only the verified URL as DATABASE_URL.
    const env = migrateCalls(calls)[0].env;

    expect(env?.DATABASE_URL).toContain("sslmode=require");
    expect(Object.keys(env ?? {}).filter((k) => /^NEON/i.test(k))).toHaveLength(0);
  });

  it("validates instead of writing when nothing is pending", async () => {
    const scenario = configuredScenario();
    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("already-configured");
    expect(migrateCalls(calls)).toHaveLength(0);
    expect(result.writes.migrationsApplied).toEqual([]);
  });

  it("reports only the migrations this run applied", async () => {
    // One migration already applied: only the second one should be reported.
    const scenario = emptyScenario();
    scenario.applied = [
      {
        id: "1",
        hash: committed[0].hash,
        created_at: String(committed[0].when),
      },
    ];
    // A partially-applied database still has the first migration's tables.
    scenario.appTables = [...wizard.EXPECTED_TABLES];
    scenario.indexes = [...wizard.EXPECTED_INDEXES];
    scenario.constraints = wizard.CRITICAL_CONSTRAINTS.map((name) => ({
      name,
      type: "c",
    }));
    scenario.treeFks = Object.entries(wizard.EXPECTED_TREE_FKS).map(([t, name]) => ({
      name,
      table_name: t,
    }));

    const { result } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(result.writes.migrationsApplied).toEqual([wizard.EXPECTED_MIGRATION_TAGS[1]]);
  });

  it("refuses schema drift instead of migrating", async () => {
    const scenario = emptyScenario();
    scenario.appTables.push("unexpected_table");

    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("refuses a migration history that matches nothing committed", async () => {
    const scenario = emptyScenario();
    scenario.appTables = [...wizard.EXPECTED_TABLES];
    scenario.applied = [
      {
        id: "1",
        hash: "0".repeat(64),
        created_at: "1",
      },
    ];

    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("refuses a database ahead of the repository", async () => {
    const scenario = configuredScenario();
    scenario.applied.push({
      id: "3",
      hash: "f".repeat(64),
      created_at: "2",
    });

    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(false);
    expect(migrateCalls(calls)).toHaveLength(0);
  });

  it("does not claim success when the command exits non-zero", async () => {
    const scenario = emptyScenario();

    const { result } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      migrateResult: { code: 1, stderr: "drizzle: error" },
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    // Nothing was applied.
    expect(scenario.appTables).toHaveLength(0);
  });

  it("does not claim success when the command exits 0 but nothing landed", async () => {
    const scenario = emptyScenario();

    const { result, calls } = await run({
      scenario,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      // Exit code 0, but the database is left exactly as it was.
      migrateResult: { code: 0, evolve: false },
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(result.writes.migrationsApplied).toEqual([]);
    expect(scenario.appTables).toHaveLength(0);
    expect(migrateCalls(calls)).toHaveLength(1);
  });

  it("refuses a broken committed chain before connecting", async () => {
    // verifyMigrationFiles fails when the journal is missing; point the runner
    // at a temp directory with no drizzle/ folder.
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmp = mkdtempSync(path.join(os.tmpdir(), "rabet-actions-chain-"));
    writeFileSync(path.join(tmp, "package.json"), '{"name":"rabet"}');

    const calls: CommandCall[] = [];
    const io = recordingIo();

    try {
      const result = await actions.runActions({
        io,
        connect: makeConnect(emptyScenario()),
        runCommand: recordingRunCommand(calls, emptyScenario()),
        mode: "migrate",
        confirm: actions.MIGRATE_CONFIRMATION,
        env: { [actions.DEV_URL_ENV]: GOOD_URL },
        root: tmp,
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("refused");
      expect(migrateCalls(calls)).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
