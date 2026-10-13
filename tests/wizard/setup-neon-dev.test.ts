/**
 * Automated tests for the Neon development database setup wizard.
 *
 * The wizard's whole external surface (prompts, the database, subprocesses) is
 * injected, so every flow below drives it with mocks — no Neon account, no
 * network and no real credentials are involved. The SQL the wizard emits is
 * additionally proven against a real, migrated throwaway PostgreSQL cluster by
 * tests/db/wizard-sql.test.ts, which runs in CI's `db` job and via
 * `npm run test:db`.
 *
 * Scenarios covered (see the task list in docs/NEON_DEV_SETUP.md):
 * fresh empty database, already-configured database, invalid URL, unreachable
 * database, retry after network failure, incorrect environment selection,
 * migration already applied, partially applied and drift states, missing local
 * dependencies, safe cancellation, nonzero migration exit code, secret
 * redaction, repeated execution, and the "no accidental production changes"
 * guardrails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import * as wizard from "../../scripts/setup-neon-dev.mjs";

const root = process.cwd();

/** The real committed chain, read from the repository the wizard ships in. */
const committed = wizard.computeMigrationHashes(root);

expect(committed.length).toBe(wizard.EXPECTED_MIGRATION_TAGS.length);

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Scenario = {
  dbName?: string;
  pgVersion?: string;
  role?: string;
  appTables: string[];
  applied: Array<{ id: string; hash: string; created_at: string }>;
  totalRows: number;
  indexes: string[];
  constraints: Array<{ name: string; type: string }>;
  treeFks: Array<{ name: string; table_name: string }>;
  connectFailures?: number;
  connectError?: Error;
};

type RunResult = {
  code: number;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
};

type CommandCall = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
};

/** A fully configured development database (the state after a good setup). */
function configuredScenario(): Scenario {
  return {
    dbName: "rabet_dev",
    pgVersion: "PostgreSQL 17.2 on x86_64-pc-linux-gnu",
    role: "rabet_owner",
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
    dbName: "rabet_dev",
    pgVersion: "PostgreSQL 17.2 on x86_64-pc-linux-gnu",
    role: "rabet_owner",
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
  scenario.treeFks = Object.entries(wizard.EXPECTED_TREE_FKS).map(
    ([table, name]) => ({ name, table_name: table }),
  );
}

/** The read-only database surface, driven by a mutable scenario. */
function makeConnect(scenario: Scenario) {
  let attempts = 0;

  return async () => {
    attempts += 1;

    if (attempts <= (scenario.connectFailures ?? 0)) {
      throw (
        scenario.connectError ??
        new Error("fetch failed: Network request failed")
      );
    }

    return {
      async query(text: string) {
        if (text === wizard.QUERIES.selectOne) return [{ result: 1 }];
        if (text === wizard.QUERIES.currentDatabase)
          return [{ name: scenario.dbName ?? "rabet_dev" }];
        if (text === wizard.QUERIES.pgVersion)
          return [{ version: scenario.pgVersion ?? "PostgreSQL 17.2" }];
        if (text === wizard.QUERIES.currentUser)
          return [{ name: scenario.role ?? "rabet_owner" }];
        if (text === wizard.QUERIES.appTables)
          return scenario.appTables.map((name) => ({ name }));
        if (text === wizard.QUERIES.drizzleMigrations)
          return [...scenario.applied];
        if (text === wizard.QUERIES.indexes)
          return scenario.indexes.map((name) => ({ name }));
        if (text === wizard.QUERIES.constraints)
          return [...scenario.constraints];
        if (text === wizard.QUERIES.treeFks) return [...scenario.treeFks];
        if (String(text).startsWith("/* rabet:rowcount */"))
          return [{ total: scenario.totalRows }];

        throw new Error(`test: unexpected query: ${String(text).slice(0, 60)}`);
      },

      async batch(statements: string[]) {
        // The real driver sends one read-only HTTP request for the batch.
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

/**
 * The Neon HTTP API surface, driven by the same mutable scenario.
 *
 * The wizard keeps this transport separate from the wire-protocol connection
 * above — the application speaks HTTP at runtime while `drizzle-kit migrate`
 * speaks the wire protocol — so the two are faked independently and the tests
 * can assert the wizard reports them as separate checks.
 */
function makeHttpConnect(scenario: Scenario) {
  return () => ({
    async batch(statements: string[]) {
      const results: unknown[][] = [];

      for (const statement of statements) {
        if (statement === wizard.QUERIES.selectOne) {
          results.push([{ result: 1 }]);
        } else if (statement === wizard.QUERIES.currentDatabase) {
          results.push([{ name: scenario.dbName ?? "rabet_dev" }]);
        } else {
          throw new Error(
            `test: unexpected http statement: ${String(statement).slice(0, 60)}`,
          );
        }
      }

      return results;
    },

    async close() {
      // The HTTP driver holds no connection.
    },
  });
}

/**
 * Answers consumed in order. Prompts throw when nothing is queued, so a flow
 * that asks for something unexpected fails loudly instead of hanging.
 *
 * `exhausted` models an interrupted session: `isInputExhausted()` reports the
 * input stream has ended, which is how the real IO behaves when SSH dies or a
 * piped stdin runs out.
 */
function fakeIo(answers: string[] = [], { exhausted = false } = {}) {
  const queue = [...answers];
  const output: string[] = [];
  const prompts: string[] = [];
  let index = 0;

  const take = (message: string) => {
    prompts.push(message);

    const value = queue[index++];

    if (value === undefined) {
      throw new wizard.CancelledError(
        `test: no answer queued for prompt: ${message}`,
      );
    }

    return value;
  };

  return {
    output,
    prompts,
    answers: queue,

    write(text: string) {
      output.push(String(text));
    },

    line(text = "") {
      output.push(`${text}\n`);
    },

    async prompt({ message }: { message: string }) {
      return String(take(message)).trim();
    },

    async confirm({
      message,
      default: defaultValue = false,
    }: {
      message: string;
      default?: boolean;
    }) {
      return wizard.parseYesNo(take(message), defaultValue);
    },

    async confirmStrong({
      message,
      expected,
    }: {
      message: string;
      expected: string;
    }) {
      return take(message) === expected;
    },

    isInputExhausted() {
      return exhausted;
    },
  };
}

function fakeRunner(overrides: Record<string, RunResult> = {}) {
  const calls: CommandCall[] = [];

  const defaults: Record<string, RunResult> = {
    "git remote get-url origin": {
      code: 0,
      stdout: "https://github.com/geekammar/Rabet.git\n",
    },
    "git rev-parse --show-toplevel": { code: 0, stdout: `${root}\n` },
    "git status --porcelain": { code: 0, stdout: "" },
    "git rev-parse HEAD": {
      code: 0,
      stdout: "a798c5e28975266e6ff6521eecaa5fb48a14459f\n",
    },
    "npm --version": { code: 0, stdout: "10.9.9\n" },
    "npm run db:check": { code: 0, stdout: "Everything's fine 🐶🔥\n" },
    "npm run db:migrate": {
      code: 0,
      stdout: "[✓] migrations applied successfully!\n",
    },
    "npm ci": { code: 0, stdout: "added 300 packages in 4s\n" },
    "vercel --version": { code: 1, stderr: "vercel: command not found" },
    "vercel whoami": { code: 1, stderr: "Error: not logged in" },
    "vercel env add DATABASE_URL preview": { code: 0, stdout: "Added\n" },
  };

  return async (opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    stdin?: string;
  }) => {
    calls.push({
      command: opts.command,
      args: opts.args,
      env: opts.env,
      stdin: opts.stdin,
    });

    const key = [opts.command, ...opts.args].join(" ");
    const result = overrides[key] ?? defaults[key];

    if (!result) throw new Error(`test: unexpected command: ${key}`);

    return {
      code: result.code,
      signal: result.signal ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

/** A runner whose successful `db:migrate` evolves the fake database. */
function migratingRunner(
  scenario: Scenario,
  overrides: Record<string, RunResult> = {},
  calls: CommandCall[] = [],
) {
  const inner = fakeRunner(overrides);

  return async (opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    stdin?: string;
  }) => {
    calls.push({
      command: opts.command,
      args: opts.args,
      env: opts.env,
      stdin: opts.stdin,
    });

    const key = [opts.command, ...opts.args].join(" ");
    const result = await inner(opts);

    if (key === "npm run db:migrate" && result.code === 0) {
      applyMigrationsTo(scenario);
    }

    return result;
  };
}

/** Runs the wizard end to end against the given scenario and answers. */
async function run(scenario: Scenario, answers: string[], options = {}) {
  const io = fakeIo(answers);
  const calls: CommandCall[] = [];
  const runCommand = migratingRunner(scenario, {}, calls);

  const result = await wizard.runWizard({
    io,
    connect: makeConnect(scenario),
    httpConnect: makeHttpConnect(scenario),
    runCommand,
    options,
    root,
    env: {},
  });

  return { result, output: io.output.join(""), calls, io };
}

// ---------------------------------------------------------------------------
// Credential hygiene — no secret can ever reach output
// ---------------------------------------------------------------------------

describe("credential hygiene", () => {
  const secretUrl =
    "postgresql://rabet_owner:super-secret-password@ep-cool-name-12345.us-east-2.aws.neon.tech/rabet_dev";

  it("removes the password when masking a connection string", () => {
    expect(wizard.maskUrl(secretUrl)).not.toContain("super-secret-password");
    expect(wizard.maskUrl(secretUrl)).toContain("rabet_owner:***@");
    expect(wizard.maskUrl(secretUrl)).toContain("/rabet_dev");
  });

  it("keeps only the sslmode parameter when masking", () => {
    const masked = wizard.maskUrl(`${secretUrl}?sslmode=require&options=--x`);

    expect(masked).toContain("sslmode=require");
    expect(masked).not.toContain("options");
  });

  it("masks the endpoint host to its prefix and region", () => {
    expect(wizard.maskEndpoint("ep-cool-name-12345.us-east-2.aws.neon.tech")).toBe(
      "ep-cool-***.us-east-2.aws.neon.tech",
    );
    expect(wizard.maskEndpoint("localhost")).toBe("localhost");
  });

  it("redacts every connection string in arbitrary text", () => {
    const text = `failed to connect using ${secretUrl} (see ${secretUrl})`;

    expect(wizard.redact(text)).not.toContain("super-secret-password");
    expect(wizard.redact(text).split("rabet_owner:***@").length).toBe(3);
  });

  it("redacts non-string values without throwing", () => {
    expect(wizard.redact(undefined as unknown as string)).toBeUndefined();
  });

  it("parses postgres and postgresql schemes, ports and query strings", () => {
    const parsed = wizard.parsePgUrl(
      "postgres://user:pw@ep-abc.eu-central-1.aws.neon.tech:5432/rabet_dev?sslmode=require",
    );

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.scheme).toBe("postgres://");
      expect(parsed.user).toBe("user");
      expect(parsed.password).toBe("pw");
      expect(parsed.host).toBe("ep-abc.eu-central-1.aws.neon.tech");
      expect(parsed.port).toBe("5432");
      expect(parsed.dbname).toBe("rabet_dev");
      expect(parsed.params).toBe("sslmode=require");
    }
  });

  it("parses an IPv6 host and a loopback host", () => {
    const v6 = wizard.parsePgUrl(
      "postgresql://u:p@[2001:db8::1]:5432/rabet_dev",
    );

    expect(v6.ok).toBe(true);

    if (v6.ok) {
      expect(v6.host).toBe("2001:db8::1");
      expect(v6.port).toBe("5432");
    }

    const local = wizard.parsePgUrl("postgresql://u:p@localhost:5432/dev");

    expect(local.ok).toBe(true);
  });

  it("rejects a non-PostgreSQL scheme with dashboard guidance", () => {
    const parsed = wizard.parsePgUrl("https://console.neon.tech/rabet_dev");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain("postgresql://");
  });

  it("rejects a string without credentials", () => {
    const parsed = wizard.parsePgUrl("postgresql://ep-abc.neon.tech/rabet_dev");

    expect(parsed.ok).toBe(false);
  });

  it("requires a database name", () => {
    const parsed = wizard.validateConnectionUrl(
      "postgresql://u:p@ep-abc.neon.tech/",
    );

    expect(parsed.ok).toBe(false);
  });

  it("adds sslmode=require to an external URL and says so", () => {
    const validated = wizard.validateConnectionUrl(
      "postgresql://u:p@ep-abc.neon.tech/rabet_dev",
    );

    expect(validated.ok).toBe(true);

    if (validated.ok) {
      expect(validated.url).toContain("sslmode=require");
      expect(validated.warnings.join(" ")).toContain("sslmode=require");
    }
  });

  it("leaves a loopback URL alone", () => {
    const validated = wizard.validateConnectionUrl(
      "postgresql://u:p@localhost:5432/rabet_dev",
    );

    expect(validated.ok).toBe(true);

    if (validated.ok) expect(validated.url).not.toContain("sslmode");
  });

  it("refuses TLS-disabled external connections", () => {
    const validated = wizard.validateConnectionUrl(
      "postgresql://u:p@ep-abc.neon.tech/rabet_dev?sslmode=disable",
    );

    expect(validated.ok).toBe(false);
  });

  it("warns when a password is missing", () => {
    const validated = wizard.validateConnectionUrl(
      "postgresql://u@ep-abc.neon.tech/rabet_dev",
    );

    expect(validated.ok).toBe(true);
    expect(validated.warnings.length).toBeGreaterThan(0);
  });

  it("turns connection errors into credential-free guidance", () => {
    const described = wizard.describeConnectionError(
      new Error("password authentication failed for user rabet_owner"),
    );

    expect(described).not.toContain("rabet_owner");
    expect(described).toContain("Rabet_dev → Connection Details");
  });

  it("never includes a connection string in network-error guidance", () => {
    const described = wizard.describeConnectionError(
      new Error(`fetch failed for ${secretUrl}`),
    );

    expect(described).not.toContain("super-secret-password");
  });
});

// ---------------------------------------------------------------------------
// Child-process environment
// ---------------------------------------------------------------------------

describe("child-process environment", () => {
  it("forwards only neutral keys plus the verified URL", () => {
    const env = wizard.buildChildEnv("postgresql://u:p@host/dev", {
      PATH: "/usr/bin",
      HOME: "/root",
      AUTH_SECRET: "secret",
      ADMIN_PASSWORD_HASH: "$argon2id$...",
      RABET_TEST_PG_URL: "postgresql://rabet@127.0.0.1:5432/postgres",
      DATABASE_URL: "postgresql://prod-user:pw@host/prod",
    });

    expect(env.DATABASE_URL).toBe("postgresql://u:p@host/dev");
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.keys(env).sort()).toEqual(
      ["DATABASE_URL", "HOME", "PATH"].sort(),
    );
  });

  it("never forwards the disposable-test-cluster variable", () => {
    const env = wizard.buildChildEnv("postgresql://u:p@host/dev", {
      RABET_TEST_PG_URL: "postgresql://rabet@127.0.0.1:5432/postgres",
    });

    expect(env.RABET_TEST_PG_URL).toBeUndefined();
  });

  it("drops admin and auth secrets from the child env", () => {
    const env = wizard.buildChildEnv("postgresql://u:p@host/dev", {
      AUTH_SECRET: "do-not-leak",
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD_HASH: "hash",
    });

    expect(env.AUTH_SECRET).toBeUndefined();
    expect(env.ADMIN_EMAIL).toBeUndefined();
    expect(env.ADMIN_PASSWORD_HASH).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// State classification — the decision core
// ---------------------------------------------------------------------------

describe("state classification", () => {
  function classify(overrides: Partial<Parameters<typeof wizard.classifyDbState>[0]>) {
    return wizard.classifyDbState({
      appTables: [],
      appliedMigrations: [],
      committedHashes: committed,
      journal: { entries: committed.map((entry, index) => ({ idx: index, tag: entry.tag, when: entry.when })) },
      totalRows: 0,
      ...overrides,
    });
  }

  it("calls an empty database empty", () => {
    expect(classify({ appTables: [] }).status).toBe("empty");
  });

  it("calls a fully migrated database configured", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES],
      appliedMigrations: committed.map((entry, index) => ({
        id: index + 1,
        hash: entry.hash,
        created_at: entry.when,
      })),
    });

    expect(state.status).toBe("configured");
    expect(state.pending.length).toBe(0);
  });

  it("reports the remaining migrations for a partially applied chain", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES],
      appliedMigrations: [
        { id: 1, hash: committed[0].hash, created_at: committed[0].when },
      ],
    });

    expect(state.status).toBe("partial");
    expect(state.pending).toEqual([committed[1].tag]);
  });

  it("stops on unknown tables", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES, "unexpected_table"],
    });

    expect(state.status).toBe("drift");
    expect(state.stopReason).toContain("unexpected_table");
  });

  it("stops when the database is ahead of the repository", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES],
      appliedMigrations: [
        ...committed.map((entry, index) => ({
          id: index + 1,
          hash: entry.hash,
          created_at: entry.when,
        })),
        { id: 3, hash: "not-a-committed-file-hash", created_at: 2 },
      ],
    });

    expect(state.status).toBe("drift");
  });

  it("stops on an applied history that matches no committed file", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES],
      appliedMigrations: [{ id: 1, hash: "deadbeef", created_at: 1 }],
    });

    expect(state.status).toBe("drift");
  });

  it("stops when the journal says complete but tables are missing", () => {
    const state = classify({
      appTables: wizard.EXPECTED_TABLES.slice(0, 5),
      appliedMigrations: committed.map((entry, index) => ({
        id: index + 1,
        hash: entry.hash,
        created_at: entry.when,
      })),
    });

    expect(state.status).toBe("inconsistent");
    expect(state.stopReason).toContain("missing");
  });

  it("detects existing application data", () => {
    const state = classify({
      appTables: [...wizard.EXPECTED_TABLES],
      appliedMigrations: committed.map((entry, index) => ({
        id: index + 1,
        hash: entry.hash,
        created_at: entry.when,
      })),
      totalRows: 42,
    });

    expect(state.hasData).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration files on disk
// ---------------------------------------------------------------------------

describe("committed migration files", () => {
  it("reads the journal and finds every file and snapshot", () => {
    const journal = wizard.readJournal(root);

    expect(journal.ok).toBe(true);

    if (journal.ok) {
      expect(journal.entries.map((entry) => entry.tag)).toEqual(
        wizard.EXPECTED_MIGRATION_TAGS,
      );
    }

    const files = wizard.verifyMigrationFiles(root);

    expect(files.ok).toBe(true);
    expect(files.problems.length).toBe(0);
  });

  it("computes hashes that match what Drizzle records", () => {
    // Verified against a real migrated throwaway cluster: the recorded
    // drizzle.__drizzle_migrations.hash is the sha256 of the committed file.
    expect(committed.map((entry) => entry.hash)).toEqual([
      "86cb09f9965ded128acf4a4c61b8e2cfb0f0ee182fd419e41d82254537383fa1",
      "65e31ff2a8efa943344fb7499e48dfb771b5ac007cc9bc982b0790fdd3ab3946",
    ]);
  });

  it("reports a missing migration file", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "rabet-wizard-"));

    try {
      cpSync(path.join(root, "drizzle"), path.join(tmp, "drizzle"), {
        recursive: true,
      });
      rmSync(path.join(tmp, "drizzle", `${committed[1].tag}.sql`));

      const files = wizard.verifyMigrationFiles(tmp);

      expect(files.ok).toBe(false);
      expect(files.problems.join(" ")).toContain(committed[1].tag);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports an unexpected migration file with no journal entry", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "rabet-wizard-"));

    try {
      cpSync(path.join(root, "drizzle"), path.join(tmp, "drizzle"), {
        recursive: true,
      });
      writeFileSync(
        path.join(tmp, "drizzle", "0002_unexpected.sql"),
        "select 1;\n",
      );

      const files = wizard.verifyMigrationFiles(tmp);

      expect(files.ok).toBe(false);
      expect(files.problems.join(" ")).toContain("0002_unexpected");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("yes/no parsing", () => {
  it("uses the default on an empty answer", () => {
    expect(wizard.parseYesNo("", false)).toBe(false);
    expect(wizard.parseYesNo("", true)).toBe(true);
    expect(wizard.parseYesNo(undefined, true)).toBe(true);
  });

  it("accepts y, yes and any case", () => {
    expect(wizard.parseYesNo("Y")).toBe(true);
    expect(wizard.parseYesNo("yes")).toBe(true);
    expect(wizard.parseYesNo("n")).toBe(false);
    expect(wizard.parseYesNo("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end flows with mocks
// ---------------------------------------------------------------------------

describe("wizard flows", () => {
  it("sets up a fresh empty development database", async () => {
    const scenario = emptyScenario();

    const { result, output, calls } = await run(
      scenario,
      [
        // [3/7] the direct connection string
        "postgresql://rabet_owner:dev-password@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
        // [3/7] confirm this is the dedicated Rabet_dev database
        "y",
        // [6/7] approve the migration (default is no)
        "y",
        // optional: save to .env.local
        "n",
      ],
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("configured");
    expect(result.writes.migrationsApplied).toEqual(
      wizard.EXPECTED_MIGRATION_TAGS,
    );
    expect(output).toContain("Development database setup complete");

    const migrated = calls.filter((call) =>
      call.args.join(" ").includes("db:migrate"),
    );

    expect(migrated.length).toBe(1);
  });

  it("runs db:migrate with the sanitized env carrying the verified URL", async () => {
    const scenario = emptyScenario();
    const url =
      "postgresql://rabet_owner:dev-password@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev";

    const { calls } = await run(scenario, [url, "y", "y", "n"]);

    const migration = calls.find((call) =>
      call.args.join(" ").includes("db:migrate"),
    );

    expect(migration?.env?.DATABASE_URL).toBe(`${url}?sslmode=require`);
    expect(migration?.env?.RABET_TEST_PG_URL).toBeUndefined();

    for (const [key] of Object.entries(migration?.env ?? {})) {
      expect(key).not.toMatch(/^(AUTH_|ADMIN_)/);
    }
  });

  it("reports an already configured database and writes nothing", async () => {
    const scenario = configuredScenario();

    const { result, output, calls } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "n",
    ]);

    expect(result.ok).toBe(true);
    expect(output).toContain("already configured");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
  });

  it("fails on an invalid URL without asking anything else", async () => {
    const { result, output } = await run(emptyScenario(), ["not-a-connection-string"]);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(output).toContain("postgresql://");
  });

  it("fails when the database is unreachable after retries", async () => {
    const scenario = emptyScenario();

    scenario.connectFailures = 10;

    const { result } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-unreachable.us-east-2.aws.neon.tech/rabet_dev",
      "n", // "Try connecting again?" → no
    ]);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
  });

  it("retries and then succeeds after transient network failures", async () => {
    const scenario = emptyScenario();

    scenario.connectFailures = 2;

    const { result } = await run(
      scenario,
      [
        "postgresql://rabet_owner:pw@ep-flaky.us-east-2.aws.neon.tech/rabet_dev",
        "y",
        "y",
        "n",
      ],
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("configured");
  });

  it("stops after a bounded number of retries even when every answer is yes", async () => {
    const scenario = emptyScenario();

    // The endpoint never becomes reachable, and the owner keeps answering
    // "try again" — the wizard must still terminate rather than loop forever.
    scenario.connectFailures = 100;

    const io = fakeIo([
      "postgresql://rabet_owner:pw@ep-unreachable.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y",
      "y",
      "y",
      "y",
    ]);

    const result = await wizard.runWizard({
      io,
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario),
      options: {},
      root,
      env: {},
      // The bounded loop is what is under test; the backoff is not.
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(io.output.join(" ")).toContain(
      "Still unreachable after several attempts",
    );
  });

  it("stops immediately when the session input is exhausted", async () => {
    const scenario = emptyScenario();

    // An interrupted session: the endpoint is unreachable and there is no more
    // input to answer the "try again?" prompt with. The wizard must not answer
    // its own default and loop.
    scenario.connectFailures = 100;

    const io = fakeIo(
      [
        "postgresql://rabet_owner:pw@ep-unreachable.us-east-2.aws.neon.tech/rabet_dev",
      ],
      { exhausted: true },
    );

    const result = await wizard.runWizard({
      io,
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario),
      options: {},
      root,
      env: {},
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(io.output.join(" ")).toContain("Input ended");

    // It never got as far as asking anything else.
    expect(io.prompts).toHaveLength(1);
  });

  it("stops when the target is not confirmed as the development database", async () => {
    const scenario = emptyScenario();

    const { result, output, calls } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "n", // "Confirm this is the dedicated Rabet_dev database?" → no
    ]);

    expect(result.outcome).toBe("cancelled");
    expect(output).toContain("nothing was written");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
  });

  it("warns about a pooled URL and accepts the direct one instead", async () => {
    const scenario = emptyScenario();

    const io = fakeIo([
      "postgresql://rabet_owner:pw@ep-cool-pooler-12345.us-east-2.aws.neon.tech/rabet_dev",
      "n", // "Use this pooled URL anyway?" → no
      "y", // "Paste the direct URL instead?" → yes
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y", // confirm the target
      "y", // approve migrations
      "n", // save to .env.local
    ]);

    const calls: CommandCall[] = [];
    const connect = makeConnect(scenario);

    const result = await wizard.runWizard({
      io,
      connect,
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario, {}, calls),
      options: {},
      root,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(io.output.join(" ")).toContain("POOLED");
  });

  it("warns and asks for stronger confirmation when the database name is not dev-like", async () => {
    const scenario = emptyScenario();

    scenario.dbName = "rabet_production";

    const { result, output } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_production",
      "y", // confirm anyway — the name alone is not proof, the operator is
      "y",
      "n",
    ]);

    expect(output).toContain("non-development target");
    expect(result.ok).toBe(true);
  });

  it("applies only the pending migration on a partially applied chain", async () => {
    const scenario = configuredScenario();

    scenario.applied = [
      { id: "1", hash: committed[0].hash, created_at: String(committed[0].when) },
    ];

    const { result } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y",
      "n",
    ]);

    expect(result.ok).toBe(true);
    expect(result.writes.migrationsApplied).toEqual([committed[1].tag]);
  });

  it("stops for manual review on unknown tables and migrates nothing", async () => {
    const scenario = configuredScenario();

    scenario.appTables = [...wizard.EXPECTED_TABLES, "unexpected_table"];

    const { result, output, calls } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
    ]);

    expect(result.outcome).toBe("manual-review");
    expect(output).toContain("unexpected_table");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
  });

  it("requires the typed database name when application data is present", async () => {
    const scenario = configuredScenario();

    // Data exists and one migration is still pending, so a write is proposed.
    scenario.totalRows = 42;
    scenario.applied = [
      { id: "1", hash: committed[0].hash, created_at: String(committed[0].when) },
    ];

    const { result, calls } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y", // approve
      "wrong-typed-value", // strong confirmation does not match → stop
    ]);

    expect(result.outcome).toBe("cancelled");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
  });

  it("proceeds after the matching strong confirmation", async () => {
    const scenario = configuredScenario();

    scenario.totalRows = 42;
    scenario.applied = [
      { id: "1", hash: committed[0].hash, created_at: String(committed[0].when) },
    ];

    const { result } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y",
      "rabet_dev", // typed database name matches
      "n",
    ]);

    expect(result.ok).toBe(true);
  });

  it("cancels safely when migration is not approved", async () => {
    const scenario = emptyScenario();

    const { result, output, calls } = await run(scenario, [
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "n", // "Proceed with migrations?" → default no
    ]);

    expect(result.outcome).toBe("cancelled");
    expect(output).toContain("No changes were made");
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
  });

  it("does not claim success when db:migrate exits non-zero", async () => {
    const scenario = emptyScenario();

    const io = fakeIo([
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y",
    ]);

    const calls: CommandCall[] = [];
    const connect = makeConnect(scenario);

    const result = await wizard.runWizard({
      io,
      connect,
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(
        scenario,
        { "npm run db:migrate": { code: 1, stdout: "" } },
        calls,
      ),
      options: {},
      root,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(io.output.join(" ")).toContain("exited with code 1");
    expect(io.output.join(" ")).not.toContain("migrations applied successfully");
  });

  it("re-flags an exit-zero run that left migrations pending", async () => {
    const scenario = emptyScenario();

    // The migration command "succeeds" but the fake database stays empty, so
    // the wizard's own inspection must catch the lie.
    const io = fakeIo([
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      "y",
      "y",
    ]);

    const result = await wizard.runWizard({
      io,
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "npm run db:migrate": { code: 0, stdout: "[✓] migrations applied successfully!\n" },
      }),
      options: {},
      root,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(io.output.join(" ")).toContain("still pending");
  });

  it("redacts the password from every line it prints", async () => {
    const password = "top-secret-dev-password";

    const { output } = await run(
      emptyScenario(),
      [
        `postgresql://rabet_owner:${password}@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev`,
        "y",
        "y",
        "n",
      ],
    );

    expect(output).not.toContain(password);
  });

  it("redacts the password when the connection keeps failing", async () => {
    const password = "top-secret-dev-password";
    const scenario = emptyScenario();

    scenario.connectFailures = 10;

    const { output } = await run(scenario, [
      `postgresql://rabet_owner:${password}@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev`,
      "n",
    ]);

    expect(output).not.toContain(password);
  });

  it("is idempotent: a second run validates instead of repeating work", async () => {
    const scenario = configuredScenario();
    const url =
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev";

    const first = await run(scenario, [url, "y", "y", "n"]);

    expect(first.result.ok).toBe(true);

    const second = await run(scenario, [url, "y", "n"]);

    expect(second.result.ok).toBe(true);
    expect(second.output).toContain("already configured");
    expect(
      second.calls.filter((call) =>
        call.args.join(" ").includes("db:migrate"),
      ).length,
    ).toBe(0);
  });

  it("supports read-only preflight without prompting for approval", async () => {
    const scenario = emptyScenario();

    const { result, calls } = await run(
      scenario,
      [
        "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
        "y", // confirm the target
      ],
      { check: true },
    );

    expect(result.outcome).toBe("preflight-ok");
    expect(result.ok).toBe(true);
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:migrate")).length,
    ).toBe(0);
    expect(
      calls.filter((call) => call.args.join(" ").includes("db:check")).length,
    ).toBe(1);
  });

  it("uses an exported DATABASE_URL when the owner confirms it", async () => {
    const scenario = emptyScenario();
    const io = fakeIo(["y", "y", "y", "n"]);

    const result = await wizard.runWizard({
      io,
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario),
      options: {},
      root,
      env: {
        DATABASE_URL:
          "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
      },
    });

    expect(result.ok).toBe(true);
    expect(io.output.join(" ")).toContain("DATABASE_URL is already set");
  });

  it("warns about uncommitted migration files and can stop", async () => {
    const scenario = emptyScenario();

    const io = fakeIo([
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
    ]);

    const result = await wizard.runWizard({
      io,
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "git status --porcelain": { code: 0, stdout: " M drizzle/0000_initial_schema.sql\n" },
      }),
      options: {},
      root,
      env: {},
    });

    expect(result.outcome).toBe("cancelled");
    expect(io.output.join(" ").toLowerCase()).toContain("uncommitted");
  });

  it("refuses to run from an unrelated repository", async () => {
    const scenario = emptyScenario();

    const result = await wizard.runWizard({
      io: fakeIo(),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "git remote get-url origin": {
          code: 0,
          stdout: "https://github.com/someone/else.git\n",
        },
      }),
      options: {},
      root,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Local dependency handling
// ---------------------------------------------------------------------------

describe("local dependencies", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "rabet-wizard-deps-"));

    // A checkout with the committed migrations but no installed packages.
    cpSync(path.join(root, "drizzle"), path.join(workspace, "drizzle"), {
      recursive: true,
    });
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "rabet", version: "0.1.0", private: true }, null, 2),
    );
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stops when dependencies are missing and installation is declined", async () => {
    const scenario = emptyScenario();

    const result = await wizard.runWizard({
      io: fakeIo(["n"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner(),
      options: {},
      root: workspace,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
  });

  it("offers npm ci and continues when it is accepted", async () => {
    const scenario = emptyScenario();
    const calls: CommandCall[] = [];

    const result = await wizard.runWizard({
      io: fakeIo([
        "y", // install
        "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
        "y",
        "y",
        "n",
      ]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario, {}, calls),
      options: {},
      root: workspace,
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(
      calls.filter(
        (call) => [call.command, ...call.args].join(" ") === "npm ci",
      ).length,
    ).toBe(1);
  });

  it("stops when npm ci fails", async () => {
    const scenario = emptyScenario();

    const result = await wizard.runWizard({
      io: fakeIo(["y"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({ "npm ci": { code: 1, stderr: "ENOENT" } }),
      options: {},
      root: workspace,
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Production safety guardrails
// ---------------------------------------------------------------------------

describe("production safety", () => {
  it("never invokes drizzle-kit push", async () => {
    const { calls } = await run(
      emptyScenario(),
      [
        "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
        "y",
        "y",
        "n",
      ],
    );

    const pushed = calls.filter((call) => call.args.join(" ").includes("push"));

    expect(pushed.length).toBe(0);
  });

  it("emits no destructive SQL — every inspection statement is a SELECT", async () => {
    const statements = [
      ...Object.values(wizard.QUERIES),
      wizard.buildRowCountQuery([...wizard.EXPECTED_TABLES]),
    ];

    for (const raw of statements) {
      const statement = raw
        .replace(/^\/\* rabet:rowcount \*\/ /, "")
        .toLowerCase()
        .trim();

      expect(statement).toMatch(/^select /);
      expect(statement).not.toMatch(
        /\b(drop|delete|truncate|alter|insert|update|create)\b/,
      );
    }
  });

  it("never drops or resets anything in the report", async () => {
    const { output } = await run(
      emptyScenario(),
      [
        "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev",
        "y",
        "y",
        "n",
      ],
    );

    expect(output.toLowerCase()).not.toContain("drop database");
    expect(output.toLowerCase()).not.toContain("reset branch");
  });

  it("builds the row-count query only from the known table allowlist", () => {
    const injected = wizard.buildRowCountQuery([
      "category",
      "products",
      "inquiry_message",
    ]);

    expect(injected).toContain('"category"');
    expect(injected).toContain('"inquiry_message"');
    expect(injected).not.toContain("products");
  });
});

// ---------------------------------------------------------------------------
// Local credential persistence
// ---------------------------------------------------------------------------

describe("env.local persistence", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "rabet-wizard-env-"));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("preserves unrelated values, writes the URL, and reads it back", () => {
    const target = path.join(workspace, ".env.local");
    const url =
      "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev";

    writeFileSync(
      target,
      [
        "AUTH_SECRET=keep-me",
        "ADMIN_EMAIL=admin@example.com",
        "ADMIN_PASSWORD_HASH=$argon2id$keep-me",
        "DATABASE_URL=postgresql://old:old@host/old",
        "",
      ].join("\n"),
    );

    wizard.writeEnvLocalUrl(target, url);

    const contents = readFileSync(target, "utf8");

    expect(contents).toContain("AUTH_SECRET=keep-me");
    expect(contents).toContain("ADMIN_EMAIL=admin@example.com");
    expect(contents).toContain("ADMIN_PASSWORD_HASH=$argon2id$keep-me");
    expect(contents).not.toContain("old:old");
    expect(contents).toContain(`DATABASE_URL=${url}`);
    expect(wizard.readEnvLocalUrl(target)).toBe(url);

    const mode = statSync(target).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it("creates a new file with the documented header", () => {
    const target = path.join(workspace, ".env.local.new");
    const url = "postgresql://u:p@host/rabet_dev";

    wizard.writeEnvLocalUrl(target, url);

    const contents = readFileSync(target, "utf8");

    expect(contents).toContain("Never commit this file");
    expect(contents).toContain(`DATABASE_URL=${url}`);
  });

  it("reports null when no DATABASE_URL is present", () => {
    const target = path.join(workspace, ".env.none");

    writeFileSync(target, "AUTH_SECRET=only\n");

    expect(wizard.readEnvLocalUrl(target)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Optional Vercel Preview step
// ---------------------------------------------------------------------------

describe("optional vercel preview step", () => {
  const url =
    "postgresql://rabet_owner:pw@ep-cool-12345.us-east-2.aws.neon.tech/rabet_dev";

  it("reports a manual step when the CLI is missing", async () => {
    const scenario = configuredScenario();

    const result = await wizard.runWizard({
      io: fakeIo([url, "y", "n"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "vercel --version": { code: 1, stderr: "not found" },
      }),
      options: { vercelPreview: true },
      root,
      env: {},
    });

    expect(result.ok).toBe(true);
  });

  it("reports a manual step when not logged in", async () => {
    const scenario = configuredScenario();

    const result = await wizard.runWizard({
      io: fakeIo([url, "y", "n"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "vercel --version": { code: 0, stdout: "34.0.0\n" },
        "vercel whoami": { code: 1, stderr: "not logged in" },
      }),
      options: { vercelPreview: true },
      root,
      env: {},
    });

    expect(result.ok).toBe(true);
  });

  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "rabet-wizard-vercel-"));

    cpSync(path.join(root, "drizzle"), path.join(workspace, "drizzle"), {
      recursive: true,
    });
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "rabet", version: "0.1.0", private: true }, null, 2),
    );

    // Present-enough package records so the dependency step does not prompt.
    for (const pkg of [
      "@neondatabase/serverless",
      "drizzle-kit",
      "drizzle-orm",
    ]) {
      mkdirSync(path.join(workspace, "node_modules", pkg), { recursive: true });
      writeFileSync(
        path.join(workspace, "node_modules", pkg, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0" }),
      );
    }

    mkdirSync(path.join(workspace, ".vercel"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_rabet", orgId: "team_rabet" }),
    );
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("pipes the URL to stdin, never onto the command line", async () => {
    const scenario = configuredScenario();
    const calls: CommandCall[] = [];

    const result = await wizard.runWizard({
      io: fakeIo([url, "y", "n", "y"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(
        scenario,
        {
          "vercel --version": { code: 0, stdout: "34.0.0\n" },
          "vercel whoami": { code: 0, stdout: "owner@example.com\n" },
        },
        calls,
      ),
      options: { vercelPreview: true },
      root: workspace,
      env: {},
    });

    expect(result.ok).toBe(true);

    const envAdd = calls.find((call) =>
      [call.command, ...call.args].join(" ").startsWith("vercel env add"),
    );

    expect(envAdd).toBeDefined();
    expect(envAdd?.args).not.toContain(url);
    expect(envAdd?.stdin).toContain(url);
  });

  it("accepts the repo.json link record the newer CLI writes", async () => {
    const scenario = configuredScenario();

    rmSync(path.join(workspace, ".vercel", "project.json"), { force: true });
    writeFileSync(
      path.join(workspace, ".vercel", "repo.json"),
      JSON.stringify({
        remoteName: "origin",
        projects: [
          {
            id: "prj_rabet",
            name: "rabet",
            directory: ".",
            orgId: "team_rabet",
          },
        ],
      }),
    );

    try {
      const result = await wizard.runWizard({
        io: fakeIo([url, "y", "n", "n"]),
        connect: makeConnect(scenario),
        httpConnect: makeHttpConnect(scenario),
        runCommand: fakeRunner({
          "vercel --version": { code: 0, stdout: "34.0.0\n" },
          "vercel whoami": { code: 0, stdout: "owner@example.com\n" },
        }),
        options: { vercelPreview: true },
        root: workspace,
        env: {},
      });

      expect(result.ok).toBe(true);
    } finally {
      writeFileSync(
        path.join(workspace, ".vercel", "project.json"),
        JSON.stringify({ projectId: "prj_rabet", orgId: "team_rabet" }),
      );
    }
  });

  it("skips when the preview write is declined", async () => {
    const scenario = configuredScenario();

    const result = await wizard.runWizard({
      io: fakeIo([url, "y", "n", "n"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: fakeRunner({
        "vercel --version": { code: 0, stdout: "34.0.0\n" },
        "vercel whoami": { code: 0, stdout: "owner@example.com\n" },
      }),
      options: { vercelPreview: true },
      root: workspace,
      env: {},
    });

    expect(result.ok).toBe(true);
  });

  it("never runs the preview step without the explicit flag", async () => {
    const scenario = configuredScenario();
    const calls: CommandCall[] = [];

    await wizard.runWizard({
      io: fakeIo([url, "y", "n"]),
      connect: makeConnect(scenario),
      httpConnect: makeHttpConnect(scenario),
      runCommand: migratingRunner(scenario, {}, calls),
      options: {},
      root,
      env: {},
    });

    expect(
      calls.filter((call) => call.command === "vercel").length,
    ).toBe(0);
  });
});
