import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/auth-platform", () => ({
  signIn: authState.signIn,
  signOut: authState.signOut,
}));

vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {
    code: string;
    constructor(message: string) {
      super(message);
      this.code = message;
    }
  },
}));

const { platformLogin, platformLogout } = await import(
  "@/app/actions/platform-auth"
);

function formData(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform login action", () => {
  it("uses a fixed internal redirect and never a caller-supplied callback URL", async () => {
    authState.signIn.mockResolvedValueOnce(undefined);

    const state = await platformLogin(
      undefined,
      formData({
        email: "platform.admin@example.test",
        password: "platform-password-123",
        callbackUrl: "https://evil.example.test/",
      }),
    );

    expect(authState.signIn).toHaveBeenCalledWith("credentials", {
      email: "platform.admin@example.test",
      password: "platform-password-123",
      redirectTo: "/platform/invitations",
    });
    expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("rejects malformed input without calling Auth.js", async () => {
    const state = await platformLogin(
      undefined,
      formData({ email: "not-an-email", password: "" }),
    );

    expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(authState.signIn).not.toHaveBeenCalled();
  });

  it("collapses Auth.js credential failures into one generic code", async () => {
    const { AuthError } = await import("next-auth");
    authState.signIn.mockRejectedValueOnce(new AuthError("CredentialsSignin"));

    const state = await platformLogin(
      undefined,
      formData({
        email: "platform.admin@example.test",
        password: "wrong-password-123",
      }),
    );

    expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
  });
});

describe("platform logout action", () => {
  it("signs out with a fixed internal redirect", async () => {
    await platformLogout();

    expect(authState.signOut).toHaveBeenCalledWith({
      redirectTo: "/platform/login",
    });
  });
});
