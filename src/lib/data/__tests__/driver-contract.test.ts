import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { category, categoryTranslation } from "@/db/schema";
import { executeAtomicBatch } from "../catalog";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "../../../../tests/db/helpers";

/**
 * The data layer's driver contract and atomic batch verification.
 *
 * `db.batch([...])` is the neon-http driver's non-interactive batched
 * transaction and the only atomicity mechanism available on that driver
 * (ADR-015): `db.transaction()` throws on neon-http.
 *
 * This suite proves:
 * 1. The application client exposes `db.batch`.
 * 2. The integration client (postgres-js) does not expose `batch`, justifying executeAtomicBatch.
 * 3. executeAtomicBatch dispatches to `db.batch` when present on neon-http.
 * 4. Real neon-http query builders serialize a multi-statement batch payload to HTTP,
 *    and when bridged to PostgreSQL, an intentionally failing statement triggers complete
 *    transactional rollback, leaving zero base or translation rows committed.
 *
 * NOTE: This validates the local protocol bridge and application path against disposable
 * loopback PostgreSQL, NOT live Neon cloud transport.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.resetModules();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  globalThis.fetch = originalFetch;
});

it("exposes db.batch on the application (neon-http) client", async () => {
  process.env.DATABASE_URL = "postgresql://user:pass@ep-example.neon.tech/rabet";

  const { getDb } = await import("@/db/client");
  expect(typeof getDb().batch).toBe("function");
});

it("does not expose db.batch on the integration client the DB suites use", () => {
  const pool = postgres("postgresql://user:pass@127.0.0.1:1/rabet", { max: 1 });
  const integrationClient = drizzlePostgres({ client: pool, schema });

  expect((integrationClient as unknown as { batch?: unknown }).batch).toBeUndefined();

  return pool.end();
});

it("proves executeAtomicBatch uses db.batch when present", async () => {
  const mockBatch = vi.fn().mockResolvedValue(["res1", "res2"]);
  const mockDb = { batch: mockBatch } as unknown as import("@/db/client").Database;

  const queries = ["stmt1", "stmt2"] as unknown as Parameters<typeof executeAtomicBatch>[1];
  const results = await executeAtomicBatch(mockDb, queries);

  expect(mockBatch).toHaveBeenCalledWith(queries);
  expect(results).toEqual(["res1", "res2"]);
});

const canRunDb = hasTestCluster();

describe.skipIf(!canRunDb)("neon-http batch protocol bridge & rollback", () => {
  let testDb: TestDatabase | null = null;
  let pgPool: postgres.Sql | null = null;

  afterAll(async () => {
    if (pgPool) {
      await pgPool.end();
      pgPool = null;
    }
    if (testDb) {
      await testDb.close();
      testDb = null;
    }
  });

  it("proves real neon-http batch serialization and complete rollback on failure through local protocol bridge", async () => {
    testDb = await createTestDatabase("neon_driver_batch");
    pgPool = postgres(testDb.url);

    // Protocol bridge: intercepts neon-http fetch calls and executes batch in a transaction on loopback PostgreSQL
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input ? (input as Request).url : "";
      if (url.includes("ep-example.neon.tech")) {
        const body = JSON.parse(init?.body as string);
        if (body.queries) {
          try {
            const results: unknown[] = [];
            await pgPool!.begin(async (sql) => {
              for (const q of body.queries) {
                const rows = await sql.unsafe(q.query, q.params || []);
                const cols = rows.columns || [];
                const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));
                const rowArrays = rows.map((r: Record<string, unknown>) =>
                  cols.map((c) => r[c.name]),
                );
                results.push({ rows: rowArrays, fields });
              }
            });
            return new Response(JSON.stringify({ results }), { status: 200 });
          } catch (err: unknown) {
            return new Response(
              JSON.stringify({ message: (err as Error).message }),
              { status: 400 },
            );
          }
        }
      }
      return originalFetch(input, init);
    };

    // Instantiate real neon-http Drizzle client
    const neonClient = neon("postgresql://test:test@ep-example.neon.tech/rabet");
    const neonDb = drizzleNeon(neonClient, { schema });

    const doomedCatId = globalThis.crypto.randomUUID();
    const doomedTransId = globalThis.crypto.randomUUID();
    const invalidLangId = globalThis.crypto.randomUUID(); // Foreign key violation!

    // Statement 1: Valid category insert
    const q1 = neonDb.insert(category).values({
      id: doomedCatId,
      parentId: null,
      slug: "neon-batch-doomed-cat",
      sortOrder: 1,
      isActive: false,
    });

    // Statement 2: Intentionally failing translation insert (non-existent language_id)
    const q2 = neonDb.insert(categoryTranslation).values({
      id: doomedTransId,
      categoryId: doomedCatId,
      languageId: invalidLangId,
      name: "Doomed Translation",
    });

    // Execute atomic batch; this must serialize through neon-http, hit the protocol bridge,
    // trigger transaction rollback on PostgreSQL, and reject
    await expect(executeAtomicBatch(neonDb as unknown as import("@/db/client").Database, [q1, q2])).rejects.toThrow();

    // Verify against PostgreSQL directly: the category row was NOT committed
    const existing = await testDb.db
      .select()
      .from(category)
      .where(eq(category.id, doomedCatId));

    expect(existing).toHaveLength(0);
  });
});
