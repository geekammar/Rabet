import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTION_TOKEN_KEY_ENV,
  CONNECTION_TOKEN_KEY_ID_ENV,
  ConnectionSecretsConfigurationError,
  ConnectionSecretsError,
  decryptConnectionSecret,
  encryptConnectionSecret,
  generateLinkNonce,
  generateWebhookSecret,
  hashLinkNonce,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "@/lib/telegram/connection-secrets";

const KEY = crypto.randomBytes(32);
const KEY_ID = "test-v1";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed connection secrets", () => {
  it("encrypts and decrypts a token without storing the plaintext", () => {
    const token = "123456789:AA-managed-store-token";
    const encrypted = encryptConnectionSecret(token, {
      key: KEY,
      keyId: KEY_ID,
    });

    expect(encrypted.keyId).toBe(KEY_ID);
    expect(encrypted.ciphertext).not.toContain(token);
    expect(encrypted.ciphertext.split(".")).toHaveLength(3);
    expect(
      decryptConnectionSecret(encrypted.ciphertext, KEY_ID, {
        key: KEY,
        keyId: KEY_ID,
      }),
    ).toBe(token);

    const second = encryptConnectionSecret(token, {
      key: KEY,
      keyId: KEY_ID,
    });
    expect(second.ciphertext).not.toBe(encrypted.ciphertext);
  });

  it("fails closed for a tampered value, wrong key id or wrong key", () => {
    const token = "123456789:AA-managed-store-token";
    const encrypted = encryptConnectionSecret(token, {
      key: KEY,
      keyId: KEY_ID,
    });
    const parts = encrypted.ciphertext.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${Buffer.from("tampered").toString(
      "base64url",
    )}`;

    expect(() =>
      decryptConnectionSecret(tampered, KEY_ID, { key: KEY, keyId: KEY_ID }),
    ).toThrow(ConnectionSecretsError);

    expect(() =>
      decryptConnectionSecret(encrypted.ciphertext, "another-key-id", {
        key: KEY,
        keyId: KEY_ID,
      }),
    ).toThrow(ConnectionSecretsError);

    expect(() =>
      decryptConnectionSecret(encrypted.ciphertext, KEY_ID, {
        key: crypto.randomBytes(32),
        keyId: KEY_ID,
      }),
    ).toThrow(ConnectionSecretsError);
  });

  it("requires a configured 32-byte key and never echoes the value", () => {
    vi.stubEnv(CONNECTION_TOKEN_KEY_ENV, "");
    vi.stubEnv(CONNECTION_TOKEN_KEY_ID_ENV, KEY_ID);

    expect(() =>
      encryptConnectionSecret("some-token"),
    ).toThrow(ConnectionSecretsConfigurationError);

    const invalid = "not-a-32-byte-key";
    vi.stubEnv(CONNECTION_TOKEN_KEY_ENV, invalid);

    let message = "";

    try {
      encryptConnectionSecret("some-token");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(CONNECTION_TOKEN_KEY_ENV);
    expect(message).not.toContain(invalid);
  });

  it("generates Telegram-compatible webhook secrets and verifies them in constant time", () => {
    const secret = generateWebhookSecret();
    const digest = hashWebhookSecret(secret);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,64}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSecret(secret, digest)).toBe(true);
    expect(verifyWebhookSecret(`${secret}x`, digest)).toBe(false);
    expect(verifyWebhookSecret(null, digest)).toBe(false);
    expect(verifyWebhookSecret(secret, "not-a-digest")).toBe(false);
  });

  it("generates unique link nonces and hashes them with SHA-256", () => {
    const nonce = generateLinkNonce();
    const digest = hashLinkNonce(nonce);

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkNonce(nonce)).toBe(digest);
    expect(generateLinkNonce()).not.toBe(nonce);
  });
});
