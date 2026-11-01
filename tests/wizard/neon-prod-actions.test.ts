/**
 * Automated tests for the manual GitHub Actions production-migration runner
 * (scripts/neon-prod-actions.mjs).
 *
 * Drives the runner's gates, flows, and safety properties using injected IO,
 * database, and subprocess surfaces — no real credentials or network connections.
 *
 * Requirements covered:
 * - Target configuration (NEON_PROD_EXPECTED_HOST & NEON_PROD_EXPECTED_DB_NAME)
 *   must be configured before connection;
 * - DEV host, wrong host, wrong db, pooled host, unsafe TLS, and loopback in CLI
 *   are rejected before connection;
 * - Event other than workflow_dispatch and ref other than refs/heads/main are rejected;
 * - Mode migrate requires exact MIGRATE_RABET_PROD confirmation;
 * - Live identity query failure fails closed and never falls back to URL;
 * - Inspection query failures fail closed and are never treated as empty database;
 * - Absent migration ledger is distinguished explicitly from failed reads;
 * - Application tables with absent ledger is reported as schema drift;
 * - Inspect mode on empty database is strictly read-only;
 * - Migrate mode applies committed chain;
 * - Already-configured database is an honest no-op;
 * - Schema drift and mismatched history are refused;
 * - Subprocess failure and validation check failure exit non-zero;
 * - Credentials and connection strings are redacted in output.
 */

import { describe, expect, it } from "vitest";

import * as actions from "../../scripts/neon-prod-actions.mjs";
import * as wizard from "../../scripts/setup-neon-dev.mjs";

const root = process.cwd();
const committed = wizard.computeMigrationHashes(root);

expect(committed.length).toBe(wizard.EXPECTED_MIGRATION_TAGS.length);

/** Pinned fake fixture host recognized by no-committed-credentials test. */
const FIXTURE_HOST = "ep-cool-name-12345.us-east-2.aws.neon.tech";
const FIXTURE_DB = "rabet_production";
const GOOD_URL = `postgresql://rabet_prod_owner:s3cret@${FIXTURE_HOST}/${FIXTURE_DB}?sslmode=require`;
const POOLED_URL = `postgresql://rabet_prod_owner:s3cret@ep-cool-pooler-12345.us-east-2.aws.neon.tech/${FIXTURE_DB}?sslmode=require`;
const DEV_URL = `postgresql://rabet_owner:s3cret@${actions.KNOWN_DEV_HOST}/neondb?sslmode=require`;

// ---------------------------------------------------------------------------
// Test Doubles
// ---------------------------------------------------------------------------

type Scenario = {
  dbName?: string;
  appTables: string[];
  ledgerExists?: boolean;
  applied: Array<{ id: string; hash: string; created_at: string }>;
  totalRows: number;
  indexes: string[];
  constraints: Array<{ name: string; type: string }>;
  treeFks: Array<{ name: string; table_name: string }>;
  throwOnAppTables?: boolean;
  throwOnCurrentDatabase?: boolean;
  throwOnLedgerRead?: boolean;
  throwOnValidationCheck?: boolean;
};

function emptyScenario(): Scenario {
  return {
    dbName: FIXTURE_DB,
    appTables: [],
    ledgerExists: false,
    applied: [],
    totalRows: 0,
    indexes: [],
    constraints: [],
    treeFks: [],
  };
}

function configuredScenario(): Scenario {
  return {
    dbName: FIXTURE_DB,
    appTables: [...wizard.EXPECTED_TABLES],
    ledgerExists: true,
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

function applyMigrationsTo(scenario: Scenario) {
  scenario.appTables = [...wizard.EXPECTED_TABLES];
  scenario.ledgerExists = true;
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
  scenario.treeFks = Object.entries(wizard.EXPECTED_TREE_FKS).map(
    ([table, name]) => ({ name, table_name: table }),
  );
}

function createFakeSql(scenario: Scenario) {
  return {
    async query(statement: string) {
      if (statement.includes("current_database()")) {
        if (scenario.throwOnCurrentDatabase) {
          throw new Error("permission denied: current_database()");
        }
        return [{ name: scenario.dbName ?? FIXTURE_DB }];
      }

      if (statement.includes("version()")) {
        return [{ version: "PostgreSQL 16.2 on x86_64" }];
      }

      if (statement.includes("current_user")) {
        return [{ name: "rabet_prod_owner" }];
      }

      if (statement.includes("to_regclass")) {
        return [{ regclass: scenario.ledgerExists ? "drizzle.__drizzle_migrations" : null }];
      }

      if (statement.includes("information_schema.tables")) {
        if (scenario.throwOnAppTables) {
          throw new Error("query error: failed to query information_schema.tables");
        }
        return scenario.appTables.map((name) => ({ name }));
      }

      if (statement.includes("drizzle.__drizzle_migrations")) {
        if (scenario.throwOnLedgerRead) {
          throw new Error("permission denied: drizzle.__drizzle_migrations");
        }
        return scenario.applied;
      }

      if (statement.includes("/* rabet:rowcount */")) {
        return [{ total: scenario.totalRows }];
      }

      if (statement.includes("pg_indexes")) {
        if (scenario.throwOnValidationCheck) {
          throw new Error("query error: indexes");
        }
        return scenario.indexes.map((name) => ({ name }));
      }

      if (statement.includes("connamespace = 'public'::regnamespace")) {
        return scenario.constraints;
      }

      if (statement.includes("conrelid = confrelid")) {
        return scenario.treeFks;
      }

      if (statement.includes("select 1")) {
        return [{ result: 1 }];
      }

      return [];
    },

    async batch(statements: string[], { readOnly }: { readOnly?: boolean } = {}) {
      if (!readOnly) {
        throw new Error("batch called with readOnly=false");
      }
      return statements.map((stmt) => {
        if (stmt.includes("select 1")) return [{ result: 1 }];
        if (stmt.includes("current_database()")) return [{ name: scenario.dbName ?? FIXTURE_DB }];
        return [];
      });
    },

    async close() {},
  };
}

function testIo() {
  const lines: string[] = [];
  return {
    lines,
    io: {
      line: (text = "") => lines.push(String(text)),
      note: (text = "") => lines.push(`  ${String(text)}`),
      header: (text = "") => lines.push(`\n${String(text)}`),
    },
    output: () => lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("production runner target gates", () => {
  it("fails before connection if expected target host is missing", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: "",
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("NEON_PROD_EXPECTED_HOST");
    expect(output()).toContain("not configured");
  });

  it("fails before connection if expected target database name is missing", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: "",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("NEON_PROD_EXPECTED_DB_NAME");
    expect(output()).toContain("not configured");
  });

  it("fails before connection if NEON_PROD_DATABASE_URL is missing", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("not-configured");
    expect(output()).toContain("NEON_PROD_DATABASE_URL is not configured");
  });

  it("explicitly rejects the known Rabet_dev endpoint in URL", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: DEV_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("known Rabet_dev endpoint");
    expect(output()).toContain(actions.KNOWN_DEV_HOST);
  });

  it("explicitly rejects configuring expected host to the known Rabet_dev endpoint", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: actions.KNOWN_DEV_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: actions.KNOWN_DEV_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("known Rabet_dev endpoint");
  });

  it("rejects pooled migration endpoints", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: POOLED_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("POOLED endpoint");
    expect(output()).toContain("DIRECT / unpooled connection");
  });

  it("rejects loopback and local hosts when allowTestTarget is false", async () => {
    const { io, output } = testIo();
    const loopbackUrl = "postgresql://user:pass@127.0.0.1:5432/db?sslmode=require";
    const env = {
      [actions.PROD_URL_ENV]: loopbackUrl,
      [actions.EXPECTED_HOST_ENV]: "127.0.0.1",
      [actions.EXPECTED_DB_NAME_ENV]: "db",
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: "127.0.0.1",
      expectedDbName: "db",
      allowTestTarget: false,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("loopback or test host");
  });

  it("rejects URL missing sslmode=require", async () => {
    const { io, output } = testIo();
    const noTlsUrl = `postgresql://rabet_prod_owner:s3cret@${FIXTURE_HOST}/${FIXTURE_DB}`;
    const env = {
      [actions.PROD_URL_ENV]: noTlsUrl,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("sslmode=require");
  });

  it("rejects host mismatch against expected host", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: "ep-other-target-999.us-east-2.aws.neon.tech",
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: "ep-other-target-999.us-east-2.aws.neon.tech",
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("does not point at the approved Production endpoint");
  });

  it("rejects database name mismatch against expected database", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: "wrong_database",
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: "wrong_database",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("does not name the approved Production database");
  });
});

describe("production runner GitHub context and mode validation", () => {
  it("rejects events other than workflow_dispatch on GitHub Actions", async () => {
    const { io, output } = testIo();
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("other than workflow_dispatch");
  });

  it("rejects refs other than refs/heads/main on GitHub Actions", async () => {
    const { io, output } = testIo();
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/feat/test-branch",
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("other than refs/heads/main");
  });

  it("rejects migrate mode without exact MIGRATE_RABET_PROD confirmation", async () => {
    const { io, output } = testIo();
    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => {
        throw new Error("connect should not be called without confirmation");
      },
      runCommand: async () => {
        throw new Error("command should not be run");
      },
      mode: "migrate",
      confirm: "wrong_phrase",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(output()).toContain("Migrate mode requires the exact confirmation phrase");
    expect(output()).toContain(actions.MIGRATE_CONFIRMATION);
  });
});

describe("production runner identity and query failure handling", () => {
  it("fails closed if live current_database() query fails (never falls back to URL)", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();
    scenario.throwOnCurrentDatabase = true;

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => ({ code: 0 }),
      mode: "inspect",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output()).toContain("Failed to query identity metadata from live connection");
    expect(output()).toContain("Refusing to fall back to the database name parsed from the URL");
  });

  it("fails closed if application tables query fails (never treats query error as empty)", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();
    scenario.throwOnAppTables = true;

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => ({ code: 0 }),
      mode: "inspect",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output()).toContain("Database inspection query failed");
    expect(output()).toContain("NEVER treated as an empty database");
  });

  it("fails closed if migration ledger read fails when ledger exists", async () => {
    const { io, output } = testIo();
    const scenario = configuredScenario();
    scenario.throwOnLedgerRead = true;

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => ({ code: 0 }),
      mode: "inspect",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output()).toContain("Database inspection query failed");
  });

  it("refuses schema when application tables exist but migration ledger is absent", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();
    scenario.appTables = ["category", "product"];
    scenario.ledgerExists = false;

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => ({ code: 0 }),
      mode: "inspect",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(output()).toContain("Drizzle migration ledger (drizzle.__drizzle_migrations) does not exist");
    expect(output()).toContain("unmanaged schema");
  });
});

describe("production runner flows and execution", () => {
  it("inspect mode on empty database is strictly read-only", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();
    let commandsRun = 0;

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => {
        commandsRun += 1;
        return { code: 0 };
      },
      mode: "inspect",
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("inspected");
    expect(commandsRun).toBe(0);
    expect(output()).toContain("Read-only inspection complete");
    expect(output()).toContain("Pending migrations: 2");
    expect(output()).toContain("No DDL ran, no migration ledger was modified");
  });

  it("migrate mode on empty database applies committed chain", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();
    const executedCommands: string[] = [];

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        executedCommands.push(`${opts.command} ${opts.args.join(" ")}`);
        if (opts.args.includes("db:migrate")) {
          applyMigrationsTo(scenario);
        }
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("migrated");
    expect(executedCommands).toContain("npm run db:check");
    expect(executedCommands).toContain("npm run db:migrate");
    expect(output()).toContain("Production migration complete");
    expect(output()).toContain("Migrations were successfully applied and verified live on the target");
  });

  it("repeated migrate on configured database is an honest no-op", async () => {
    const { io, output } = testIo();
    const scenario = configuredScenario();
    const executedCommands: string[] = [];

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        executedCommands.push(`${opts.command} ${opts.args.join(" ")}`);
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("already-configured");
    // Should NOT call db:migrate
    expect(executedCommands).not.toContain("npm run db:migrate");
    expect(output()).toContain("Production database is already configured");
    expect(output()).toContain("Database was already up to date; no writes were executed");
  });

  it("refuses execution when schema drift exists", async () => {
    const { io, output } = testIo();
    const scenario = configuredScenario();
    scenario.appTables.push("stray_untracked_table");

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async () => ({ code: 0 }),
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(output()).toContain("tables that are not part of the Rabet schema: stray_untracked_table");
  });

  it("fails and does not report success when migration subprocess fails", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        if (opts.args.includes("db:migrate")) {
          return { code: 1, stderr: "error: relation already exists" };
        }
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output()).toContain("npm run db:migrate exited with code 1");
    expect(output()).not.toContain("Production migration complete");
  });

  it("fails and reports manual-review when post-migration inspection detects inconsistent state", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        if (opts.args.includes("db:migrate")) {
          // Fake exit 0, but only 1 table landed while ledger says complete
          scenario.appTables = ["category"];
          scenario.ledgerExists = true;
          scenario.applied = committed.map((e, i) => ({
            id: String(i + 1),
            hash: e.hash,
            created_at: String(e.when),
          }));
        }
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(output()).toContain("FAIL The migration journal says every migration is applied, but the expected tables are missing");
    expect(output()).toContain("Stopped. The runner does not retry ambiguous partial results.");
  });

  it("fails and reports manual-review when post-migration validation checks fail (e.g. missing indexes)", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    const result = await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        if (opts.args.includes("db:migrate")) {
          applyMigrationsTo(scenario);
          // Drop indexes to trigger validation check failure
          scenario.indexes = [];
        }
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("manual-review");
    expect(output()).toContain("One or more validation checks failed after migration");
    expect(output()).toContain("FAIL indexes — missing");
  });

  it("redacts credentials from connection strings and subprocess outputs", async () => {
    const { io, output } = testIo();
    const scenario = emptyScenario();

    const env = {
      [actions.PROD_URL_ENV]: GOOD_URL,
      [actions.EXPECTED_HOST_ENV]: FIXTURE_HOST,
      [actions.EXPECTED_DB_NAME_ENV]: FIXTURE_DB,
    };

    await actions.runProdActions({
      io,
      connect: async () => createFakeSql(scenario),
      runCommand: async (opts) => {
        if (opts.args.includes("db:migrate")) {
          return {
            code: 1,
            stdout: `Connection string: ${GOOD_URL}`,
            stderr: "fatal error with password s3cret",
          };
        }
        return { code: 0 };
      },
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
      env,
      root,
      expectedHost: FIXTURE_HOST,
      expectedDbName: FIXTURE_DB,
    });

    const rendered = output();
    // The raw password "s3cret" in connection string must be redacted
    expect(rendered).not.toContain("s3cret@");
    expect(rendered).toContain("***");
  });
});
