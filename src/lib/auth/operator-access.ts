import "server-only";

import crypto from "node:crypto";

/**
 * Operator access gate for the admin credential entry points.
 *
 * The durable login budget is a single row for the one administrator. Without
 * an independent gate, any anonymous request could spend that budget and lock
 * the legitimate owner out. This module requires HTTP Basic credentials (a
 * fixed non-secret username plus a high-entropy operator key held only in the
 * runtime environment) before `/login` or the Auth.js credentials callback can
 * reach Auth.js, the limiter, or Argon2.
 *
 * Why Basic auth: it is the smallest standard primitive that works in mobile
 * browsers through Render's HTTPS proxy, prompts natively without a custom
 * page, and is sent automatically on the login form POST and on direct
 * credential callbacks. The key is a password, never a URL parameter, header
 * name, or committed value. Missing, weak, malformed or wrong credentials all
 * produce the same 401 challenge.
 */

export const OPERATOR_ACCESS_KEY_ENV = "RABET_OPERATOR_ACCESS_KEY";
export const OPERATOR_ACCESS_USER = "operator";
export const OPERATOR_ACCESS_REALM = "Rabet operator";

/**
 * A 32-byte random value encoded as base64 is the documented minimum. Shorter
 * values are treated as unconfigured so a typo or placeholder cannot silently
 * become a weak shared password.
 */
export const OPERATOR_ACCESS_MIN_KEY_LENGTH = 32;

function readOperatorAccessKey(): string | null {
  const raw = process.env[OPERATOR_ACCESS_KEY_ENV];

  if (typeof raw !== "string") return null;

  const key = raw.trim();

  if (key.length < OPERATOR_ACCESS_MIN_KEY_LENGTH) return null;

  return key;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function parseBasicAuthorization(
  authorization: string | null,
): { user: string; password: string } | null {
  if (typeof authorization !== "string") return null;

  const match = /^Basic[ \t]+([A-Za-z0-9+/=\s]+)$/i.exec(authorization.trim());

  if (!match) return null;

  let decoded: string;

  try {
    decoded = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");

  if (separator === -1) return null;

  return {
    user: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

/**
 * True only when the request carries the configured operator credentials.
 *
 * The key is read on every call from the runtime environment. A missing or
 * short key returns false (fail closed) rather than disabling the gate.
 */
export function checkOperatorAccess(
  authorization: string | null,
): boolean {
  const expectedKey = readOperatorAccessKey();

  if (expectedKey === null) return false;

  const credentials = parseBasicAuthorization(authorization);

  if (credentials === null) return false;

  const userMatches = safeEqual(credentials.user, OPERATOR_ACCESS_USER);
  const keyMatches = safeEqual(credentials.password, expectedKey);

  return userMatches && keyMatches;
}

/** The single 401 response used for missing, invalid and unconfigured access. */
export function operatorAccessChallenge(): Response {
  return new Response("Operator access required.\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${OPERATOR_ACCESS_REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/** Paths that can reach Auth.js credential verification. */
export function isOperatorAccessPath(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

  return (
    normalized === "/login" ||
    normalized === "/api/auth/callback/credentials"
  );
}
