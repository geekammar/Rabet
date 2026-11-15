import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDb = vi.fn(() => ({}));
vi.mock("@/db/client", () => ({
  getDb: () => mockGetDb(),
}));

const mockIsConfigured = vi.fn();
const mockReadSettings = vi.fn();
const mockListLanguages = vi.fn();
const mockResolveDefaultLanguage = vi.fn();
const mockListCatalogCategories = vi.fn();
const mockListCatalogProducts = vi.fn();

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

const { loadCatalogAdminViewData } = await import("@/lib/catalog/load-admin-data");

describe("simple catalog admin loader", () => {
  const originalEnv = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv;
  });

  it("returns database_setup_required without touching the database when DATABASE_URL is absent", async () => {
    delete process.env.DATABASE_URL;

    await expect(loadCatalogAdminViewData()).resolves.toEqual({
      kind: "database_setup_required",
    });
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("returns store_setup_required when settings are not configured", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(false);

    await expect(loadCatalogAdminViewData()).resolves.toEqual({
      kind: "store_setup_required",
    });
  });

  it("loads settings, languages and catalog records without writing", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/rabet";
    mockIsConfigured.mockResolvedValueOnce(true);
    mockReadSettings.mockResolvedValueOnce({
      displayName: "Simple Store",
      currency: "USD",
    });
    mockListLanguages.mockResolvedValueOnce([
      { id: "lang-en", code: "en", label: "English", isEnabled: true },
    ]);
    mockResolveDefaultLanguage.mockResolvedValueOnce({
      id: "lang-en",
      code: "en",
      label: "English",
      textDirection: "ltr",
    });
    mockListCatalogCategories.mockResolvedValueOnce([{ id: "cat-1" }]);
    mockListCatalogProducts.mockResolvedValueOnce([{ id: "prod-1" }]);

    const result = await loadCatalogAdminViewData();
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.data.settings).toEqual({
        displayName: "Simple Store",
        currency: "USD",
      });
      expect(result.data.categories).toEqual([{ id: "cat-1" }]);
      expect(result.data.products).toEqual([{ id: "prod-1" }]);
    }
  });

  it("returns a safe database_unavailable message on failure", async () => {
    process.env.DATABASE_URL = "postgresql://user:secret@localhost:5432/rabet";
    mockIsConfigured.mockRejectedValueOnce(
      new Error("connect failed for postgresql://user:secret@localhost:5432/rabet"),
    );

    const result = await loadCatalogAdminViewData();
    expect(result.kind).toBe("database_unavailable");
    if (result.kind === "database_unavailable") {
      expect(result.message).not.toContain("secret");
      expect(result.message).not.toContain("postgresql://");
    }
  });
});
