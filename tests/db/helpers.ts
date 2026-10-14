import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { Database } from "@/db/client";
import * as schema from "@/db/schema";

/**
 * ===========================================================================
 * Database integration test harness.
 * ===========================================================================
 *
 * These tests run against **real PostgreSQL** because every invariant they
 * assert is enforced by the server: ancestry triggers, partial unique
 * indexes, write-once snapshots, cascades. No TypeScript unit test can prove
 * any of them, and mocking them would prove nothing.
 *
 * Isolation model: each test file gets its own throwaway database inside a
 * throwaway cluster. Nothing is shared, nothing is production, and nothing
 * survives the run:
 *
 *   - Locally, `npm run test:db` starts a disposable instance
 *     (`scripts/db-test-postgres.mjs`) — a fresh `initdb` on a random port,
 *     loopback only — and records its URL in a state file.
 *   - In CI, the workflow points `RABET_TEST_PG_URL` at a PostgreSQL service
 *     container.
 *
 * `DATABASE_URL` is deliberately **never** used here. It may point at a shared
 * or production cluster; these tests create and drop databases, so they must
 * only ever reach an explicitly designated throwaway cluster.
 */

const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../../drizzle");
const STATE_FILE = path.join(os.tmpdir(), "rabet-test-pg.json");

export type TestDatabase = {
  /** A Drizzle client over the fresh, migrated database. */
  db: PostgresJsDatabase<typeof schema>;
  /** The connection string of the throwaway database. */
  url: string;
  /** The name of the throwaway database. */
  name: string;
  /** Drops the database and closes every connection. Always call in afterAll. */
  close(): Promise<void>;
};

/**
 * Resolves the throwaway cluster to test against, without any network access.
 *
 * Returns `null` when nothing is designated, which lets the suites skip (not
 * fail) on a machine with no PostgreSQL available — `npm run test` stays green
 * everywhere, and `npm run test:db` provides the instance.
 */
export function testClusterUrl(): string | null {
  const fromEnv = process.env.RABET_TEST_PG_URL;

  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  // Written by `scripts/db-test-postgres.mjs start` and removed by `stop`.
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        url?: unknown;
      };

      if (typeof state.url === "string") return state.url;
    } catch {
      // A corrupt state file is not fatal; fall through to "not designated".
    }
  }

  return null;
}

/** True when a throwaway cluster is designated, so suites know whether to run. */
export function hasTestCluster(): boolean {
  return testClusterUrl() !== null;
}

/** Generates a unique, injection-safe database name (letters and digits only). */
function throwawayName(label: string): string {
  const random = globalThis.crypto
    .getRandomValues(new Uint8Array(8))
    .reduce((acc, byte) => acc + byte.toString(36).padStart(2, "0"), "");

  return `rabet_test_${label}_${process.pid}_${random}`.toLowerCase();
}

/**
 * Creates a brand-new, empty database on the throwaway cluster and applies the
 * full committed migration chain to it. This is itself the "a clean database
 * can apply the full chain" assertion.
 *
 * The returned `close()` drops the database, so each test file leaves nothing
 * behind even if assertions failed.
 */
export async function createTestDatabase(label = "db"): Promise<TestDatabase> {
  const baseUrl = testClusterUrl();

  if (baseUrl === null) {
    throw new Error(
      "No throwaway PostgreSQL cluster is designated for database tests. " +
        "Start one locally with `npm run test:db` (or " +
        "`node scripts/db-test-postgres.mjs start`), or set RABET_TEST_PG_URL " +
        "to a cluster the tests may create and drop databases on. " +
        "DATABASE_URL is deliberately never used by the test suite.",
    );
  }

  const name = throwawayName(label);

  // A connection to the cluster's default database, used to create the
  // throwaway one. `postgres` pools, so it is closed before we connect to the
  // new database below.
  const admin = postgres(baseUrl, { max: 1 });

  try {
    // `CREATE DATABASE` cannot run inside a transaction block; a single
    // statement through the extended protocol is not wrapped in one. The name
    // is generated from a safe alphabet, so it is passed as raw SQL.
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = baseUrl.replace(/\/[^/]*$/, `/${name}`);
  const pool = postgres(url, { max: 5 });
  const db = drizzle({ client: pool, schema });

  // Apply the full committed chain through the same journal-based mechanism
  // the CLI uses.
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    url,
    name,
    async close() {
      await pool.end();

      const dropper = postgres(baseUrl, { max: 1 });

      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/**
 * Extracts the SQLSTATE code from a caught database error.
 *
 * `drizzle-orm`'s shared session rethrows the driver error as a
 * `DrizzleQueryError` with the original on `cause`, so the code is looked up one
 * level deep as well as directly.
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if ("code" in current) {
      const code = (current as Record<string, unknown>).code;

      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return undefined;
}

/**
 * Extracts the message from a caught database error.
 *
 * Returns the message of the deepest error in the `cause` chain — the driver
 * error itself, which names the constraint — rather than Drizzle's
 * `DrizzleQueryError` wrapper, whose message is the failed SQL and parameters.
 */
export function pgErrorMessage(error: unknown): string | undefined {
  let current: unknown = error;
  let message: string | undefined;

  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof Error) message = current.message;

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  return message;
}

/**
 * A monotonically increasing sibling order for fixtures.
 *
 * The two trees enforce unique `sort_order` among siblings through partial
 * unique indexes, so two fixtures that both default to `0` can collide. This
 * counter hands every fixture a fresh order without each test having to think
 * about it, which is also what the real write path does: renumbering siblings
 * so the order stays gapless and unique.
 *
 * The scope of uniqueness differs by index, and the counter is safe for all of
 * them: category sibling order is per parent, category *root* order is unique
 * across every root in the table (`UNIQUE (sort_order) WHERE parent_id IS
 * NULL`), while product-action root order is unique per product
 * (`UNIQUE (product_id, sort_order) WHERE parent_action_id IS NULL`) — so a
 * fresh value is always sufficient and never required between products.
 */
let fixtureSequence = 0;

export function nextOrder(): number {
  return fixtureSequence++;
}

/**
 * A unique ISO 639-1-length language code for a fixture language row.
 *
 * `language.code` is `char(2)` and globally unique, so fixtures cannot all use
 * `en`. The counter is encoded as two base-36 digits, which stays unique for
 * far more fixtures than any suite creates.
 */
export function uniqueLanguageCode(): string {
  return (fixtureSequence++).toString(36).padStart(2, "0").slice(-2);
}

export { schema };

/**
 * Casts a `postgres-js` Drizzle client to the application's `Database` type.
 *
 * The data-access layer in `src/lib/data` is typed against the app's neon-http
 * client (`Database` from `src/db/client.ts`); these suites drive real
 * PostgreSQL through `drizzle-orm/postgres-js`. Both are Drizzle query builders
 * that emit the same parameterized SQL, and the only differences are the driver
 * session and the neon-only `batch()` method, which the data layer does not use
 * (see `src/lib/data/__tests__/driver-contract.test.ts`). The cast is therefore
 * a test seam, not a behaviour change.
 */
export function asAppDb(pgDb: PostgresJsDatabase<typeof schema>): Database {
  return pgDb as unknown as Database;
}
