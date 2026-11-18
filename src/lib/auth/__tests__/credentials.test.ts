import { beforeEach, describe, expect, it, vi } from "vitest";

const throttle = vi.hoisted(() => ({
  consumeLoginAttempt: vi.fn(),
  resetLoginThrottle: vi.fn(),
}));

vi.mock("@/lib/auth/login-throttle", () => throttle);

import { verifyAdminCredentials } from "@/lib/auth/credentials";

/**
 * Synthetic admin credentials for the unit tests. These are generated in
 * `tests/setup.ts` (a throwaway Argon2id hash of a throwaway password) and are
 * inlined here rather than imported, so that no `tests/` module is pulled into
 * the application source tree.
 */
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-12345678";

beforeEach(() => {
  throttle.consumeLoginAttempt.mockReset();
  throttle.consumeLoginAttempt.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
  throttle.resetLoginThrottle.mockReset();
  throttle.resetLoginThrottle.mockResolvedValue(undefined);
});

describe("verifyAdminCredentials", () => {
  it("accepts the correct email and password", async () => {
    const user = await verifyAdminCredentials(
      TEST_EMAIL,
      TEST_PASSWORD,
    );

    expect(user).not.toBeNull();
    expect(user?.id).toBe("admin");
    expect(user?.email).toBe(TEST_EMAIL);
  });

  it("accepts the correct email regardless of case or surrounding spaces", async () => {
    const user = await verifyAdminCredentials(
      "  ADMIN@EXAMPLE.TEST  ",
      TEST_PASSWORD,
    );

    expect(user?.email).toBe(TEST_EMAIL);
  });

  it("rejects a wrong password for a known email", async () => {
    const user = await verifyAdminCredentials(
      TEST_EMAIL,
      "definitely-not-the-password",
    );

    expect(user).toBeNull();
  });

  it("rejects an unknown email", async () => {
    const user = await verifyAdminCredentials(
      "intruder@example.test",
      TEST_PASSWORD,
    );

    expect(user).toBeNull();
  });

  it("rejects an unknown email with a wrong password", async () => {
    const user = await verifyAdminCredentials(
      "intruder@example.test",
      "definitely-not-the-password",
    );

    expect(user).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    expect(await verifyAdminCredentials(null, null)).toBeNull();
    expect(await verifyAdminCredentials(undefined, undefined)).toBeNull();
    expect(await verifyAdminCredentials(12345, true)).toBeNull();
  });

  it("rejects an email that is not a valid address", async () => {
    expect(await verifyAdminCredentials("not-an-email", "whatever")).toBeNull();
  });

  it("rejects an oversized password payload", async () => {
    const longPassword = "a".repeat(2000);
    expect(
      await verifyAdminCredentials(TEST_EMAIL, longPassword),
    ).toBeNull();
  });

  it("never returns a user object containing a password or hash", async () => {
    const user = await verifyAdminCredentials(
      TEST_EMAIL,
      TEST_PASSWORD,
    );

    expect(user).not.toBeNull();
    expect(JSON.stringify(user)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(user)).not.toContain("argon2");
  });

  it("consumes one shared attempt per verification and resets on success", async () => {
    const user = await verifyAdminCredentials(TEST_EMAIL, TEST_PASSWORD);

    expect(user).not.toBeNull();
    expect(throttle.consumeLoginAttempt).toHaveBeenCalledTimes(1);
    expect(throttle.resetLoginThrottle).toHaveBeenCalledTimes(1);
  });

  it("rejects without verifying the password when the budget is exhausted", async () => {
    throttle.consumeLoginAttempt.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 600,
    });

    const user = await verifyAdminCredentials(TEST_EMAIL, TEST_PASSWORD);

    expect(user).toBeNull();
    expect(throttle.resetLoginThrottle).not.toHaveBeenCalled();
  });
});
