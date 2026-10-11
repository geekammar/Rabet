import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * Vitest setup.
 *
 * Provides a single, safe place to define the synthetic environment the auth
 * tests rely on. Only test-only values are ever placed in `process.env` here —
 * no real production secret, password or hash is read from disk, and none is
 * printed anywhere.
 */

const TEST_ADMIN_EMAIL = "admin@example.test";
const TEST_ADMIN_PASSWORD = "test-password-12345678";

/** Names of every environment variable the auth layer may read. */
const AUTH_ENV_KEYS = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD_HASH",
  "AUTH_SECRET",
  "AUTH_URL",
  "AUTH_TRUST_HOST",
  "NEXT_PUBLIC_APP_URL",
] as const;

/** Snapshot of the real environment, restored after the suite finishes. */
const snapshot: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of AUTH_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }

  // Generate a throwaway Argon2id hash for the synthetic admin password. The
  // hash is created in-process and discarded when the test run ends; it is
  // never written to a file and never logged.
  //
  // `algorithm: 2` is `Algorithm.Argon2id` (see @node-rs/argon2). The enum is
  // declared `const enum`, which `isolatedModules` cannot inline inside a
  // `.ts` test module, so the literal is used directly.
  const { hash } = await import("@node-rs/argon2");
  const passwordHash = await hash(TEST_ADMIN_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  process.env.ADMIN_EMAIL = TEST_ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD_HASH = passwordHash;
  // A throwaway 32-byte secret, unique to this test run.
  process.env.AUTH_SECRET = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.AUTH_TRUST_HOST = "true";
});

afterEach(() => {
  // Individual tests that delete these keys to exercise the fail-closed path
  // restore them here so the next file sees a configured environment.
  if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = TEST_ADMIN_EMAIL;
});

afterAll(() => {
  for (const key of AUTH_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
});

/** The synthetic admin credentials, for tests that need to sign in. */
export const TEST_CREDENTIALS = {
  email: TEST_ADMIN_EMAIL,
  password: TEST_ADMIN_PASSWORD,
} as const;
