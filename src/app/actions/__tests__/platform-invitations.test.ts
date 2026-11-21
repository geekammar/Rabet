import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/platform-session", () => ({
  requirePlatformAdmin: () => gate.requirePlatformAdmin(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/db/transaction-client", () => ({
  getTransactionDb: () => ({ mocked: true }),
}));

const service = vi.hoisted(() => ({
  issueMerchantInvitation: vi.fn(),
  revokeMerchantInvitation: vi.fn(),
}));

vi.mock("@/lib/merchant-invitation/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/merchant-invitation/service")>();
  return {
    ...actual,
    issueMerchantInvitation: service.issueMerchantInvitation,
    revokeMerchantInvitation: service.revokeMerchantInvitation,
  };
});

const { issuePlatformInvitation, revokePlatformInvitation } = await import(
  "@/app/actions/platform-invitations"
);
const { MerchantInvitationError } = await import(
  "@/lib/merchant-invitation/service"
);

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

const ADMIN = {
  id: "8a8a9b0d-2b64-4d59-9e3b-30b4e0a0ef43",
  email: "platform.admin@example.test",
  role: "platform_admin" as const,
  sessionVersion: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.requirePlatformAdmin.mockResolvedValue(ADMIN);
});

describe("platform invitation actions — authorization", () => {
  it("checks the platform gate before issue and performs no service call when denied", async () => {
    gate.requirePlatformAdmin.mockRejectedValueOnce(
      new Error("Platform Super Admin access required"),
    );

    await expect(
      issuePlatformInvitation(
        undefined,
        formData({
          invitedEmail: "owner@example.test",
          storeName: "Denied Store",
          storeSlug: "denied-store",
        }),
      ),
    ).rejects.toThrow("Platform Super Admin access required");

    expect(service.issueMerchantInvitation).not.toHaveBeenCalled();
  });

  it("checks the platform gate before revoke and performs no service call when denied", async () => {
    gate.requirePlatformAdmin.mockRejectedValueOnce(
      new Error("Platform Super Admin access required"),
    );

    await expect(
      revokePlatformInvitation(
        undefined,
        formData({ invitationId: "b7f3b6b4-3f37-4a26-99d2-26a97c6d8204" }),
      ),
    ).rejects.toThrow("Platform Super Admin access required");

    expect(service.revokeMerchantInvitation).not.toHaveBeenCalled();
  });
});

describe("issuePlatformInvitation", () => {
  it("uses the verified actor and returns a fragment-only invitation path", async () => {
    service.issueMerchantInvitation.mockResolvedValueOnce({
      invitationId: "cde03fc9-dedc-4b2f-85fa-de85e0ac9379",
      storeId: "1aca1080-44a5-474b-b104-dc5144e2f704",
      storeName: "Issued Store",
      storeSlug: "issued-store",
      invitedEmail: "owner@example.test",
      expiresAt: new Date("2026-11-28T20:20:12.422Z"),
      token: "token_with+/=chars",
    });

    const state = await issuePlatformInvitation(
      undefined,
      formData({
        invitedEmail: "owner@example.test",
        storeName: "Issued Store",
        storeSlug: "issued-store",
      }),
    );

    expect(service.issueMerchantInvitation).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({
        actorUserId: ADMIN.id,
        invitedEmail: "owner@example.test",
        storeName: "Issued Store",
        storeSlug: "issued-store",
      }),
    );
    expect(state.status).toBe("success");
    expect(state.issued).toMatchObject({
      invitedEmail: "owner@example.test",
      storeName: "Issued Store",
      storeSlug: "issued-store",
      expiresAt: "2026-11-28T20:20:12.422Z",
    });
    expect(state.issued?.invitePath).toBe(
      "/invite#token=token_with%2B%2F%3Dchars",
    );
  });

  it("omits an empty optional store slug", async () => {
    service.issueMerchantInvitation.mockResolvedValueOnce({
      invitationId: "cde03fc9-dedc-4b2f-85fa-de85e0ac9379",
      storeId: "1aca1080-44a5-474b-b104-dc5144e2f704",
      storeName: "Derived Store",
      storeSlug: "derived-store",
      invitedEmail: "owner@example.test",
      expiresAt: new Date("2026-11-28T20:20:12.422Z"),
      token: "token",
    });

    await issuePlatformInvitation(
      undefined,
      formData({
        invitedEmail: "owner@example.test",
        storeName: "Derived Store",
        storeSlug: "   ",
      }),
    );

    expect(service.issueMerchantInvitation).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ storeSlug: undefined }),
    );
  });

  it("maps conflicts and invalid input without exposing the token", async () => {
    service.issueMerchantInvitation.mockRejectedValueOnce(
      new MerchantInvitationError("CONFLICT", "duplicate"),
    );

    const conflict = await issuePlatformInvitation(
      undefined,
      formData({
        invitedEmail: "owner@example.test",
        storeName: "Store",
        storeSlug: "taken-store",
      }),
    );

    expect(conflict.status).toBe("error");
    expect(conflict.message).toMatch(/already in use/i);
    expect(JSON.stringify(conflict)).not.toMatch(/token/i);

    service.issueMerchantInvitation.mockRejectedValueOnce(
      new MerchantInvitationError("INVALID_INPUT", "bad input"),
    );

    const invalid = await issuePlatformInvitation(
      undefined,
      formData({
        invitedEmail: "not-an-email",
        storeName: "",
        storeSlug: "",
      }),
    );

    expect(invalid.status).toBe("error");
    expect(invalid.message).toMatch(/Check the recipient email/i);
  });
});

describe("revokePlatformInvitation", () => {
  it("uses the verified actor and reports success", async () => {
    service.revokeMerchantInvitation.mockResolvedValueOnce({
      invitationId: "b7f3b6b4-3f37-4a26-99d2-26a97c6d8204",
      storeId: "d7a0b50f-aa3a-4ee7-9e2e-e903b6e09cff",
      revokedByUserId: ADMIN.id,
    });

    const state = await revokePlatformInvitation(
      undefined,
      formData({ invitationId: "b7f3b6b4-3f37-4a26-99d2-26a97c6d8204" }),
    );

    expect(service.revokeMerchantInvitation).toHaveBeenCalledWith(
      { mocked: true },
      {
        actorUserId: ADMIN.id,
        invitationId: "b7f3b6b4-3f37-4a26-99d2-26a97c6d8204",
      },
    );
    expect(state).toEqual({ status: "success", message: "Invitation revoked." });
  });

  it("collapses missing, expired, redeemed and revoked invitations into the service message", async () => {
    service.revokeMerchantInvitation.mockRejectedValueOnce(
      new MerchantInvitationError(
        "INVITATION_REJECTED",
        "This invitation is not valid or can no longer be used.",
      ),
    );

    const state = await revokePlatformInvitation(
      undefined,
      formData({ invitationId: "b7f3b6b4-3f37-4a26-99d2-26a97c6d8204" }),
    );

    expect(state.status).toBe("error");
    expect(state.message).toBe(
      "This invitation is not valid or can no longer be used.",
    );
  });
});
