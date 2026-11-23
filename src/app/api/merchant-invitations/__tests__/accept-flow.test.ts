import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flow = vi.hoisted(() => ({
  preview: vi.fn(),
  accept: vi.fn(),
  consume: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@/auth-merchant", () => ({ signIn: flow.signIn }));

vi.mock("@/db/transaction-client", () => ({
  getTransactionDb: () => ({ execute: vi.fn() }),
}));

vi.mock("@/lib/auth/merchant-throttle", () => ({
  consumeMerchantThrottle: flow.consume,
  merchantThrottleKey: (value: string) =>
    value.padEnd(64, "0").slice(0, 64),
  merchantInvitationGlobalKey: () => "f".repeat(64),
}));

vi.mock("@/lib/merchant-invitation/service", () => ({
  previewMerchantInvitation: flow.preview,
  acceptMerchantInvitation: flow.accept,
  MerchantInvitationError: class MerchantInvitationError extends Error {
    code = "INVITATION_REJECTED";
  },
}));

const { POST } = await import("@/app/api/merchant-invitations/accept/route");
const { MerchantInvitationError } = await import(
  "@/lib/merchant-invitation/service"
);

const TOKEN = "a".repeat(43);
const PASSWORD = "accept-flow-password-123";

function request(overrides: Record<string, string> = {}) {
  return new Request("https://app.example.test/api/merchant-invitations/accept", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.example.test",
      Host: "app.example.test",
    },
    body: JSON.stringify({
      token: TOKEN,
      password: PASSWORD,
      passwordConfirmation: PASSWORD,
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
  vi.stubEnv("APP_URL", "https://app.example.test");
  flow.preview.mockReset();
  flow.accept.mockReset();
  flow.signIn.mockReset().mockResolvedValue("https://app.example.test/app/setup");
  flow.consume.mockReset().mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invitation acceptance route", () => {
  it("accepts a named store and signs in with the invited identity", async () => {
    flow.preview.mockResolvedValueOnce({ invitedEmail: "merchant@example.test" });
    flow.accept.mockResolvedValueOnce({ email: "merchant@example.test" });

    const response = await POST(request({ storeName: "My shop", email: "other@example.test" }));

    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: "/app/setup" });
    expect(flow.accept).toHaveBeenCalledWith(expect.anything(), {
      token: TOKEN,
      password: PASSWORD,
      storeName: "My shop",
    });
    expect(flow.signIn).toHaveBeenCalledWith("credentials", {
      email: "merchant@example.test",
      password: PASSWORD,
      redirect: false,
      redirectTo: "/app/setup",
    });
  });

  it("offers ordinary sign-in when session creation fails after acceptance", async () => {
    flow.preview.mockResolvedValueOnce({ invitedEmail: "merchant@example.test" });
    flow.accept.mockResolvedValueOnce({ email: "merchant@example.test" });
    flow.signIn.mockRejectedValueOnce(new Error("sign-in unavailable"));

    const response = await POST(request());

    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: "/app/login" });
  });

  it("rejects an unrecognized token after only the coarse budget", async () => {
    flow.preview.mockResolvedValueOnce(null);

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVITATION_REJECTED",
    });
    expect(flow.consume).toHaveBeenCalledTimes(1);
    expect(flow.consume.mock.calls[0][1]).toMatchObject({
      scope: "invitation_global",
    });
    expect(flow.preview).toHaveBeenCalled();
    expect(flow.accept).not.toHaveBeenCalled();
  });

  it("accepts a recognized token exactly once after coarse and per-token budgets", async () => {
    flow.preview.mockResolvedValueOnce({
      invitedEmail: "merchant@example.test",
      storeName: "Store",
    });
    flow.accept.mockResolvedValueOnce({ userId: "user", storeId: "store" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      redirectTo: "/app/login",
    });
    expect(flow.consume).toHaveBeenCalledTimes(2);
    expect(flow.consume.mock.calls[0][1]).toMatchObject({
      scope: "invitation_global",
    });
    expect(flow.consume.mock.calls[1][1]).toMatchObject({
      scope: "invitation_accept",
    });
    expect(flow.accept).toHaveBeenCalledTimes(1);
    expect(flow.accept).toHaveBeenCalledWith(expect.anything(), {
      token: TOKEN,
      password: PASSWORD,
    });
  });

  it("returns the same generic rejection when the service loses the race", async () => {
    flow.preview.mockResolvedValueOnce({
      invitedEmail: "merchant@example.test",
      storeName: "Store",
    });
    flow.accept.mockRejectedValueOnce(
      new MerchantInvitationError("INVITATION_REJECTED", "rejected"),
    );

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVITATION_REJECTED",
    });
  });

  it("validates password fields without consuming any invitation budget", async () => {
    const response = await POST(
      request({ passwordConfirmation: `${PASSWORD}-different` }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "FIELD_ERROR",
      fieldErrors: { passwordConfirmation: "PASSWORD_MISMATCH" },
    });
    expect(flow.consume).not.toHaveBeenCalled();
    expect(flow.preview).not.toHaveBeenCalled();
    expect(flow.accept).not.toHaveBeenCalled();
  });

  it("denies with a 429 before preview or hashing when the coarse budget is spent", async () => {
    flow.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 120,
    });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(flow.consume).toHaveBeenCalledTimes(1);
    expect(flow.preview).not.toHaveBeenCalled();
    expect(flow.accept).not.toHaveBeenCalled();
  });

  it("denies a recognized token when its per-token budget is spent", async () => {
    flow.preview.mockResolvedValueOnce({
      invitedEmail: "merchant@example.test",
      storeName: "Store",
    });
    flow.consume
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(flow.consume).toHaveBeenCalledTimes(2);
    expect(flow.accept).not.toHaveBeenCalled();
  });
});
