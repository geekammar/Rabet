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
const mockListCatalogCategories = vi.fn();
const mockListCatalogProducts = vi.fn();
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
    listCatalogCategories: (...args: unknown[]) => mockListCatalogCategories(...args),
    listCatalogProducts: (...args: unknown[]) => mockListCatalogProducts(...args),
  };
});

const CatalogPage = (await import("@/app/(dashboard)/catalog/page")).default;

describe("Catalog Page — Database Availability States & Zero Writes", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ email: "admin@rabet.test", role: "admin" });
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv;
  });

  it("renders State A (DatabaseSetupRequired) when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;

    const element = await CatalogPage();
    expect(element.type.name).toBe("DatabaseSetupRequired");
    expect(element.props.title).toBe("Catalog");
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("renders State B (DatabaseUnavailable) when database connection fails, redacting credentials", async () => {
    process.env.DATABASE_URL = "postgresql://user:secretpass@localhost:5432/rabet";
    mockIsConfigured.mockRejectedValueOnce(
      new Error("connection timeout to postgresql://user:secretpass@localhost:5432/rabet"),
    );

    const element = await CatalogPage();
    expect(element.type.name).toBe("DatabaseUnavailable");
    expect(element.props.title).toBe("Catalog");
    expect(element.props.message).not.toContain("secretpass");
    expect(element.props.message).not.toContain("postgresql://");
  });

  it("renders State C (CatalogStoreSetupRequired) when store settings are unconfigured", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(false);

    const element = await CatalogPage();
    expect(element.type.name).toBe("CatalogStoreSetupRequired");
  });

  it("renders State D (CatalogEditor) when store is configured, performing zero writes", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      displayName: "My Store",
      currency: "USD",
      defaultLanguageId: "lang-en-id",
    });
    mockListLanguages.mockResolvedValueOnce([
      { id: "lang-en-id", code: "en", label: "English", isEnabled: true },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en-id",
      code: "en",
      label: "English",
      isEnabled: true,
    });
    mockListCatalogCategories.mockResolvedValueOnce([]);
    mockListCatalogProducts.mockResolvedValueOnce([]);

    const element = await CatalogPage();
    expect(element.type.name).toBe("CatalogEditor");
    expect(element.props.settings.displayName).toBe("My Store");
    expect(element.props.settings.currency).toBe("USD");
    expect(element.props.categories).toEqual([]);
    expect(element.props.products).toEqual([]);
  });
});
