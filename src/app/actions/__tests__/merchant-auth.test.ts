import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/auth-merchant", () => ({
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

const { merchantLogin, merchantLogout } = await import(
  "@/app/actions/merchant-auth"
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

describe("merchant auth actions — enablement gate", () => {
  it("does not call Auth.js while the merchant surface is disabled", async () => {
    const state = await merchantLogin(undefined, formData({
      email: "merchant@example.test",
      password: "merchant-password-123",
    }));

    expect(state).toEqual({ error: "UNAVAILABLE" });
    expect(authState.signIn).not.toHaveBeenCalled();

    await merchantLogout();
    expect(authState.signOut).not.toHaveBeenCalled();
  });
});

describe("merchant login action", () => {
  beforeEach(() => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
  });

  it.each(["//example.invalid/", "15fd76b5-fe40-44b3-b72f-f12c85e27ef0\n"])(
    "falls back to setup for an invalid order target (%j)", async (order) => {
      authState.signIn.mockResolvedValueOnce(undefined);

      const state = await merchantLogin(undefined, formData({
        email: "merchant@example.test",
        password: "merchant-password-123",
        callbackUrl: "https://example.invalid/",
        order,
      }));

      expect(authState.signIn).toHaveBeenCalledWith("credentials", {
        email: "merchant@example.test",
        password: "merchant-password-123",
        redirectTo: "/app/setup",
      });
      expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
    },
  );

  it("reconstructs the Orders URL and card anchor from a valid order ID", async () => {
    const orderId = "15fd76b5-fe40-44b3-b72f-f12c85e27ef0";
    const orderPath = `/app/orders?order=${orderId}#merchant-order-${orderId}`;
    authState.signIn.mockResolvedValueOnce(`https://merchant.example.test${orderPath}`);

    const state = await merchantLogin(undefined, formData({
      email: "merchant@example.test",
      password: "merchant-password-123",
      order: orderId.toUpperCase(),
    }));

    expect(authState.signIn).toHaveBeenCalledWith("credentials", {
      email: "merchant@example.test",
      password: "merchant-password-123",
      redirectTo: orderPath,
      redirect: false,
    });
    expect(state).toEqual({ orderPath });
  });

  it("rejects malformed input without calling Auth.js", async () => {
    const state = await merchantLogin(undefined, formData({
      email: "not-an-email",
      password: "",
    }));

    expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(authState.signIn).not.toHaveBeenCalled();
  });

  it("collapses Auth.js credential failures into one generic code", async () => {
    const { AuthError } = await import("next-auth");
    authState.signIn.mockRejectedValueOnce(new AuthError("CredentialsSignin"));

    const state = await merchantLogin(undefined, formData({
      email: "merchant@example.test",
      password: "wrong-password-123",
    }));

    expect(state).toEqual({ error: "INVALID_CREDENTIALS" });
  });
});
