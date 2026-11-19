import { afterAll, afterEach, expect, it, vi } from "vitest";

/**
 * The transactional database client's deployment contract.
 *
 * These assertions need no running database: importing the module must not
 * read configuration, the process client is lazy and memoized, and the
 * explicit test construction path cannot fall back to `DATABASE_URL`.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  vi.resetModules();

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
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

  await expect(import("@/db/transaction-client")).resolves.toBeDefined();
});

it("fails loudly on first use when DATABASE_URL is missing", async () => {
  delete process.env.DATABASE_URL;

  const client = await import("@/db/transaction-client");

  expect(client.isTransactionClientInitialized()).toBe(false);
  expect(() => client.getTransactionDb()).toThrow(
    /DATABASE_URL is not configured/,
  );
  expect(client.isTransactionClientInitialized()).toBe(false);
});

it("rejects an invalid connection string without echoing its credentials", async () => {
  const username = "do-not-leak-this-user";
  const password = "do-not-leak-this-password";

  process.env.DATABASE_URL = `mysql://${username}:${password}@db.example.test/prod`;

  const client = await import("@/db/transaction-client");

  let message = "";

  try {
    client.getTransactionDb();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(/not a valid PostgreSQL connection string/);
  expect(message).not.toContain(username);
  expect(message).not.toContain(password);
});

it("rejects a malformed PostgreSQL URL without echoing it", async () => {
  const password = "malformed-password";

  process.env.DATABASE_URL = `postgresql://user:${password}@/rabet`;

  const client = await import("@/db/transaction-client");

  let message = "";

  try {
    client.getTransactionDb();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(/not a valid PostgreSQL connection string/);
  expect(message).not.toContain(password);
});

it("creates the process client lazily and memoizes one instance", async () => {
  process.env.DATABASE_URL =
    "postgresql://user:pass@ep-example.neon.tech/rabet";

  const client = await import("@/db/transaction-client");

  expect(client.isTransactionClientInitialized()).toBe(false);

  const first = client.getTransactionDb();
  const second = client.getTransactionDb();

  expect(first).toBe(second);
  expect(client.isTransactionClientInitialized()).toBe(true);
});

it("requires an explicit URL instead of reading DATABASE_URL", async () => {
  process.env.DATABASE_URL =
    "postgresql://runtime-user:runtime-pass@127.0.0.1:5432/runtime_db";

  const { createTransactionClient } = await import(
    "@/db/transaction-client"
  );

  expect(() => createTransactionClient("")).toThrow(
    /required to create the transaction database client/,
  );

  const explicit = createTransactionClient(
    "postgresql://explicit-user:explicit-pass@127.0.0.1:5432/explicit_db",
  );

  expect(explicit.db.$client.options.database).toBe("explicit_db");
  expect(explicit.db.$client.options.host).toEqual(["127.0.0.1"]);

  await explicit.close();
});

it("bounds the pool, times out connections, and keeps TLS on Neon", async () => {
  const { createTransactionClient } = await import(
    "@/db/transaction-client"
  );

  const neon = createTransactionClient(
    "postgresql://user:pass@ep-example.neon.tech/rabet",
  );

  expect(neon.db.$client.options.max).toBe(5);
  expect(neon.db.$client.options.connect_timeout).toBe(10);
  expect(neon.db.$client.options.idle_timeout).toBe(20);
  expect(neon.db.$client.options.max_lifetime).toBe(300);
  expect(neon.db.$client.options.ssl).toBe("require");

  await neon.close();

  const verified = createTransactionClient(
    "postgresql://user:pass@ep-example.neon.tech/rabet?sslmode=verify-full",
  );

  expect(verified.db.$client.options.ssl).toBe("verify-full");

  await verified.close();

  const local = createTransactionClient(
    "postgresql://user:pass@127.0.0.1:5432/rabet",
  );

  expect(local.db.$client.options.ssl).toBe(false);

  await local.close();
});
