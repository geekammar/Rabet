import "server-only";

/**
 * Environment-based single-administrator configuration.
 *
 * Rabet's MVP has exactly one administrator. Their identity is declared
 * through server-only environment variables rather than a user table:
 *
 *   ADMIN_EMAIL          The administrator's sign-in email.
 *   ADMIN_PASSWORD_HASH  An Argon2id PHC string (never a plaintext password).
 *
 * Nothing here is ever written to a database, and no registration flow
 * exists. See `.env.example` and `scripts/generate-admin-hash.mjs` for how to
 * generate the hash locally.
 *
 * Failure mode: **fail closed.** If either variable is missing, empty, or the
 * hash is not a recognisable Argon2 PHC string, `getAdminConfig()` returns
 * `null` and every sign-in attempt is rejected. The dashboard stays
 * inaccessible rather than falling back to a weaker or default account —
 * there is no default account and no bypass.
 *
 * The missing-configuration state must remain a *runtime* failure, not a
 * module-load throw: builds and CI run against a test-only configuration and
 * must not crash at import time.
 */

const PHC_ARGON2_PREFIX = "$argon2";

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type AdminConfig = {
  /** The administrator's sign-in email, normalised to lowercase. */
  email: string;
  /** The Argon2id PHC password hash. Never logged or returned to a client. */
  passwordHash: string;
};

/**
 * Reads and validates the admin configuration from the environment.
 *
 * Returns `null` when the configuration is missing or invalid — callers must
 * treat that as "nobody may sign in" and reject the attempt.
 */
export function getAdminConfig(): AdminConfig | null {
  const email = readEnv("ADMIN_EMAIL");
  const passwordHash = readEnv("ADMIN_PASSWORD_HASH");

  if (!email || !passwordHash) return null;

  // Fail closed on a hash that could never verify: this catches a pasted
  // plaintext password or a truncated value early, instead of relying on the
  // Argon2 verify call to reject it.
  if (!passwordHash.startsWith(PHC_ARGON2_PREFIX)) return null;

  return { email: email.toLowerCase(), passwordHash };
}

/**
 * True only when the admin identity is fully configured.
 *
 * Use this when a `null` result is meaningful (for example to render an honest
 * "sign-in unavailable" state on the login page when the deployment is
 * misconfigured, without leaking which variable is wrong).
 *
 * Prefer the `_Async` variant inside a Cache Components route: calling the
 * sync version at the top level of a page bakes the result into the static
 * shell at build time, when the environment may differ from runtime.
 */
export function isAdminConfigured(): boolean {
  return getAdminConfig() !== null;
}

/**
 * Async wrapper for use inside a `<Suspense>` boundary in Cache Components.
 *
 * `Promise.resolve` is enough to force the call into the streamed segment
 * rather than the prerendered shell, so the value always reflects the runtime
 * environment instead of the build-time one.
 */
export async function isAdminConfiguredAsync(): Promise<boolean> {
  return getAdminConfig() !== null;
}
