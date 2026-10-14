import { afterAll, afterEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";

/**
 * The data layer's driver contract — the part the disposable-PostgreSQL
 * integration suites **cannot** exercise, asserted here instead.
 *
 * `db.batch([...])` is the neon-http driver's non-interactive batched
 * transaction and the only atomicity mechanism available on that driver
 * (ADR-015): `db.transaction()` throws. The integration suites run against real
 * PostgreSQL through `drizzle-orm/postgres-js`, which in the installed Drizzle
 * version does not implement `batch` at all — so a neon batch cannot be replayed
 * against a throwaway cluster.
 *
 * This file documents both halves of that boundary at the driver level: the
 * application client exposes `batch`, the integration client does not, and no
 * Phase 03C-A write path needs one (every write here is a single statement,
 * idempotent at its own site). The end-to-end batch path therefore remains
 * unexercised, honestly — it will be exercised by the first write path that
 * genuinely needs several statements to commit together.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  // The application client memoizes one instance per process.
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

  // This is the API a future multi-statement atomic write will use. Its presence
  // here is the driver-level guarantee; `tests/db/client.test.ts` asserts the
  // other half, that `transaction()` throws on this driver.
  expect(typeof getDb().batch).toBe("function");
});

it("does not expose db.batch on the integration client the DB suites use", () => {
  // `postgres()` performs no I/O at construction; the first query would be the
  // first connection, and this test never runs one.
  const pool = postgres("postgresql://user:pass@127.0.0.1:1/rabet", { max: 1 });
  const integrationClient = drizzle({ client: pool, schema });

  // The disposable-PostgreSQL suites therefore cannot replay a neon batch — the
  // honest reason the batch path is verified at the driver level only.
  expect((integrationClient as unknown as { batch?: unknown }).batch).toBeUndefined();

  return pool.end();
});
