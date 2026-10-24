import { afterAll, afterEach, expect, it, vi } from "vitest";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { executeAtomicBatch } from "../catalog";

/**
 * The data layer's driver contract verification.
 *
 * `db.batch([...])` is the neon-http driver's non-interactive batched
 * transaction and the only atomicity mechanism available on that driver
 * (ADR-015): `db.transaction()` throws on neon-http.
 *
 * This suite proves unit contracts:
 * 1. The application client exposes `db.batch`.
 * 2. The integration client (postgres-js) does not expose `batch`, justifying executeAtomicBatch.
 * 3. executeAtomicBatch dispatches to `db.batch` when present on neon-http.
 *
 * The PostgreSQL integration test with real neon-http serialization and rollback
 * through the local protocol bridge runs in `tests/db/neon-driver-batch.test.ts`.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  vi.resetModules();
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
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
