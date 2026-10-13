/**
 * The replacement-VPS scenario, proven end to end against real PostgreSQL.
 *
 * `tests/wizard/setup-neon-dev.test.ts` drives every wizard *flow* with a mock
 * database. This file proves the real thing on a real server: it runs the
 * actual wizard (the real wire-protocol driver, the real `npm run db:migrate`
 * subprocess, the real repository checks) against throwaway databases on the
 * disposable cluster, and answers the prompts from a script.
 *
 * What is under test is the property the owner cares about: **the existing
 * `Rabet_dev` database must survive replacement of the VPS unchanged.** So the
 * two machines are modelled as two independent, freshly cloned working
 * directories — neither knows anything about the other — and the same existing
 * database is handed to both:
 *
 *   VPS A — a fresh clone and a fresh database. First-time setup: the wizard
 *           classifies the target as empty, asks, and applies the chain.
 *           A harmless, uniquely marked row is then written to the disposable
 *           database only, standing in for real data the owner cares about.
 *
 *   VPS B — a *different* fresh clone, with no previous local setup state and
 *           the same existing connection string. The wizard must recognize the
 *           schema and the migration history, apply nothing, create no new
 *           database, and leave the marked row exactly where it was.
 *
 * A third run exercises the read-only `--check` preflight on another fresh
 * clone, and a second scenario covers an already-configured database that has
 * one new pending migration.
 *
 * Never run against anything but the disposable cluster: this file creates and
 * drops databases. It reads `RABET_TEST_PG_URL` and never `DATABASE_URL`.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { hasTestCluster, testClusterUrl } from "./helpers";
import { fakeIo, type CommandCall } from "../wizard/harness";
import * as wizard from "../../scripts/setup-neon-dev.mjs";

const shouldRun = hasTestCluster();

/** The repository the wizard is allowed to provision, as a fresh clone sees it. */
const REMOTE_URL = "https://github.com/geekammar/Rabet.git";

/** The directory the tests run from, i.e. the working clone of the repository. */
const repo = process.cwd();

/** Every throwaway directory created by a run, removed together at the end. */
const trash: string[] = [];

/**
 * The throwaway database name prefixes the *other* database suites use. Each
 * suite creates and drops its own databases on the shared cluster, and they
 * run concurrently with this one, so this file's cluster-wide "no database was
 * added" snapshot ignores them. See `databases()` below.
 */
const SIBLING_SUITE_PREFIXES = ["rabet_test_", "rabet_actions_"];

afterAll(() => {
  for (const dir of trash) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A database name from the same safe alphabet the DB harness uses. */
function throwawayName(label: string): string {
  const random = globalThis.crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, byte) => acc + byte.toString(36).padStart(2, "0"), "");

  return `rabet_vps_${label}_${process.pid}_${random}`.toLowerCase();
}

/**
 * A brand-new, EMPTY database on the throwaway cluster — no migrations, so the
 * wizard has to do the work itself. Created and dropped by this file only.
 */
async function createEmptyDatabase(label: string) {
  const base = testClusterUrl() ?? "";
  const name = throwawayName(label);
  const admin = postgres(base, { max: 1 });

  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = base.replace(/\/[^/]*$/, `/${name}`);
  const sql = postgres(url, { max: 2 });

  return {
    url,
    name,
    sql,

    /**
     * The databases that exist on the throwaway cluster, to prove none is added.
     *
     * Vitest runs the database suites concurrently in separate workers, so a
     * sibling file may legitimately be holding its own throwaway database for
     * the duration of this snapshot window. Those databases are noise here:
     * this suite is proving what the *wizard* did, and the wizard has no
     * `CREATE DATABASE` capability — it can only operate on the connection
     * string it is handed. Each sibling suite uses a distinct, documented
     * throwaway prefix, so the comparison is scoped to everything else: any
     * database the wizard could have caused (under any name) still fails it.
     */
    async databases(): Promise<string[]> {
      const connection = postgres(base, { max: 1 });
      const rows = await connection`select datname from pg_database where datistemplate = false order by datname`;
      await connection.end();
      return rows
        .map((row) => String(row.datname))
        .filter((name) => !SIBLING_SUITE_PREFIXES.some((prefix) => name.startsWith(prefix)));
    },

    async close(): Promise<void> {
      await sql.end();

      const dropper = postgres(base, { max: 1 });

      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/**
 * A fresh clone of the repository: what a new VPS has after `git clone`.
 *
 * The clone records this checkout's path as its origin, so the origin is reset
 * to the GitHub identity a real fresh clone carries — that is the only thing
 * the wizard checks about the machine it is running on. `node_modules` is
 * linked rather than reinstalled so the clone can run the npm scripts the
 * wizard spawns; it stands in for "npm dependencies are installed".
 */
function freshClone(tag: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `rabet-vps-${tag}-`));

  trash.push(dir);

  execFileSync("git", ["clone", "--depth", "1", repo, dir], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", dir, "remote", "set-url", "origin", REMOTE_URL], {
    stdio: "pipe",
  });
  symlinkSync(
    path.join(repo, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );

  return dir;
}

/**
 * The real subprocess surface, with the output captured instead of streamed so
 * the test report stays readable on a phone. Every invocation is recorded so a
 * test can prove which npm scripts the wizard actually ran.
 */
function realCommandRunner(calls: CommandCall[]) {
  return async (opts: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  }) => {
    calls.push({
      command: opts.command,
      args: opts.args,
      env: opts.env,
    });

    return wizard.runCommandReal({ ...opts, onOutput: () => {} });
  };
}

/**
 * The environment of a fresh VPS shell: the ambient environment minus the two
 * variables that would make this not a fresh VPS — `DATABASE_URL` (nothing is
 * pre-configured; the wizard must ask for the string) and `RABET_TEST_PG_URL`
 * (the disposable cluster's variable, which the wizard never forwards).
 */
function freshVpsEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key === "DATABASE_URL") continue;
    if (key === "RABET_TEST_PG_URL") continue;

    env[key] = value;
  }

  return env;
}

/** Runs the real wizard against a real database from a scripted terminal. */
async function runWizardOn(clone: string, answers: string[], options = {}) {
  const calls: CommandCall[] = [];
  const io = fakeIo(answers);

  const result = await wizard.runWizard({
    io,
    connect: wizard.createPostgresSql,
    // The real Neon HTTP driver: it is only constructed for a Neon endpoint,
    // so a loopback target correctly reports the check as not applicable and
    // makes no network call.
    httpConnect: wizard.createNeonSql,
    runCommand: realCommandRunner(calls),
    options,
    root: clone,
    env: freshVpsEnv(),
  });

  return { result, output: io.output.join(""), calls };
}

/** The hashes Drizzle recorded, in the order the chain applies them. */
async function appliedHashes(
  sql: ReturnType<typeof postgres>,
): Promise<string[]> {
  const rows = await sql`select hash from drizzle.__drizzle_migrations order by created_at`;
  return rows.map((row) => String(row.hash));
}

/** A harmless, uniquely marked row that stands in for data the owner values. */
async function writeMarker(
  sql: ReturnType<typeof postgres>,
): Promise<string> {
  const marker = `RABET-VPS-MARKER-${globalThis.crypto.randomUUID()}`;

  await sql`insert into "language" ("code", "label", "text_direction", "is_enabled")
           values ('zz', ${marker}, 'ltr', false)`;

  return marker;
}

async function markerSurvived(
  sql: ReturnType<typeof postgres>,
  marker: string,
): Promise<boolean> {
  const rows = await sql`select count(*)::int as n from "language" where "label" = ${marker}`;
  return Number(rows[0].n) === 1;
}

// ---------------------------------------------------------------------------

describe.skipIf(!shouldRun)("replacement-VPS reconnect on real PostgreSQL", () => {
  it("VPS A sets up a fresh database; VPS B reconnects and repeats nothing", async () => {
    const db = await createEmptyDatabase("vpsa");

    try {
      // ------------------------- VPS A: first-time setup --------------------
      const vpsA = freshClone("a");
      const before = await db.databases();

      const runA = await runWizardOn(vpsA, [
        db.url, // paste the direct connection string
        "y", // confirm this is the dedicated Rabet_dev database
        "y", // approve the pending development migrations
        "n", // do not save the URL to .env.local
      ]);

      expect(runA.result.ok).toBe(true);
      expect(runA.result.outcome).toBe("configured");
      expect(runA.result.writes.migrationsApplied).toEqual(
        wizard.EXPECTED_MIGRATION_TAGS,
      );
      expect(
        runA.calls.filter((call) =>
          call.args.join(" ").includes("db:migrate"),
        ).length,
      ).toBe(1);

      const tablesA = await db.sql`select table_name as name
        from information_schema.tables
        where table_schema = 'public'
        order by table_name`;

      expect(tablesA.map((row) => String(row.name)).sort()).toEqual(
        [...wizard.EXPECTED_TABLES].sort(),
      );

      expect(await appliedHashes(db.sql)).toEqual(
        wizard.computeMigrationHashes(repo).map((entry) => entry.hash),
      );

      // A harmless marked row, only ever written to this disposable database.
      const marker = await writeMarker(db.sql);

      // ---------------------- VPS B: the replacement VPS --------------------
      const vpsB = freshClone("b");

      const runB = await runWizardOn(vpsB, [
        db.url, // the EXISTING connection string, pasted again
        "y", // confirm the target
        "n", // do not save the URL to .env.local
      ]);

      // Existing schema recognized, existing history recognized.
      expect(runB.result.ok).toBe(true);
      expect(runB.result.outcome).toBe("configured");
      expect(runB.output).toContain("already configured");

      // No duplicate migration execution.
      expect(
        runB.calls.filter((call) =>
          call.args.join(" ").includes("db:migrate"),
        ).length,
      ).toBe(0);
      expect(await appliedHashes(db.sql)).toHaveLength(
        wizard.EXPECTED_MIGRATION_TAGS.length,
      );

      // The marked row survived: zero destructive changes.
      expect(await markerSurvived(db.sql, marker)).toBe(true);

      // No unnecessary new database was created on the cluster.
      expect(await db.databases()).toEqual(before);

      // ---------- a third fresh clone: the read-only preflight ---------------
      const vpsC = freshClone("check");

      const runC = await runWizardOn(
        vpsC,
        [
          db.url, // the existing connection string
          "y", // confirm the target
        ],
        { check: true },
      );

      expect(runC.result.ok).toBe(true);
      expect(runC.result.outcome).toBe("preflight-ok");
      expect(
        runC.calls.filter((call) =>
          call.args.join(" ").includes("db:migrate"),
        ).length,
      ).toBe(0);
      expect(await appliedHashes(db.sql)).toHaveLength(
        wizard.EXPECTED_MIGRATION_TAGS.length,
      );
      expect(await markerSurvived(db.sql, marker)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("applies only the one new pending migration and preserves existing data", async () => {
    const db = await createEmptyDatabase("pending");

    try {
      // The database is already configured with the FIRST migration only — the
      // state of a development database between two releases. The fixture is a
      // trimmed copy of the committed chain, so the hash it records is exactly
      // the hash the wizard computes for the committed file.
      const fixture = mkdtempSync(path.join(os.tmpdir(), "rabet-chain-prefix-"));

      trash.push(fixture);

      mkdirSync(path.join(fixture, "meta"), { recursive: true });
      cpSync(
        path.join(repo, "drizzle", "0000_initial_schema.sql"),
        path.join(fixture, "0000_initial_schema.sql"),
      );
      cpSync(
        path.join(repo, "drizzle", "meta", "0000_snapshot.json"),
        path.join(fixture, "meta", "0000_snapshot.json"),
      );

      const journal = JSON.parse(
        readFileSync(
          path.join(repo, "drizzle", "meta", "_journal.json"),
          "utf8",
        ),
      );

      writeFileSync(
        path.join(fixture, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }, null, 2),
      );

      const pool = postgres(db.url, { max: 1 });

      try {
        await migrate(drizzle({ client: pool }), { migrationsFolder: fixture });
      } finally {
        await pool.end();
      }

      expect(await appliedHashes(db.sql)).toEqual([
        wizard.computeMigrationHashes(repo)[0].hash,
      ]);

      // Existing data the owner values, present before the new migration.
      const marker = await writeMarker(db.sql);

      // The repository has since gained a second migration; a new VPS clones it
      // and points the wizard at the existing database.
      const clone = freshClone("pending");

      const run = await runWizardOn(clone, [
        db.url, // the existing connection string
        "y", // confirm the target
        "y", // proceed with the pending migration
        db.name, // strong confirmation: the database name, because data exists
        "n", // do not save the URL to .env.local
      ]);

      expect(run.result.ok).toBe(true);
      expect(run.result.outcome).toBe("configured");

      // Only the new migration was applied — the first one was not repeated.
      expect(run.result.writes.migrationsApplied).toEqual([
        wizard.EXPECTED_MIGRATION_TAGS[1],
      ]);
      expect(await appliedHashes(db.sql)).toEqual(
        wizard.computeMigrationHashes(repo).map((entry) => entry.hash),
      );

      // The second migration's objects really landed (its trigger function did
      // not exist after the first migration alone).
      const functions = await db.sql`select count(*)::int as n
        from pg_proc where proname = 'category_check_ancestry'`;

      expect(Number(functions[0].n)).toBeGreaterThan(0);

      // And the existing data is untouched.
      expect(await markerSurvived(db.sql, marker)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
