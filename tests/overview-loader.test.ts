import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockIsConfigured = vi.fn();
const mockReadSettings = vi.fn();
const mockListCatalogCategories = vi.fn();
const mockListCatalogProducts = vi.fn();
const mockListPaymentMethods = vi.fn();
const mockCheckPaymentMethodsCapability = vi.fn();
const mockListSellerInquiries = vi.fn();

vi.mock("@/lib/data", () => ({
  isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
  listCatalogCategories: (...args: unknown[]) => mockListCatalogCategories(...args),
  listCatalogProducts: (...args: unknown[]) => mockListCatalogProducts(...args),
  listPaymentMethods: (...args: unknown[]) => mockListPaymentMethods(...args),
  checkPaymentMethodsCapability: (...args: unknown[]) =>
    mockCheckPaymentMethodsCapability(...args),
  toSafeErrorMessage: () =>
    "The database is not reachable right now. Try again in a moment.",
}));

vi.mock("@/lib/data/seller-inbox", () => ({
  listSellerInquiries: (...args: unknown[]) => mockListSellerInquiries(...args),
}));

const { loadOverviewData } = await import("@/lib/dashboard/overview");

describe("Overview data loader", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv;
  });

  it("reports database setup required without touching the database", async () => {
    delete process.env.DATABASE_URL;

    await expect(loadOverviewData()).resolves.toEqual({
      kind: "database_setup_required",
    });
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("reports store setup required when settings are not initialized", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(false);

    await expect(loadOverviewData()).resolves.toEqual({
      kind: "store_setup_required",
    });
  });

  it("returns real counts from the existing read helpers", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      displayName: "Rabet Demo Store",
      currency: "USD",
    });
    mockListCatalogCategories.mockResolvedValueOnce([
      { id: "cat-1" },
      { id: "cat-2" },
    ]);
    mockListCatalogProducts.mockResolvedValueOnce([
      { id: "prod-1" },
      { id: "prod-2" },
      { id: "prod-3" },
    ]);
    mockListPaymentMethods.mockResolvedValueOnce([
      { id: "pm-1" },
      { id: "pm-2" },
    ]);
    mockCheckPaymentMethodsCapability.mockResolvedValueOnce({ supported: true });
    mockListSellerInquiries.mockResolvedValueOnce({
      items: [],
      totalCount: 4,
      page: 1,
      pageSize: 1,
      totalPages: 4,
    });

    await expect(loadOverviewData()).resolves.toEqual({
      kind: "ready",
      storeName: "Rabet Demo Store",
      counts: {
        products: 3,
        categories: 2,
        activeInquiries: 4,
        paymentMethods: 2,
        paymentMethodsAvailable: true,
      },
    });

    expect(mockListSellerInquiries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "active", page: 1, pageSize: 1 }),
    );
    expect(mockListCatalogProducts).toHaveBeenCalledTimes(1);
    expect(mockListCatalogCategories).toHaveBeenCalledTimes(1);
  });

  it("marks payment methods unavailable when the capability is unsupported", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({ displayName: "Store" });
    mockListCatalogCategories.mockResolvedValueOnce([]);
    mockListCatalogProducts.mockResolvedValueOnce([]);
    mockListPaymentMethods.mockResolvedValueOnce([]);
    mockCheckPaymentMethodsCapability.mockResolvedValueOnce({ supported: false });
    mockListSellerInquiries.mockResolvedValueOnce({
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 1,
      totalPages: 1,
    });

    const result = await loadOverviewData();

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.counts.paymentMethodsAvailable).toBe(false);
    }
  });

  it("returns a safe message when the database is unavailable", async () => {
    process.env.DATABASE_URL = "postgresql://user:secret@localhost:5432/rabet";
    mockIsConfigured.mockRejectedValueOnce(
      new Error("connect failed for postgresql://user:secret@localhost:5432/rabet"),
    );

    await expect(loadOverviewData()).resolves.toEqual({
      kind: "database_unavailable",
      message: "The database is not reachable right now. Try again in a moment.",
    });
  });
});
