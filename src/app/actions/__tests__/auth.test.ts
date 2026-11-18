import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the login / logout Server Actions.
 *
 * The integration suite covers the HTTP callback path. These tests cover the
 * Server Action path — the code the `<form action={formAction}>` actually
 * invokes — and in particular the redirect-allowlist wiring: `login` must pass
 * `callbackUrl` through `safeLoginRedirect` before it can reach Auth.js's
 * `signIn`. That is the defence the open-redirect unit tests in
 * `src/lib/auth/__tests__/redirect.test.ts` assume is connected.
 *
 * `signIn` / `signOut` from `@/auth` are mocked so the tests assert on the
 * arguments the action hands to Auth.js instead of performing a real sign-in.
 * No real secret, password or hash is used or printed here.
 */

const requestState = vi.hoisted(() => ({ authorization: "" }));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(
      requestState.authorization
        ? { Authorization: requestState.authorization }
        : {},
    ),
}));

vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// `login` re-exports nothing from next/auth at runtime beyond `AuthError`, but
// importing `@/auth` transitatively pulls in `next/server`, which only resolves
// inside the Next runtime. Stub the module boundary the action actually uses.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {
    code: string;
    constructor(message: string) {
      super(message);
      this.code = message;
    }
  },
}));

// Imported after the mock is registered so `@/auth` resolves to the stub.
const { login, logout } = await import("@/app/actions/auth");
const { signIn, signOut } = await import("@/auth");

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.append(key, value);
  }
  return fd;
}

const VALID = {
  email: "admin@example.test",
  password: "test-password-12345678",
};

const TEST_OPERATOR_ACCESS_KEY =
  "action-test-operator-access-key-32-characters";
const OPERATOR_AUTHORIZATION = `Basic ${Buffer.from(
  `operator:${TEST_OPERATOR_ACCESS_KEY}`,
  "utf8",
).toString("base64")}`;

beforeEach(() => {
  vi.stubEnv("RABET_OPERATOR_ACCESS_KEY", TEST_OPERATOR_ACCESS_KEY);
  requestState.authorization = OPERATOR_AUTHORIZATION;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("login action — redirect allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies safeLoginRedirect to an external callbackUrl", async () => {
    await login(undefined, formData({ ...VALID, callbackUrl: "https://evil.example.com/path" }));

    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/overview" }),
    );
  });

  it("applies safeLoginRedirect to a protocol-relative callbackUrl", async () => {
    await login(undefined, formData({ ...VALID, callbackUrl: "//evil.example.com/path" }));

    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/overview" }),
    );
  });

  it("preserves a safe internal callbackUrl", async () => {
    await login(undefined, formData({ ...VALID, callbackUrl: "/inquiries" }));

    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/inquiries" }),
    );
  });

  it("falls back to the default when callbackUrl is absent", async () => {
    await login(undefined, formData(VALID));

    expect(signIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/overview" }),
    );
  });

  it("hands each submission to Auth.js exactly once", async () => {
    await login(undefined, formData(VALID));

    // The action does not run a second limiter/count of its own: Auth.js calls
    // the shared `verifyAdminCredentials` boundary once, which consumes one
    // attempt. That is what keeps the form and the callback path on one budget.
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});

describe("login action — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a generic message and never calls signIn on malformed input", async () => {
    const state = await login(undefined, formData({ email: "not-an-email", password: "x" }));

    expect(state.message).toBe("Incorrect email or password.");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("returns a generic message when credentials are rejected", async () => {
    // Rejected sign-ins surface as an AuthError; the action must collapse every
    // flavour of failure into one message so the admin email cannot be enumerated.
    const { AuthError } = await import("next-auth");
    vi.mocked(signIn).mockRejectedValueOnce(new AuthError("CredentialsSignin"));

    const state = await login(undefined, formData({ ...VALID, callbackUrl: "/overview" }));

    expect(state.message).toBe("Incorrect email or password.");
  });

  it("rejects missing or invalid operator access before calling Auth.js", async () => {
    requestState.authorization = "";
    const missing = await login(undefined, formData(VALID));
    expect(missing.message).toBe("Incorrect email or password.");
    expect(signIn).not.toHaveBeenCalled();

    requestState.authorization = `Basic ${Buffer.from(
      `operator:wrong-${TEST_OPERATOR_ACCESS_KEY}`,
      "utf8",
    ).toString("base64")}`;
    const invalid = await login(undefined, formData(VALID));
    expect(invalid.message).toBe("Incorrect email or password.");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("re-throws unexpected errors instead of rendering a success-looking page", async () => {
    vi.mocked(signIn).mockRejectedValueOnce(new Error("infrastructure failure"));

    await expect(
      login(undefined, formData({ ...VALID, callbackUrl: "/overview" })),
    ).rejects.toThrow("infrastructure failure");
  });
});

describe("logout action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signs out with a fixed internal redirect", async () => {
    await logout();

    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/login" });
  });
});
