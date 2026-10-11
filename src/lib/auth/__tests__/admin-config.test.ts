import { afterEach, describe, expect, it } from "vitest";

import { getAdminConfig, isAdminConfigured } from "@/lib/auth/admin-config";

describe("getAdminConfig (fail-closed)", () => {
  afterEach(() => {
    // The shared setup defines these; restore them so ordering does not
    // matter between tests.
    process.env.ADMIN_EMAIL = "admin@example.test";
    process.env.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? "";
  });

  it("returns the admin identity when fully configured", () => {
    const config = getAdminConfig();

    expect(config).not.toBeNull();
    expect(config?.email).toBe("admin@example.test");
    // A real Argon2id PHC string is exposed to the caller, but the tests never
    // print it.
    expect(config?.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
  });

  it("normalizes the email to lowercase", () => {
    process.env.ADMIN_EMAIL = "Admin@Example.TEST";
    expect(getAdminConfig()?.email).toBe("admin@example.test");
  });

  it("fails closed when ADMIN_EMAIL is missing", () => {
    delete process.env.ADMIN_EMAIL;
    expect(getAdminConfig()).toBeNull();
    expect(isAdminConfigured()).toBe(false);
  });

  it("fails closed when ADMIN_PASSWORD_HASH is missing", () => {
    delete process.env.ADMIN_PASSWORD_HASH;
    expect(getAdminConfig()).toBeNull();
    expect(isAdminConfigured()).toBe(false);
  });

  it("fails closed when ADMIN_PASSWORD_HASH is empty", () => {
    process.env.ADMIN_PASSWORD_HASH = "   ";
    expect(getAdminConfig()).toBeNull();
  });

  it("fails closed when ADMIN_PASSWORD_HASH is not an Argon2 PHC string", () => {
    // A pasted plaintext password must never be accepted as a hash.
    process.env.ADMIN_PASSWORD_HASH = "correct-horse-battery-staple";
    expect(getAdminConfig()).toBeNull();
  });

  it("fails closed when the hash is a plain SHA-256 digest", () => {
    process.env.ADMIN_PASSWORD_HASH =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(getAdminConfig()).toBeNull();
  });
});
