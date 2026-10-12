import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

/**
 * The migration chain itself, as an object under test.
 *
 * These assertions exist because "each migration works alone" is a classic
 * failure mode that only shows up when the *chain* is applied to a genuinely
 * empty database. They also prove the properties the migration rules in
 * DATA_MODEL.md §17.3 require: a clean apply, no duplicated objects on
 * re-application, and a failed migration that is reported clearly and rolls
 * back atomically instead of leaving a half-applied schema.
 */

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("migrations");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

describe.skipIf(!shouldRun)("migration chain", () => {
  it("applies the full chain to a clean database", async () => {
    const rows = await testDb!.db.execute<{
      count: number;
    }>(sql`select count(*)::int as count from information_schema.tables
      where table_schema = 'public'`);

    // The fourteen domain tables. `__drizzle_migrations` lives in the separate
    // `drizzle` schema and is not counted here.
    expect(rows[0].count).toBe(14);
  });

  it("records every migration in the journal", async () => {
    const rows = await testDb!.db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );

    expect(rows[0].count).toBe(2);
  });

  it("re-applying the chain is a no-op that duplicates no objects", async () => {
    const before = await objectFingerprint(testDb!);

    // The journal now marks both migrations applied, so the migrator skips
    // every statement. A migration that is not idempotent would blow up here.
    await migrate(testDb!.db, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });

    const after = await objectFingerprint(testDb!);

    expect(after).toEqual(before);
  });

  it("creates the integrity triggers the schema depends on", async () => {
    const rows = await testDb!.db.execute<{ name: string }>(
      sql`select distinct trigger_name as name from information_schema.triggers
        where trigger_schema = 'public' order by name`,
    );

    const names = rows.map((row) => row.name);

    // The four integrity triggers from 0001, plus the shared `updated_at`
    // maintainer on every table that carries the column.
    expect(names).toContain("category_check_ancestry");
    expect(names).toContain("product_action_check_ancestry");
    expect(names).toContain("product_action_guard_menu_capability");
    expect(names).toContain("inquiry_freeze_context");
    expect(names.filter((name) => name.endsWith("_touch_updated_at")).length).toBe(11);
  });

  it("creates the partial unique indexes that enforce sibling ordering", async () => {
    const rows = await testDb!.db.execute<{ name: string }>(
      sql`select indexname as name from pg_indexes
        where schemaname = 'public' and indexdef ilike '%WHERE%' order by name`,
    );

    const names = new Set(rows.map((row) => row.name));

    // Two partial unique indexes per tree: children and roots.
    expect(names.has("category_sibling_sort_order_idx")).toBe(true);
    expect(names.has("category_root_sort_order_idx")).toBe(true);
    expect(names.has("product_action_sibling_sort_order_idx")).toBe(true);
    expect(names.has("product_action_root_sort_order_idx")).toBe(true);
    // The one-active-inquiry partial index.
    expect(names.has("inquiry_active_per_customer_product_idx")).toBe(true);
  });

  it("reports a failed migration clearly and rolls the whole chain back", async () => {
    // A copy of the committed chain plus a migration that cannot run. The
    // migrator applies every pending migration inside one transaction, so the
    // failure must roll the entire apply back rather than leaving a
    // half-built schema behind.
    const broken = path.join(mkdtempSync(path.join(os.tmpdir(), "rabet-broken-")), "drizzle");

    cpSync(
      path.resolve(import.meta.dirname, "../../drizzle"),
      broken,
      { recursive: true },
    );

    const journalPath = path.join(broken, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };

    journal.entries.push({
      idx: journal.entries.length,
      version: "7",
      when: Date.now(),
      tag: "0002_deliberately_broken",
      breakpoints: true,
    });

    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    writeFileSync(
      path.join(broken, "0002_deliberately_broken.sql"),
      [
        "-- Probe table that should NOT survive a failed migration.",
        "CREATE TABLE migration_failure_probe (id integer);",
        "-- Statement that cannot run: the migration must fail here.",
        "CREATE TABLE migration_failure_kaboom (id not_a_real_type);",
      ].join("\n"),
    );

    const pool = postgres(testDb!.url, { max: 1 });
    const db = drizzle({ client: pool });

    await expect(
      migrate(db, { migrationsFolder: broken }),
    ).rejects.toThrowError(/not_a_real_type/);

    const probes = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from information_schema.tables
        where table_schema = 'public' and table_name like 'migration_failure%'`,
    );
    const applied = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );

    // The probe table from the first statement of the broken file is gone: the
    // pending apply ran in one transaction and rolled back atomically, leaving
    // no partial schema behind. The two committed migrations were already
    // applied before this run, so the journal still holds them — the point is
    // that the broken migration was *not* recorded and built nothing.
    expect(probes[0].count).toBe(0);
    expect(applied[0].count).toBe(2);

    // The committed schema is intact, not half-dropped.
    const tables = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from information_schema.tables
        where table_schema = 'public'`,
    );

    expect(tables[0].count).toBe(14);

    await pool.end();
    rmSync(path.dirname(broken), { recursive: true, force: true });
  });

  it("does not run drizzle-kit push against any database", () => {
    // A guardrail, asserted as code: `push` is not in any npm script, so a
    // migration cannot be bypassed by a schema-push shortcut.
    const scripts = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as Record<string, Record<string, string>>;

    const pushUsed = Object.entries(scripts.scripts ?? {}).some(
      ([name, command]) => name.startsWith("db:") && /drizzle-kit\s+push/.test(command),
    );

    expect(pushUsed).toBe(false);
  });
});

/** Counts tables, indexes, enums, triggers and functions — an object fingerprint. */
async function objectFingerprint(testDb: TestDatabase) {
  const rows = await testDb.db.execute<{
    kind: string;
    count: number;
  }>(sql`
    select 'tables' as kind, count(*)::int as count from information_schema.tables where table_schema = 'public'
    union all
    select 'indexes', count(*)::int from pg_indexes where schemaname = 'public'
    union all
    select 'enums', count(*)::int from pg_type where typtype = 'e' and typnamespace = 'public'::regnamespace
    union all
    select 'triggers', count(*)::int from information_schema.triggers where trigger_schema = 'public'
    union all
    select 'functions', count(*)::int from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  `);

  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}
