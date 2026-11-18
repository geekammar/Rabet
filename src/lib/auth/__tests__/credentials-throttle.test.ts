import { beforeEach, describe, expect, it, vi } from "vitest";

const argon2 = vi.hoisted(() => ({ verify: vi.fn() }));
const throttle = vi.hoisted(() => ({
  consumeLoginAttempt: vi.fn(),
  resetLoginThrottle: vi.fn(),
}));

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...actual, verify: argon2.verify };
});
vi.mock("@/lib/auth/login-throttle", () => throttle);

const { verifyAdminCredentials } = await import("@/lib/auth/credentials");

const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-12345678";

beforeEach(() => {
  argon2.verify.mockReset();
  argon2.verify.mockResolvedValue(true);
  throttle.consumeLoginAttempt.mockReset();
  throttle.resetLoginThrottle.mockReset();
});

describe("verifyAdminCredentials — throttle storage failure", () => {
  it("denies the attempt before Argon2 runs when the limiter throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    throttle.consumeLoginAttempt.mockRejectedValueOnce(
      new Error("throttle table unavailable"),
    );

    const user = await verifyAdminCredentials(TEST_EMAIL, TEST_PASSWORD);

    expect(user).toBeNull();
    expect(argon2.verify).not.toHaveBeenCalled();
    expect(throttle.resetLoginThrottle).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("denies the attempt before Argon2 runs when the budget is exhausted", async () => {
    throttle.consumeLoginAttempt.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 60,
    });

    const user = await verifyAdminCredentials(TEST_EMAIL, TEST_PASSWORD);

    expect(user).toBeNull();
    expect(argon2.verify).not.toHaveBeenCalled();
  });
});
