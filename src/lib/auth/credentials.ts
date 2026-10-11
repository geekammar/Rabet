import "server-only";

import { verify } from "@node-rs/argon2";

import { getAdminConfig } from "@/lib/auth/admin-config";
import { signInSchema } from "@/lib/auth/schema";

/**
 * Credential verification for the single administrator.
 *
 * Uses Argon2id — the OWASP-recommended memory-hard password hashing
 * algorithm — via `@node-rs/argon2` (Rust implementation shipped as a
 * prebuilt native binary). Plain SHA-256 is never used for password hashing.
 *
 * Security properties:
 * - The stored value is an Argon2id PHC string; the plaintext password is
 *   never stored, logged, or compared in the clear.
 * - The result of a failed attempt is identical regardless of *which* part of
 *   the credential was wrong: `null` in every case, with the same generic
 *   message shown to the user, so an attacker cannot enumerate the admin
 *   email by watching error text.
 * - Timing side-channels on the email comparison are mitigated by always
 *   performing one Argon2 verification per attempt — including when the email
 *   does not match — so the expensive work cannot be skipped to detect a
 *   correct email address. The Argon2 cost itself dominates request time.
 */

export type AdminUser = {
  /** Stable identifier for the single administrator. */
  id: string;
  email: string;
};

const ADMIN_USER_ID = "admin";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Validates raw credentials and, when they belong to the configured
 * administrator, returns the admin user object. Returns `null` otherwise.
 *
 * Throws only on unexpected infrastructure errors (never on bad credentials).
 */
export async function verifyAdminCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<AdminUser | null> {
  const parsed = signInSchema.safeParse({
    email: rawEmail,
    password: rawPassword,
  });

  // Malformed input never reaches the hashing layer.
  if (!parsed.success) return null;

  const { email, password } = parsed.data;
  const config = getAdminConfig();

  // Fail closed when the deployment has no complete admin configuration.
  if (!config) return null;

  // Always run one Argon2 verification so a wrong email costs the same as a
  // wrong password (see the note on timing above).
  const passwordMatches = await verify(config.passwordHash, password).catch(
    () => false,
  );
  const emailMatches = safeEqual(email, config.email);

  if (!emailMatches || !passwordMatches) return null;

  return { id: ADMIN_USER_ID, email: config.email };
}
