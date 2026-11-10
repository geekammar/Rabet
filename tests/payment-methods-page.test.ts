import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  connection: vi.fn().mockResolvedValue(undefined),
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockIsConfigured = vi.fn();
const mockReadSettings = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();
const mockListPaymentMethods = vi.fn();
const mockCheckPaymentMethodsCapability = vi.fn();
const mockGetDb = vi.fn(() => ({}));

vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return {
    ...actual,
    isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
    listLanguages: (...args: unknown[]) => mockListLanguages(...args),
    resolveDefaultLanguage: (...args: unknown[]) => mockResolveDefaultLanguage(...args),
    listPaymentMethods: (...args: unknown[]) => mockListPaymentMethods(...args),
    checkPaymentMethodsCapability: (...args: unknown[]) =>
      mockCheckPaymentMethodsCapability(...args),
  };
});

const PaymentMethodsPage = (await import("@/app/(dashboard)/payment-methods/page")).default;
const {
  createPaymentMethodAction,
  updatePaymentMethodAction,
  togglePaymentMethodActiveAction,
  loadPaymentMethodsAction,
} = await import("@/app/actions/payment-methods");

describe("Payment Methods Page — Authorization & Availability States", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
    mockCheckPaymentMethodsCapability.mockResolvedValue({ supported: true });
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv;
  });

  it("asserts requireAdmin before performing any checks", async () => {
    process.env.DATABASE_URL = "";
    mockRequireAdmin.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));

    await expect(PaymentMethodsPage()).rejects.toThrow("UNAUTHENTICATED");
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
    expect(mockIsConfigured).not.toHaveBeenCalled();
  });

  it("renders DatabaseSetupRequired when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;

    const el = await PaymentMethodsPage();
    expect(el).toBeDefined();
    expect(el.type.name).toBe("DatabaseSetupRequired");
    expect(mockIsConfigured).not.toHaveBeenCalled();
  });

  it("renders DatabaseUnavailable when database query throws", async () => {
    process.env.DATABASE_URL = "postgres://fake:5432/db";
    mockIsConfigured.mockRejectedValueOnce(new Error("Connection refused"));

    const el = await PaymentMethodsPage();
    expect(el).toBeDefined();
    expect(el.type.name).toBe("DatabaseUnavailable");
    expect(el.props.message).toBeDefined();
  });

  it("renders StoreSetupRequired when store is not configured", async () => {
    process.env.DATABASE_URL = "postgres://fake:5432/db";
    mockIsConfigured.mockResolvedValueOnce(false);

    const el = await PaymentMethodsPage();
    expect(el).toBeDefined();
    expect(el.type.name).toBe("CatalogStoreSetupRequired");
  });

  it("renders PaymentMethodsManager when store and database are ready", async () => {
    process.env.DATABASE_URL = "postgres://fake:5432/db";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      displayName: "Acme Digital",
      currency: "USD",
      supportCategory: ["Help"],
    });
    mockListLanguages.mockResolvedValueOnce([
      { id: "lang-en", code: "en", label: "English", textDirection: "ltr", isEnabled: true },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en",
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });
    mockListPaymentMethods.mockResolvedValueOnce([
      {
        id: "pm-1",
        adminLabel: "Bank Transfer",
        isActive: false,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        translations: {},
      },
    ]);

    const el = await PaymentMethodsPage();
    expect(el).toBeDefined();
    expect(el.type.name).toBe("PaymentMethodsManager");
    expect(el.props.initialMethods).toHaveLength(1);
    expect(el.props.initialMethods[0].adminLabel).toBe("Bank Transfer");
  });

  it("renders PaymentMethodsUpgradeRequired when capability is unsupported on old schema", async () => {
    process.env.DATABASE_URL = "postgres://fake:5432/db";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      displayName: "Acme Digital",
      currency: "USD",
      supportCategory: ["Help"],
    });
    mockListLanguages.mockResolvedValueOnce([
      { id: "lang-en", code: "en", label: "English", textDirection: "ltr", isEnabled: true },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en",
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });
    mockCheckPaymentMethodsCapability.mockResolvedValueOnce({
      supported: false,
      reason: "Payment methods schema migration 0002_payment_methods is pending.",
    });

    const el = await PaymentMethodsPage();
    expect(el).toBeDefined();
    expect(el.type.name).toBe("PaymentMethodsUpgradeRequired");
    expect(el.props.message).toContain("0002_payment_methods");
  });
});

describe("Payment Methods Server Actions — Boundary Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated calls on createPaymentMethodAction", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));

    await expect(
      createPaymentMethodAction({
        adminLabel: "Test Method",
        title: "Test Title",
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rejects unauthenticated calls on updatePaymentMethodAction", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));

    await expect(
      updatePaymentMethodAction({
        methodId: "00000000-0000-0000-0000-000000000001",
        adminLabel: "Test Method",
        title: "Test Title",
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rejects unauthenticated calls on togglePaymentMethodActiveAction", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));

    await expect(
      togglePaymentMethodActiveAction({
        methodId: "00000000-0000-0000-0000-000000000001",
        isActive: true,
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rejects unauthenticated calls on loadPaymentMethodsAction", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));

    await expect(loadPaymentMethodsAction()).rejects.toThrow("UNAUTHENTICATED");
  });
});
