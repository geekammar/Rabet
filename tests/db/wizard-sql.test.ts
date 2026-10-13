/**
 * The wizard's read-only inspection SQL, proven against real PostgreSQL.
 *
 * `tests/wizard/setup-neon-dev.test.ts` drives every wizard *flow* with mocks.
 * This file proves the SQL those mocks stand in for is actually correct: it
 * applies the committed chain to a throwaway database — the same chain the
 * wizard applies — then runs the wizard's own queries against it and asserts
 * the answers the wizard decides on.
 *
 * It also proves the byte-for-byte migration-history check: the hashes recorded
 * in `drizzle.__drizzle_migrations` are exactly what the wizard computes from
 * the committed files, so "the history matches the committed chain" is a real
 * comparison and not a count.
 *
 * Runs only when a throwaway cluster is designated (`npm run test:db` locally,
 * the PostgreSQL service container in CI), for the same reason the other
 * database suites do: these assertions are enforced by the server. It never
 * reads `DATABASE_URL`, and it creates and drops its own database per file.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";
import * as wizard from "../../scripts/setup-neon-dev.mjs";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;
let sql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("wizard");

  // One pooled connection to the throwaway database for the wizard's raw
  // queries. `postgres` exposes arbitrary SQL through `unsafe`, which is what
  // the wizard's read-only statements need.
  sql = postgres(testDb.url, { max: 1 });
});

afterAll(async () => {
  await sql?.end();
  sql = null;
  await testDb?.close();
  testDb = null;
});

/** Runs one of the wizard's read-only statements and returns the rows. */
async function run(text: string) {
  return sql!.unsafe(text);
}

describe.skipIf(!shouldRun)("wizard inspection SQL on a migrated database", () => {
  it("reports the fourteen expected tables and no others", async () => {
    const rows = await run(wizard.QUERIES.appTables);
    const tables = rows.map((row) => String(row.name));

    expect(tables.sort()).toEqual([...wizard.EXPECTED_TABLES].sort());
  });

  it("records exactly the committed migrations, in chain order", async () => {
    const rows = await run(wizard.QUERIES.drizzleMigrations);
    const applied = rows.map((row) => String(row.hash));
    const committedHashes = wizard
      .computeMigrationHashes(process.cwd())
      .map((entry) => entry.hash);

    // The wizard compares these byte for byte; this is the same assertion.
    expect(applied).toEqual(committedHashes);
  });

  it("classifies the freshly migrated database as configured", async () => {
    const tableRows = await run(wizard.QUERIES.appTables);
    const appliedRows = await run(wizard.QUERIES.drizzleMigrations);
    const committedHashes = wizard.computeMigrationHashes(process.cwd());
    const journal = wizard.readJournal(process.cwd());

    expect(journal.ok).toBe(true);

    const state = wizard.classifyDbState({
      appTables: tableRows.map((row) => String(row.name)),
      appliedMigrations: appliedRows,
      committedHashes,
      journal: journal.ok ? journal : { entries: [] },
      totalRows: 0,
    });

    expect(state.status).toBe("configured");
    expect(state.pending).toEqual([]);
    expect(state.unknownTables).toEqual([]);
    expect(state.missingTables).toEqual([]);
  });

  it("requires every expected index", async () => {
    const rows = await run(wizard.QUERIES.indexes);
    const present = new Set(rows.map((row) => String(row.name)));
    const missing = wizard.EXPECTED_INDEXES.filter((name) => !present.has(name));

    expect(missing).toEqual([]);
  });

  it("requires every critical CHECK constraint", async () => {
    const rows = await run(wizard.QUERIES.constraints);
    const present = new Set(rows.map((row) => String(row.name)));
    const missing = wizard.CRITICAL_CONSTRAINTS.filter(
      (name) => !present.has(name),
    );

    expect(missing).toEqual([]);
  });

  it("finds both recursive-tree foreign keys", async () => {
    const rows = await run(wizard.QUERIES.treeFks);
    const present = new Set(rows.map((row) => String(row.name)));

    for (const fk of Object.values(wizard.EXPECTED_TREE_FKS)) {
      expect(present.has(fk)).toBe(true);
    }
  });

  it("counts zero application rows on a freshly migrated database", async () => {
    const rows = await run(
      wizard.buildRowCountQuery([...wizard.EXPECTED_TABLES]),
    );

    expect(Number(rows[0].total)).toBe(0);
  });

  it("counts rows when application data is present", async () => {
    // Minimal, non-customer data: one language row, which the schema allows and
    // which no fixture elsewhere creates against this database.
    await sql!.unsafe(
      `insert into "language" ("code", "label", "text_direction", "is_enabled")
       values ('en', 'English', 'ltr', true)`,
    );

    const rows = await run(
      wizard.buildRowCountQuery([...wizard.EXPECTED_TABLES]),
    );

    expect(Number(rows[0].total)).toBe(1);

    await sql!.unsafe(`delete from "language"`);
  });

  it("answers the metadata queries the wizard displays", async () => {
    const one = await run(wizard.QUERIES.selectOne);

    expect(Number(one[0].result)).toBe(1);

    const database = await run(wizard.QUERIES.currentDatabase);
    const version = await run(wizard.QUERIES.pgVersion);
    const user = await run(wizard.QUERIES.currentUser);

    expect(typeof database[0].name).toBe("string");
    expect(String(version[0].version)).toMatch(/PostgreSQL/);
    expect(typeof user[0].name).toBe("string");
  });

  it("detects drift when an unknown table is present", async () => {
    await sql!.unsafe(`create table wizard_drift_probe (id integer primary key)`);

    const tableRows = await run(wizard.QUERIES.appTables);
    const appliedRows = await run(wizard.QUERIES.drizzleMigrations);
    const committedHashes = wizard.computeMigrationHashes(process.cwd());
    const journal = wizard.readJournal(process.cwd());

    const state = wizard.classifyDbState({
      appTables: tableRows.map((row) => String(row.name)),
      appliedMigrations: appliedRows,
      committedHashes,
      journal: journal.ok ? journal : { entries: [] },
      totalRows: 0,
    });

    expect(state.status).toBe("drift");
    expect(state.unknownTables).toContain("wizard_drift_probe");

    await sql!.unsafe(`drop table wizard_drift_probe`);
  });

  it("stops when the journal is complete but a table is missing", async () => {
    // Simulate an inconsistent target: the journal says both migrations ran,
    // but one table was removed out of band.
    await sql!.unsafe(`drop table "telegram_update" cascade`);

    const tableRows = await run(wizard.QUERIES.appTables);
    const appliedRows = await run(wizard.QUERIES.drizzleMigrations);
    const committedHashes = wizard.computeMigrationHashes(process.cwd());
    const journal = wizard.readJournal(process.cwd());

    const state = wizard.classifyDbState({
      appTables: tableRows.map((row) => String(row.name)),
      appliedMigrations: appliedRows,
      committedHashes,
      journal: journal.ok ? journal : { entries: [] },
      totalRows: 0,
    });

    expect(state.status).toBe("inconsistent");
    expect(state.missingTables).toContain("telegram_update");
  });
});

describe.skipIf(!shouldRun)("wizard SQL is strictly read-only", () => {
  it("contains no write or DDL statement", () => {
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
        /\b(drop|delete|truncate|alter|insert|update|create|grant|revoke)\b/,
      );
    }
  });

  it("re-applying the chain is a no-op, so a rerun changes nothing", async () => {
    const before = await run(wizard.QUERIES.appTables);

    // The migrator skips every statement the journal already records — the
    // idempotency the wizard relies on when it reports "already configured".
    const pool = postgres(testDb!.url, { max: 1 });

    try {
      await migrate(drizzle({ client: pool }), {
        migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
      });
    } finally {
      await pool.end();
    }

    const after = await run(wizard.QUERIES.appTables);

    expect(after.map((row) => String(row.name)).sort()).toEqual(
      before.map((row) => String(row.name)).sort(),
    );
  });
});
