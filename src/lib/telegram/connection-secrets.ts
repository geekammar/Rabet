import "server-only";

import crypto from "node:crypto";

/**
 * Server-only secret handling for managed Telegram connections.
 *
 * A managed Store Bot token is encrypted at rest with AES-256-GCM and a
 * versioned, environment-owned key. The raw webhook secret is generated once,
 * sent to Telegram in `setWebhook`, and never stored: only its SHA-256 digest
 * is persisted. The legacy environment-token bot does not use this module.
 */

export const CONNECTION_TOKEN_KEY_ENV = "TELEGRAM_CONNECTION_TOKEN_KEY";
export const CONNECTION_TOKEN_KEY_ID_ENV = "TELEGRAM_CONNECTION_TOKEN_KEY_ID";

const DEFAULT_KEY_ID = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class ConnectionSecretsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionSecretsConfigurationError";
  }
}

export class ConnectionSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionSecretsError";
  }
}

function decodeKey(raw: string): Buffer {
  let key: Buffer;

  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new ConnectionSecretsConfigurationError(
      `${CONNECTION_TOKEN_KEY_ENV} is not valid base64.`,
    );
  }

  if (key.length !== KEY_BYTES) {
    throw new ConnectionSecretsConfigurationError(
      `${CONNECTION_TOKEN_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes.`,
    );
  }

  return key;
}

/**
 * Reads the configured encryption key. The error never echoes the value.
 */
export function readConnectionSecretKey(): { key: Buffer; keyId: string } {
  const raw = process.env[CONNECTION_TOKEN_KEY_ENV];

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConnectionSecretsConfigurationError(
      `${CONNECTION_TOKEN_KEY_ENV} is not configured.`,
    );
  }

  const keyIdRaw = process.env[CONNECTION_TOKEN_KEY_ID_ENV];
  const keyId =
    typeof keyIdRaw === "string" && keyIdRaw.trim().length > 0
      ? keyIdRaw.trim()
      : DEFAULT_KEY_ID;

  if (!/^[A-Za-z0-9._-]{1,32}$/.test(keyId)) {
    throw new ConnectionSecretsConfigurationError(
      `${CONNECTION_TOKEN_KEY_ID_ENV} is not a valid key id.`,
    );
  }

  return { key: decodeKey(raw.trim()), keyId };
}

/**
 * Encrypts a server-only secret. The returned `ciphertext` never contains the
 * plaintext. The key id is stored beside it so rotation is explicit.
 */
export function encryptConnectionSecret(
  plaintext: string,
  options?: { key?: Buffer; keyId?: string },
): { ciphertext: string; keyId: string } {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new ConnectionSecretsError("A non-empty secret is required.");
  }

  const configured = options?.key
    ? { key: options.key, keyId: options.keyId ?? DEFAULT_KEY_ID }
    : readConnectionSecretKey();

  if (configured.key.length !== KEY_BYTES) {
    throw new ConnectionSecretsConfigurationError(
      `An encryption key must be exactly ${KEY_BYTES} bytes.`,
    );
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", configured.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: [
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    keyId: configured.keyId,
  };
}

/**
 * Decrypts a secret and verifies the authentication tag. A key id mismatch, a
 * tampered ciphertext or an invalid key fails closed.
 */
export function decryptConnectionSecret(
  ciphertext: string,
  keyId: string,
  options?: { key?: Buffer; keyId?: string },
): string {
  const configured = options?.key
    ? { key: options.key, keyId: options.keyId ?? DEFAULT_KEY_ID }
    : readConnectionSecretKey();

  if (configured.keyId !== keyId) {
    throw new ConnectionSecretsError(
      "The stored secret was encrypted with a different key version.",
    );
  }

  const parts = typeof ciphertext === "string" ? ciphertext.split(".") : [];

  if (parts.length !== 3) {
    throw new ConnectionSecretsError("The stored secret is malformed.");
  }

  let iv: Buffer;
  let tag: Buffer;
  let encrypted: Buffer;

  try {
    iv = Buffer.from(parts[0], "base64url");
    tag = Buffer.from(parts[1], "base64url");
    encrypted = Buffer.from(parts[2], "base64url");
  } catch {
    throw new ConnectionSecretsError("The stored secret is malformed.");
  }

  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new ConnectionSecretsError("The stored secret is malformed.");
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      configured.key,
      iv,
    );
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ConnectionSecretsError(
      "The stored secret could not be decrypted.",
    );
  }
}

/** Generates a 256-bit correlation nonce (43 base64url characters). */
export function generateLinkNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Returns the SHA-256 hex digest used to look up a link nonce. */
export function hashLinkNonce(nonce: string): string {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Generates a Telegram-compatible webhook secret token (1-256 characters from
 * `A-Z a-z 0-9 _ -`). 256 random bits encoded as base64url satisfies that.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Hashes a webhook secret for storage. The raw value is never persisted. */
export function hashWebhookSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time verification of the secret header against the stored digest.
 * Missing or malformed values fail closed without throwing.
 */
export function verifyWebhookSecret(
  incomingSecret: string | null,
  expectedHash: string,
): boolean {
  if (
    typeof incomingSecret !== "string" ||
    incomingSecret.length === 0 ||
    typeof expectedHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedHash)
  ) {
    return false;
  }

  const actual = Buffer.from(hashWebhookSecret(incomingSecret), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (actual.length !== expected.length) {
    crypto.timingSafeEqual(actual, actual);
    return false;
  }

  return crypto.timingSafeEqual(actual, expected);
}
