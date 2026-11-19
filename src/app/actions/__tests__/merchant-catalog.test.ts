import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ kind: "application-db" })),
  getMerchantAccess: vi.fn(),
  updateMerchantCatalogProductPrice: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  getDb: state.getDb,
}));

vi.mock("@/lib/auth/merchant-session", () => ({
  getMerchantAccess: state.getMerchantAccess,
}));

vi.mock("@/lib/merchant/catalog", () => ({
  updateMerchantCatalogProductPrice: state.updateMerchantCatalogProductPrice,
}));

vi.mock("next/cache", () => ({
  refresh: state.refresh,
}));

const { saveMerchantProductPrice } = await import(
  "@/app/actions/merchant-catalog"
);

const REVISION = "2026-11-19T22:42:44.123456Z";

const access = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "merchant@example.test",
  sessionVersion: 0,
  role: "owner" as const,
  store: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Store A",
    slug: "store-a",
    status: "onboarding" as const,
  },
  scope: { storeId: "22222222-2222-4222-8222-222222222222" },
  readOnly: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("merchant catalog price action — enablement gate", () => {
  it("does not resolve access or touch the database while the app is disabled", async () => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "false");

    const result = await saveMerchantProductPrice({
      productId: "33333333-3333-4333-8333-333333333333",
      price: "10.00",
    });

    expect(result).toEqual({ ok: false, error: "UNAVAILABLE" });
    expect(state.getMerchantAccess).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
    expect(state.updateMerchantCatalogProductPrice).not.toHaveBeenCalled();
  });
});

describe("merchant catalog price action", () => {
  beforeEach(() => {
    vi.stubEnv("RABET_MERCHANT_APP_ENABLED", "true");
  });

  it("denies a session whose access was revoked before the mutation", async () => {
    state.getMerchantAccess.mockResolvedValueOnce(null);

    const result = await saveMerchantProductPrice({
      productId: "33333333-3333-4333-8333-333333333333",
      price: "10.00",
    });

    expect(result).toEqual({ ok: false, error: "DENIED" });
    expect(state.getDb).not.toHaveBeenCalled();
    expect(state.updateMerchantCatalogProductPrice).not.toHaveBeenCalled();
  });

  it("reads only productId, price and revision, ignoring submitted ownership fields, and refreshes on success", async () => {
    state.getMerchantAccess.mockResolvedValueOnce(access);
    state.updateMerchantCatalogProductPrice.mockResolvedValueOnce({
      ok: true,
      productId: "33333333-3333-4333-8333-333333333333",
      price: "10.00",
      revision: REVISION,
    });

    const result = await saveMerchantProductPrice({
      productId: "33333333-3333-4333-8333-333333333333",
      price: "10.00",
      revision: REVISION,
      storeId: "44444444-4444-4444-8444-444444444444",
      role: "super_admin",
      readOnly: false,
    });

    expect(result).toEqual({
      ok: true,
      productId: "33333333-3333-4333-8333-333333333333",
      price: "10.00",
      revision: REVISION,
    });
    expect(state.updateMerchantCatalogProductPrice).toHaveBeenCalledWith(
      { kind: "application-db" },
      access,
      {
        productId: "33333333-3333-4333-8333-333333333333",
        price: "10.00",
        revision: REVISION,
      },
    );
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("returns a safe failure without refreshing when the product is not owned", async () => {
    state.getMerchantAccess.mockResolvedValueOnce(access);
    state.updateMerchantCatalogProductPrice.mockResolvedValueOnce({
      ok: false,
      error: "NOT_FOUND",
    });

    const result = await saveMerchantProductPrice({
      productId: "55555555-5555-4555-8555-555555555555",
      price: "10.00",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
