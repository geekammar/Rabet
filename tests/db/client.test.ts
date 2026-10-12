import { afterAll, afterEach, expect, it, vi } from "vitest";

/**
 * The application database client (ADR-015, DATA_MODEL.md §15.3).
 *
 * These are the properties that matter for the *deployment*, and none of them
 * needs a running database — which is the point:
 *
 *   - importing the client must never require `DATABASE_URL`, so a build, a
 *     preview without database variables, or a route that does not touch the
 *     database cannot fail because a database is absent;
 *   - a missing or malformed connection string must fail loudly, without
 *     echoing the value (it carries a password);
 *   - the chosen driver genuinely lacks interactive transactions, which is the
 *     constraint the whole `db.batch()` write strategy exists to satisfy.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  // The client memoizes one instance per process; a fresh module registry per
  // case keeps that from leaking between assertions.
  vi.resetModules();
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

it("imports without DATABASE_URL configured", async () => {
  delete process.env.DATABASE_URL;

  await expect(import("@/db/client")).resolves.toBeDefined();
});

it("fails loudly when DATABASE_URL is missing", async () => {
  delete process.env.DATABASE_URL;

  const { getDb } = await import("@/db/client");

  expect(() => getDb()).toThrow(/DATABASE_URL is not configured/);
});

it("fails loudly when DATABASE_URL is not a PostgreSQL connection string", async () => {
  process.env.DATABASE_URL = "not-a-connection-string";

  const { getDb } = await import("@/db/client");

  expect(() => getDb()).toThrow(/not a valid PostgreSQL connection string/);
});

it("never echoes the connection string in the error it raises", async () => {
  const password = "do-not-leak-this";
  const username = "nor-this-user";

  // A scheme the client rejects, but carrying credentials: the failure message
  // must describe the problem without repeating the value.
  process.env.DATABASE_URL = `mysql://${username}:${password}@db.example.com/prod`;

  const { getDb } = await import("@/db/client");

  let message = "";

  try {
    getDb();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(/not a valid PostgreSQL connection string/);
  expect(message).not.toContain(password);
  expect(message).not.toContain(username);
});

it("creates a client lazily and memoizes a single instance", async () => {
  process.env.DATABASE_URL =
    "postgresql://user:pass@ep-example.neon.tech/rabet?sslmode=require";

  const client = await import("@/db/client");

  expect(client.isDbInitialized()).toBe(false);

  const first = client.getDb();
  const second = client.getDb();

  // One client per process is what the HTTP driver is designed for; there is no
  // pool to manage and no connection to hold open.
  expect(first).toBe(second);
  expect(client.isDbInitialized()).toBe(true);
});

it("has no interactive transactions on the neon-http driver", async () => {
  process.env.DATABASE_URL = "postgresql://user:pass@ep-example.neon.tech/rabet";

  const { getDb } = await import("@/db/client");
  const db = getDb();

  // Verified against the driver source (ADR-015): `NeonHttpSession.transaction()`
  // throws. This is the constraint the design is shaped around — every atomic
  // multi-step write is a non-interactive `db.batch([...])` with per-site
  // idempotency, never an interactive `db.transaction(async (tx) => …)`.
  await expect(db.transaction(async () => {})).rejects.toThrow(
    /No transactions support in neon-http driver/,
  );
});
